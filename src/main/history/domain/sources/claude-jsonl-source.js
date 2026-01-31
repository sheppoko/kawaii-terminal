const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const JsonlSource = require('./jsonl-source');
const { listJsonlFiles, readJsonlFile, readJsonlTail } = require('../../infra/jsonl-reader');
const { createClaudeBlockBuilder, parseClaudeTimestampMs } = require('../builders/claude-blocks');
const { SessionIndexBuilder, selectLatestBlockWithInput, blockHasInput } = require('../builders/session-index-builder');
const { buildFallbackId, buildSourceBlockId, stripSourcePrefix } = require('../../utils/block-utils');
const { attachWslMetadata, isWslUncPath, toPosixPathMaybeWsl } = require('../../infra/wsl-utils');
const {
  extractClaudeAssistantText,
  extractClaudeCwd,
  extractClaudeUserPromptText,
  isClaudeMainConversationEntry,
  isClaudeUserPromptEntry,
  resolveClaudeMessage,
  resolveClaudeRole,
} = require('../../utils/claude-utils');
const { extractTextFromContent } = require('../../utils/text-utils');
const { computeKeywordMatchScore } = require('../../utils/keyword-search');
const { resolveHomePath, pathExists, isPathInRoots } = require('../../infra/path-utils');
const { ensureWslHomesLoaded } = require('../../infra/wsl-homes');
const { buildTimeMachineSessionId } = require('../../utils/codex-utils');
const { buildClaudeTimeMachineFile } = require('../builders/time-machine');
const { resolveClaudeConfigRoot } = require('../../../infra/path/agent-paths');
const {
  listLocalClaudeRoots,
  listWslClaudeRoots: listWslClaudeRootsAsync,
  listWslClaudeRootsSync,
} = require('../../../infra/agents/agent-roots');
const {
  CLAUDE_LOG_TAIL_BYTES,
  CLAUDE_SESSION_SUMMARY_TAIL_BYTES,
  CLAUDE_SESSION_TAIL_BYTES_BASE,
  CLAUDE_SESSION_TAIL_BYTES_MAX,
  SUMMARY_READ_CONCURRENCY,
} = require('../history-constants');

const getLocalClaudeRoots = () => listLocalClaudeRoots({ includeAppData: true });

const EXCLUDED_PROJECT_PATTERNS = (() => {
  const patterns = [];
  const tempDir = os.tmpdir();
  if (tempDir) {
    const normalized = tempDir.replace(/\\/g, '/');
    const encoded = normalized.replace(/:/g, '-').replace(/\//g, '-').replace(/\./g, '-');
    if (encoded) patterns.push(encoded);
  }
  if (process.platform === 'win32') {
    patterns.push('AppData-Local-Temp');
    patterns.push('LOCALAP~1-Temp');
  }
  if (process.platform === 'darwin' || process.platform === 'linux') {
    patterns.push('-tmp');
    patterns.push('-var-folders-');
    patterns.push('-private-var-folders-');
  }
  return patterns;
})();

function isExcludedProjectDir(dirName) {
  if (!dirName) return false;
  const name = String(dirName);
  for (const pattern of EXCLUDED_PROJECT_PATTERNS) {
    if (name.includes(pattern)) return true;
  }
  return false;
}

function extractClaudeModelFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const msg = resolveClaudeMessage(entry);
  const candidates = [
    msg?.model,
    msg?.model_name,
    msg?.modelName,
    entry.model,
    entry.model_name,
    entry.modelName,
    entry?.payload?.model,
    entry?.payload?.model_name,
    entry?.payload?.modelName,
    entry?.data?.model,
    entry?.data?.model_name,
    entry?.data?.modelName,
  ];
  for (const candidate of candidates) {
    const raw = String(candidate || '').trim();
    if (raw) return raw;
  }
  return '';
}

const { buildClaudeBlockFromTurn, extractClaudeBlocksFromEntries } = createClaudeBlockBuilder({
  buildFallbackId,
  buildSourceBlockId,
  attachWslMetadata,
  extractModelFromEntry: extractClaudeModelFromEntry,
});

function normalizeClaudeProjectPath(projectPath) {
  const resolved = resolveHomePath(projectPath);
  if (!resolved) return null;
  const posixPath = toPosixPathMaybeWsl(resolved);
  if (posixPath) {
    return { absolute: path.posix.resolve(posixPath), isPosix: true };
  }
  let absolute;
  try {
    absolute = path.resolve(resolved);
  } catch (_) {
    absolute = resolved;
  }
  return { absolute, isPosix: false };
}

function encodeClaudeProjectDirNameFromAbsolute(absolute, isPosix) {
  if (!absolute) return null;
  const normalized = isPosix ? String(absolute) : String(absolute).replace(/\\/g, '/');
  return normalized.replace(/:/g, '-').replace(/\//g, '-').replace(/\./g, '-');
}

function buildClaudeProjectRoots(baseRoots) {
  const roots = [];
  const add = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return;
    if (roots.includes(raw)) return;
    roots.push(raw);
  };
  for (const root of baseRoots) {
    add(root);
    if (path.basename(root) !== 'projects') {
      add(path.join(root, 'projects'));
    }
  }
  return roots;
}

async function findFirstClaudeCwdInFile(filePath) {
  const target = typeof filePath === 'string' ? filePath.trim() : '';
  if (!target) return '';
  return new Promise((resolve) => {
    let resolved = false;
    let stream = null;
    let rl = null;
    const finish = (value = '') => {
      if (resolved) return;
      resolved = true;
      try { rl?.close?.(); } catch (_) { /* noop */ }
      try { stream?.destroy?.(); } catch (_) { /* noop */ }
      resolve(String(value || ''));
    };
    try {
      stream = fs.createReadStream(target, { encoding: 'utf8' });
    } catch (_) {
      finish('');
      return;
    }
    stream.on('error', () => finish(''));
    rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line || resolved) return;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (_) {
        return;
      }
      const cwd = extractClaudeCwd(entry);
      if (cwd) finish(cwd);
    });
    rl.on('close', () => finish(''));
  });
}

function getWslClaudeRootsSync() {
  return listWslClaudeRootsSync();
}

async function listWslClaudeRoots() {
  return listWslClaudeRootsAsync();
}

function getClaudeProjectRootsSync() {
  const wslRoots = getWslClaudeRootsSync();
  return buildClaudeProjectRoots([...getLocalClaudeRoots(), ...wslRoots]);
}

async function listClaudeProjectRoots() {
  const wslRoots = await listWslClaudeRoots();
  return buildClaudeProjectRoots([...getLocalClaudeRoots(), ...wslRoots]);
}

function resolveClaudeProjectDir(projectPath) {
  const normalized = normalizeClaudeProjectPath(projectPath);
  if (!normalized) return null;
  const { absolute, isPosix } = normalized;
  const dirname = isPosix ? path.posix.dirname : path.dirname;
  const buildCandidates = (root, dirName) => {
    const candidates = [];
    const add = (value) => {
      const raw = String(value || '').trim();
      if (!raw) return;
      if (candidates.includes(raw)) return;
      candidates.push(raw);
    };
    if (!root) return candidates;
    add(path.join(root, dirName));
    if (path.basename(root) !== 'projects') {
      add(path.join(root, 'projects', dirName));
    }
    return candidates;
  };

  const encodeFromAbsolute = (value) => encodeClaudeProjectDirNameFromAbsolute(value, isPosix);
  const allRoots = getClaudeProjectRootsSync();
  const scopedRoots = isPosix
    ? allRoots.filter(root => isWslUncPath(root))
    : allRoots.filter(root => !isWslUncPath(root));
  const roots = scopedRoots.length > 0 ? scopedRoots : allRoots;

  let current = absolute;
  for (let i = 0; i < 50; i += 1) {
    const dirName = encodeFromAbsolute(current);
    if (!dirName) break;
    for (const root of roots) {
      for (const candidate of buildCandidates(root, dirName)) {
        if (pathExists(candidate)) return candidate;
      }
    }
    const parent = dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }

  const dirName = encodeFromAbsolute(absolute);
  if (!dirName) return null;
  const baseRoots = roots.length > 0 ? roots : allRoots;
  const fallbackRoot = resolveClaudeConfigRoot({ home: os.homedir(), env: process.env });
  const base = baseRoots.find(root => path.basename(root) === 'projects')
    || baseRoots[0]
    || path.join(fallbackRoot, 'projects');
  const candidates = buildCandidates(base, dirName);
  return candidates[0] || path.join(fallbackRoot, 'projects', dirName);
}

async function listClaudeProjects() {
  const roots = await listClaudeProjectRoots();
  const projects = [];
  const seen = new Set();

  for (const root of roots) {
    if (!root || !pathExists(root)) continue;
    let entries;
    try {
      entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    const rootFiles = await listJsonlFiles(root);
    if (rootFiles.length > 0) {
      const key = root;
      if (!seen.has(key)) {
        seen.add(key);
        projects.push({
          dir: key,
          label: path.basename(key) || key,
          mtime: rootFiles[0]?.mtime || 0,
        });
      }
    }

    for (const entry of entries) {
      if (!entry?.isDirectory?.()) continue;
      if (isExcludedProjectDir(entry.name)) continue;
      const dirPath = path.join(root, entry.name);
      if (seen.has(dirPath)) continue;
      const files = await listJsonlFiles(dirPath);
      if (files.length === 0) continue;
      seen.add(dirPath);
      projects.push({
        dir: dirPath,
        label: entry.name,
        mtime: files[0]?.mtime || 0,
      });
    }
  }

  projects.sort((a, b) => (Number(b.mtime) - Number(a.mtime)) || String(a.label).localeCompare(String(b.label)));
  return { projects };
}

async function collectClaudeSessionFiles() {
  const roots = await listClaudeProjectRoots();
  const files = [];
  const visited = new Set();
  for (const root of roots) {
    if (!root || !pathExists(root)) continue;
    let entries;
    try {
      entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    const rootFiles = await listJsonlFiles(root);
    if (rootFiles.length > 0) {
      const label = path.basename(root) || root;
      for (const file of rootFiles) {
        files.push({ file, projectDir: root, label });
      }
      visited.add(root);
    }

    for (const entry of entries) {
      if (!entry?.isDirectory?.()) continue;
      if (isExcludedProjectDir(entry.name)) continue;
      const dirPath = path.join(root, entry.name);
      if (visited.has(dirPath)) continue;
      const projectFiles = await listJsonlFiles(dirPath);
      if (projectFiles.length === 0) continue;
      visited.add(dirPath);
      const label = entry.name || path.basename(dirPath) || dirPath;
      for (const file of projectFiles) {
        files.push({ file, projectDir: dirPath, label });
      }
    }
  }
  return files;
}

async function collectClaudeSessionIndex() {
  const entries = await collectClaudeSessionFiles();
  const bySession = new Map();

  for (const entry of entries) {
    const file = entry?.file;
    if (!file?.path) continue;
    const sessionId = path.basename(file.path, '.jsonl');
    if (!sessionId) continue;
    const existing = bySession.get(sessionId);
    if (!existing || (file.mtime || 0) > (existing.file?.mtime || 0)) {
      bySession.set(sessionId, {
        file,
        sessionId,
        projectDir: entry.projectDir,
        label: entry.label,
      });
    }
  }

  const sorted = Array.from(bySession.values());
  sorted.sort((a, b) => (b.file?.mtime || 0) - (a.file?.mtime || 0));
  return sorted;
}

async function readFastClaudeSummaryBlock(file, { projectKey, paneLabel } = {}) {
  if (!file?.path) return null;
  const fileSize = Number(file.size || 0);
  let tailBytes = Math.max(4096, CLAUDE_SESSION_SUMMARY_TAIL_BYTES);
  const cwd = await findFirstClaudeCwdInFile(file.path);
  for (;;) {
    const events = await readJsonlTail(file.path, tailBytes);
    if (!events || events.length === 0) return null;
    let blocks = extractClaudeBlocksFromEntries(events, {
      projectKey,
      paneLabel,
      cwd,
      sourcePath: file.path,
    });
    let block = selectLatestBlockWithInput(blocks);
    if (block) {
      if (!block.created_at && file?.mtime) block.created_at = file.mtime;
      if (!block.last_output_at && block.created_at) block.last_output_at = block.created_at;
      return block;
    }
    if ((fileSize && tailBytes >= fileSize) || tailBytes >= CLAUDE_SESSION_TAIL_BYTES_MAX) break;
    tailBytes = Math.min(CLAUDE_SESSION_TAIL_BYTES_MAX, tailBytes * 2);
  }
  return null;
}

async function buildClaudeSummaryBlock(entry) {
  if (!entry?.file) return null;
  let block = await readFastClaudeSummaryBlock(entry.file, {
    projectKey: entry.projectDir,
    paneLabel: entry.label,
  });
  if (!block || !blockHasInput(block)) return null;
  if (!block.session_id) {
    block.session_id = entry.sessionId;
    block.session_label = entry.sessionId ? entry.sessionId.slice(-6) : 'claude';
  }
  if (!block.pane_id) block.pane_id = entry.projectDir || '';
  if (!block.pane_label) block.pane_label = entry.label || 'Claude';
  if (!block.source_path && entry.file?.path) {
    attachWslMetadata(block, { sourcePath: entry.file.path, projectDir: entry.projectDir });
  }
  if (!block.created_at && entry.file?.mtime) block.created_at = entry.file.mtime;
  if (!block.last_output_at && block.created_at) block.last_output_at = block.created_at;
  return block;
}

async function scanClaudeSessionFile(fileInfo, { projectKey, paneLabel, sessionId } = {}) {
  if (!fileInfo?.path) return [];
  const blocks = [];
  const seen = new Set();
  let currentUserUuid = '';
  let currentSessionId = String(sessionId || '').trim();
  let currentUserText = '';
  let currentCreatedAt = 0;
  let currentLastOutputAt = 0;
  let assistantTexts = [];
  let currentCwd = '';

  const flush = () => {
    if (!currentUserUuid && !currentUserText) return;
    const block = buildClaudeBlockFromTurn({
      userUuid: currentUserUuid,
      sessionId: currentSessionId || sessionId,
      userText: currentUserText,
      outputText: assistantTexts.filter(Boolean).join('\n').trimEnd(),
      createdAt: currentCreatedAt,
      lastOutputAt: currentLastOutputAt || currentCreatedAt,
      projectKey,
      paneLabel,
      cwd: currentCwd,
      sourcePath: fileInfo.path,
      allowEmptyOutput: true,
    });
    if (!block) return;
    if (!block.created_at && fileInfo?.mtime) block.created_at = fileInfo.mtime;
    if (!block.last_output_at && block.created_at) block.last_output_at = block.created_at;
    const id = block.id ? String(block.id) : '';
    if (id && seen.has(id)) return;
    if (id) seen.add(id);
    blocks.push(block);
  };

  await readJsonlFile(fileInfo.path, (entry) => {
    const entryCwd = extractClaudeCwd(entry);
    if (!currentCwd && entryCwd) currentCwd = entryCwd;
    if (!isClaudeMainConversationEntry(entry)) return;
    if (isClaudeUserPromptEntry(entry)) {
      flush();
      currentUserUuid = String(entry.uuid || '').trim();
      const entrySessionId = String(entry.sessionId || '').trim();
      if (entrySessionId) currentSessionId = entrySessionId;
      if (!currentSessionId && sessionId) currentSessionId = String(sessionId);
      currentUserText = extractClaudeUserPromptText(entry);
      currentCreatedAt = parseClaudeTimestampMs(entry.timestamp);
      currentLastOutputAt = currentCreatedAt;
      assistantTexts = [];
      return;
    }
    if (entry.type === 'assistant' && (currentUserUuid || currentUserText)) {
      const text = extractClaudeAssistantText(entry);
      if (text) assistantTexts.push(text);
      const ts = parseClaudeTimestampMs(entry.timestamp);
      if (ts) currentLastOutputAt = ts;
    }
  });

  flush();
  return blocks;
}

async function scanClaudeFileForKeywordSearch(fileInfo, { terms, hits, seen, maxHits, projectKey, paneLabel } = {}) {
  if (!fileInfo?.path) return;
  let currentUserUuid = '';
  let currentSessionId = '';
  let currentUserText = '';
  let currentCreatedAt = 0;
  let currentLastOutputAt = 0;
  let assistantTexts = [];
  let currentCwd = '';

  const flush = () => {
    if (!currentUserUuid && !currentUserText) return;
    const block = buildClaudeBlockFromTurn({
      userUuid: currentUserUuid,
      sessionId: currentSessionId,
      userText: currentUserText,
      outputText: assistantTexts.filter(Boolean).join('\n').trimEnd(),
      createdAt: currentCreatedAt,
      lastOutputAt: currentLastOutputAt || currentCreatedAt,
      projectKey,
      paneLabel,
      cwd: currentCwd,
      sourcePath: fileInfo.path,
      allowEmptyOutput: true,
    });
    if (!block) return;
    if (!block.created_at && fileInfo?.mtime) block.created_at = fileInfo.mtime;
    if (!block.last_output_at && block.created_at) block.last_output_at = block.created_at;
    const match = computeKeywordMatchScore({ input: block.input, output: block.output_text, terms });
    if (!match.matched) return;
    const id = block.id ? String(block.id) : '';
    if (id && seen?.has(id)) return;
    if (id && seen) seen.add(id);
    hits.push({ score: match.score, why: match.why, block });
  };

  await readJsonlFile(fileInfo.path, (entry) => {
    if (maxHits && hits.length >= maxHits) return;
    const entryCwd = extractClaudeCwd(entry);
    if (!currentCwd && entryCwd) currentCwd = entryCwd;
    if (!isClaudeMainConversationEntry(entry)) return;
    if (isClaudeUserPromptEntry(entry)) {
      flush();
      currentUserUuid = String(entry.uuid || '').trim();
      currentSessionId = String(entry.sessionId || '').trim();
      currentUserText = extractClaudeUserPromptText(entry);
      currentCreatedAt = parseClaudeTimestampMs(entry.timestamp);
      currentLastOutputAt = currentCreatedAt;
      assistantTexts = [];
      return;
    }
    if (entry.type === 'assistant' && (currentUserUuid || currentUserText)) {
      const text = extractClaudeAssistantText(entry);
      if (text) assistantTexts.push(text);
      const ts = parseClaudeTimestampMs(entry.timestamp);
      if (ts) currentLastOutputAt = ts;
    }
  });

  flush();
}

async function diagnoseClaudeTimeMachineFailure({ sourcePath, targetUuid } = {}) {
  const summary = {
    targetUuid: String(targetUuid || '').trim(),
    totalEntries: 0,
    userEntries: 0,
    matchedUuid: null,
    matchedMessageId: null,
    firstUserUuid: '',
    lastUserUuid: '',
  };
  if (!sourcePath || !pathExists(sourcePath)) return summary;
  const target = summary.targetUuid;
  await readJsonlFile(sourcePath, (entry) => {
    summary.totalEntries += 1;
    const entryUuid = String(entry?.uuid || '').trim();
    const entryMessageId = String(entry?.messageId || '').trim();
    const isUser = isClaudeUserPromptEntry(entry);
    if (isUser) {
      summary.userEntries += 1;
      if (!summary.firstUserUuid) summary.firstUserUuid = entryUuid;
      summary.lastUserUuid = entryUuid;
    }
    if (target && entryUuid === target && !summary.matchedUuid) {
      const msg = resolveClaudeMessage(entry);
      const content = msg?.content ?? msg?.text ?? msg?.message ?? msg?.input ?? msg?.output
        ?? entry.content ?? entry.text ?? entry.input ?? entry.output;
      const rawText = extractTextFromContent(content);
      summary.matchedUuid = {
        isUser,
        isMeta: entry?.isMeta === true || msg?.isMeta === true,
        type: entry?.type || '',
        role: resolveClaudeRole(entry),
        contentPreview: String(rawText || '').slice(0, 200),
      };
    }
    if (target && entryMessageId === target && !summary.matchedMessageId) {
      summary.matchedMessageId = {
        type: entry?.type || '',
        isMeta: entry?.isMeta === true,
      };
    }
  });
  return summary;
}

class ClaudeJsonlSource extends JsonlSource {
  constructor({ logger } = {}) {
    super({
      id: 'claude',
      capabilities: {
        meta: true,
        watch: false,
        timeMachine: true,
      },
      sessionIndexBuilder: new SessionIndexBuilder({ concurrency: SUMMARY_READ_CONCURRENCY }),
      logger,
    });
  }

  logTimeMachineFailure(reason, details = {}) {
    const payload = {
      source: 'claude',
      reason: String(reason || 'Unknown failure'),
      ...details,
    };
    if (typeof this.logger === 'function') {
      try {
        this.logger('timeMachine:fail', payload);
      } catch (_) {
        // ignore logger errors
      }
    }
    console.error('[History] Time Machine failed', payload);
  }

  async listProjects() {
    return listClaudeProjects();
  }

  async listSessionFiles() {
    const entries = await collectClaudeSessionFiles();
    return entries.map(entry => entry.file).filter(Boolean);
  }

  async listSessionIndexEntries() {
    await ensureWslHomesLoaded();
    return collectClaudeSessionIndex();
  }

  async buildSummaryBlock(entry) {
    return buildClaudeSummaryBlock(entry);
  }

  async buildSummaryFromFile(filePath, { mtime, size, trustedPath } = {}) {
    const pathValue = typeof filePath === 'string' ? filePath.trim() : '';
    if (!pathValue) return null;
    if (!trustedPath) {
      if (!await isClaudeSessionPathAllowed(pathValue)) return null;
    }
    const projectDir = path.dirname(pathValue);
    const label = path.basename(projectDir) || 'Claude';
    const file = {
      path: pathValue,
      mtime: Number.isFinite(mtime) ? mtime : undefined,
      size: Number.isFinite(size) ? size : undefined,
    };
    const sessionId = path.basename(pathValue, '.jsonl');
    const entry = {
      file,
      sessionId,
      projectDir,
      label,
    };
    return buildClaudeSummaryBlock(entry);
  }

  async loadSession({ sessionId, limit = 200, project_path, project_dir, source_path, load_all } = {}) {
    const max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 200;
    await ensureWslHomesLoaded();

    let sourcePath = typeof source_path === 'string' ? source_path.trim() : '';
    let projectDir = typeof project_dir === 'string' && project_dir.trim()
      ? project_dir.trim()
      : resolveClaudeProjectDir(typeof project_path === 'string' ? project_path.trim() : '');
    let paneLabel = '';

    if (sourcePath && (!pathExists(sourcePath) || !(await isClaudeSessionPathAllowed(sourcePath)))) {
      sourcePath = '';
    }

    if (sourcePath) {
      if (!projectDir || !pathExists(projectDir)) {
        projectDir = path.dirname(sourcePath);
      }
      paneLabel = path.basename(projectDir) || 'Claude';
    } else {
      if (projectDir && pathExists(projectDir)) {
        sourcePath = path.join(projectDir, `${sessionId}.jsonl`);
        paneLabel = path.basename(projectDir) || 'Claude';
      }

      if (!sourcePath || !pathExists(sourcePath)) {
        const projects = await listClaudeProjects();
        const list = Array.isArray(projects?.projects) ? projects.projects : [];
        for (const project of list) {
          if (!project?.dir) continue;
          const candidate = path.join(project.dir, `${sessionId}.jsonl`);
          if (pathExists(candidate)) {
            projectDir = project.dir;
            paneLabel = project.label || path.basename(project.dir) || 'Claude';
            sourcePath = candidate;
            break;
          }
        }
      }
    }

    if (!sourcePath || !pathExists(sourcePath)) {
      return { blocks: [], error: 'Claude session not found' };
    }

    const stat = await fs.promises.stat(sourcePath).catch(() => null);
    const fileInfo = { path: sourcePath, mtime: stat?.mtimeMs || 0, size: stat?.size || 0 };
    if (load_all) {
      const blocks = await scanClaudeSessionFile(fileInfo, {
        projectKey: projectDir,
        paneLabel,
        sessionId,
      });
      for (const block of blocks) {
        if (!block.session_id) {
          block.session_id = sessionId;
          block.session_label = sessionId.slice(-6);
        }
        if (!block.created_at && fileInfo.mtime) block.created_at = fileInfo.mtime;
        if (!block.last_output_at && block.created_at) block.last_output_at = block.created_at;
      }
      blocks.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      return { blocks, maybe_more: false };
    }
    const tailMultiplier = Math.max(1, Math.ceil(max / 200));
    let tailBytes = Math.max(4096, CLAUDE_SESSION_TAIL_BYTES_BASE * tailMultiplier);
    tailBytes = Math.min(CLAUDE_SESSION_TAIL_BYTES_MAX, tailBytes);
    const cwd = await findFirstClaudeCwdInFile(sourcePath);
    let blocks = [];
    for (;;) {
      const events = await readJsonlTail(sourcePath, tailBytes);
      blocks = extractClaudeBlocksFromEntries(events, {
        projectKey: projectDir,
        paneLabel,
        cwd,
        sourcePath,
      });
      if (blocks.length > 0) break;
      if ((fileInfo.size && tailBytes >= fileInfo.size) || tailBytes >= CLAUDE_SESSION_TAIL_BYTES_MAX) break;
      tailBytes = Math.min(CLAUDE_SESSION_TAIL_BYTES_MAX, tailBytes * 2);
    }

    for (const block of blocks) {
      if (!block.session_id) {
        block.session_id = sessionId;
        block.session_label = sessionId.slice(-6);
      }
      if (!block.created_at && fileInfo.mtime) block.created_at = fileInfo.mtime;
      if (!block.last_output_at && block.created_at) block.last_output_at = block.created_at;
    }

    blocks.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    const maybeMore = fileInfo.size > tailBytes;
    return { blocks: blocks.slice(0, max), maybe_more: maybeMore };
  }

  async loadRecent({ limit = 200, project_path, project_dir, project_scope } = {}) {
    const max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 200;
    const blocks = [];
    const seen = new Set();
    let maybeMore = false;
    await ensureWslHomesLoaded();

    const pushBlock = ({ userUuid, sessionId, userText, createdAt, outputText, lastOutputAt, projectKey, paneLabel, cwd, sourcePath }) => {
      const rawId = String(userUuid || '').trim();
      if (!rawId) return;
      const block = buildClaudeBlockFromTurn({
        userUuid: rawId,
        sessionId,
        userText,
        outputText,
        createdAt,
        lastOutputAt,
        projectKey,
        paneLabel,
        cwd,
        sourcePath,
      });
      if (!block) return;
      if (!block.id || seen.has(block.id)) return;
      seen.add(block.id);
      blocks.push(block);
    };

    const scanProjectDir = async (projectDir, paneLabel, limitPerProject) => {
      if (!projectDir || !pathExists(projectDir)) return;
      const files = await listJsonlFiles(projectDir);
      const projectKey = projectDir;
      const baseCount = blocks.length;
      const perProjectLimit = Math.max(1, Math.floor(limitPerProject) || 1);
      const tailMultiplier = Math.max(1, Math.ceil(max / 200));
      const tailBytes = CLAUDE_LOG_TAIL_BYTES * tailMultiplier;
      let scannedCount = 0;

      for (const file of files) {
        const sourcePath = file?.path || '';
        if (blocks.length - baseCount >= perProjectLimit) {
          maybeMore = true;
          break;
        }
        scannedCount += 1;
        const events = await readJsonlTail(file.path, tailBytes);

        let currentUserUuid = '';
        let currentSessionId = '';
        let currentUserText = '';
        let currentCreatedAt = 0;
        let currentLastOutputAt = 0;
        let assistantTexts = [];
        const currentCwd = await findFirstClaudeCwdInFile(file.path);

        const flush = () => {
          if (!currentUserUuid) return;
          const outputText = assistantTexts.filter(Boolean).join('\n').trimEnd();
          pushBlock({
            userUuid: currentUserUuid,
            sessionId: currentSessionId,
            userText: currentUserText,
            createdAt: currentCreatedAt,
            outputText,
            lastOutputAt: currentLastOutputAt || currentCreatedAt,
            projectKey,
            paneLabel,
            cwd: currentCwd,
            sourcePath,
          });
        };

        for (const entry of events) {
          if (!isClaudeMainConversationEntry(entry)) continue;

          if (isClaudeUserPromptEntry(entry)) {
            flush();
            currentUserUuid = String(entry.uuid || '').trim();
            currentSessionId = String(entry.sessionId || '').trim();
            currentUserText = extractClaudeUserPromptText(entry);
            currentCreatedAt = parseClaudeTimestampMs(entry.timestamp);
            currentLastOutputAt = currentCreatedAt;
            assistantTexts = [];
            continue;
          }

          if (entry.type === 'assistant' && currentUserUuid) {
            const text = extractClaudeAssistantText(entry);
            if (text) assistantTexts.push(text);
            const ts = parseClaudeTimestampMs(entry.timestamp);
            if (ts) currentLastOutputAt = ts;
          }
        }

        flush();
        if (Number(file?.size || 0) > tailBytes) {
          maybeMore = true;
        }
      }
      if (scannedCount < files.length) {
        maybeMore = true;
      }
    };

    if (project_scope === 'all') {
      const projects = await listClaudeProjects();
      const list = Array.isArray(projects?.projects) ? projects.projects : [];
      const maxProjects = list.length;
      const limitPerProject = Math.max(50, max);
      for (let i = 0; i < maxProjects; i += 1) {
        if (blocks.length >= max * 3) {
          maybeMore = true;
          break;
        }
        const project = list[i];
        if (!project?.dir) continue;
        const label = project.label || path.basename(project.dir);
        await scanProjectDir(project.dir, label, limitPerProject);
      }
    } else {
      const projectDir = typeof project_dir === 'string' && project_dir.trim()
        ? project_dir.trim()
        : resolveClaudeProjectDir(typeof project_path === 'string' ? project_path.trim() : '');
      if (!projectDir || !pathExists(projectDir)) {
        return { blocks: [], project_key: '' };
      }
      await scanProjectDir(projectDir, 'Claude', max);
    }

    blocks.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    if (blocks.length > max) {
      maybeMore = true;
    }
    return { blocks: blocks.slice(0, max), project_key: '', maybe_more: maybeMore };
  }

  async createTimeMachine({ block } = {}) {
    if (!block || typeof block !== 'object') {
      this.logTimeMachineFailure('Missing block', { block });
      return { success: false, error: 'Missing block' };
    }
    const sessionId = String(block.session_id || '').trim();
    const targetUuid = String(block.source_id || '').trim();
    if (!sessionId || !targetUuid) {
      this.logTimeMachineFailure('Missing session id or target uuid', { sessionId, targetUuid, block });
      return { success: false, error: 'Missing session id' };
    }

    let projectDir = typeof block.pane_id === 'string' ? block.pane_id.trim() : '';
    if (!projectDir || !pathExists(projectDir)) {
      const cwd = typeof block.cwd === 'string' ? block.cwd.trim() : '';
      projectDir = resolveClaudeProjectDir(cwd) || '';
    }
    if (!projectDir || !pathExists(projectDir)) {
      this.logTimeMachineFailure('Project dir not found', {
        sessionId,
        targetUuid,
        projectDir,
        cwd: block.cwd || '',
      });
      return { success: false, error: 'Project dir not found' };
    }

    const sourcePath = path.join(projectDir, `${sessionId}.jsonl`);
    if (!pathExists(sourcePath)) {
      this.logTimeMachineFailure('Claude session not found', {
        sessionId,
        targetUuid,
        projectDir,
        sourcePath,
      });
      return { success: false, error: 'Claude session not found' };
    }

    const newSessionId = buildTimeMachineSessionId();
    const outputPath = path.join(projectDir, `${newSessionId}.jsonl`);
    let result;
    try {
      result = await buildClaudeTimeMachineFile({
        sourcePath,
        outputPath,
        targetUuid,
        newSessionId,
      });
    } catch (err) {
      this.logTimeMachineFailure('Failed to build Time Machine (exception)', {
        sessionId,
        targetUuid,
        sourcePath,
        outputPath,
        message: err?.message || 'unknown',
      });
      return { success: false, error: err?.message || 'Failed to build Time Machine' };
    }
    if (!result?.success) {
      let diagnostic = null;
      try {
        diagnostic = await diagnoseClaudeTimeMachineFailure({ sourcePath, targetUuid });
      } catch (_) {
        diagnostic = null;
      }
      this.logTimeMachineFailure('Failed to build Time Machine', {
        sessionId,
        targetUuid,
        sourcePath,
        outputPath,
        message: result?.error || 'unknown',
        detail: result?.detail || null,
        diagnostic,
      });
      return { success: false, error: result?.error || 'Failed to build Time Machine' };
    }
    return {
      success: true,
      source: 'claude',
      session_id: newSessionId,
      command: `claude -r ${newSessionId}`,
      file_path: outputPath,
    };
  }

  async listSearchEntries({ project_path, project_dir, project_scope, cursor, chunk_size } = {}) {
    await ensureWslHomesLoaded();
    const cursorProvided = Number.isFinite(cursor);
    const start = cursorProvided ? Math.max(0, Math.floor(cursor)) : 0;
    const chunkProvided = Number.isFinite(chunk_size);
    const useCache = cursorProvided || chunkProvided;
    const refresh = start === 0;

    if (project_scope === 'all') {
      const cacheKey = 'claude:all';
      const entries = await this.getSearchFileList(cacheKey, async () => {
        const sessions = await collectClaudeSessionFiles();
        const list = sessions.map(entry => ({
          source: 'claude',
          file: entry.file,
          projectDir: entry.projectDir,
          label: entry.label,
          mtime: entry.file?.mtime || 0,
        }));
        list.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
        return list;
      }, { useCache, refresh });
      return { entries };
    }

    const projectDir = typeof project_dir === 'string' && project_dir.trim()
      ? project_dir.trim()
      : resolveClaudeProjectDir(typeof project_path === 'string' ? project_path.trim() : '');
    if (!projectDir || !pathExists(projectDir)) {
      return { entries: [], error: 'Claude project logs not found.' };
    }

    const cacheKey = `claude:dir:${projectDir}`;
    const entries = await this.getSearchFileList(cacheKey, async () => {
      const list = await listJsonlFiles(projectDir);
      const label = path.basename(projectDir) || projectDir;
      return list.map(file => ({
        source: 'claude',
        file,
        projectDir,
        label,
        mtime: file.mtime || 0,
      }));
    }, { useCache, refresh });
    return { entries };
  }

  async scanSearchEntry(entry, { terms, hits, seen, maxHits } = {}) {
    if (!entry?.file?.path) return;
    await scanClaudeFileForKeywordSearch(entry.file, {
      terms,
      hits,
      seen,
      maxHits,
      projectKey: entry.projectDir,
      paneLabel: entry.label,
    });
  }

  async keywordSearch({ query, terms, limit, cursor, chunk_size, project_path, project_dir, project_scope } = {}) {
    const hits = [];
    const seen = new Set();
    const max = Math.max(1, Number(limit) || 1);
    const cursorProvided = Number.isFinite(cursor);
    const start = cursorProvided ? Math.max(0, Math.floor(cursor)) : 0;
    const chunkProvided = Number.isFinite(chunk_size);
    const chunkSize = chunkProvided ? Math.max(1, Math.floor(chunk_size)) : 0;
    const targetFiles = chunkSize > 0 ? chunkSize : Number.POSITIVE_INFINITY;

    const searchEntries = await this.listSearchEntries({
      project_path,
      project_dir,
      project_scope,
      cursor,
      chunk_size,
    });
    if (searchEntries?.error) {
      return { mode: 'keyword', query, summary: searchEntries.error, candidates: [] };
    }
    const files = Array.isArray(searchEntries?.entries) ? searchEntries.entries : [];

    let index = start;
    let processed = 0;
    while (index < files.length && processed < targetFiles) {
      const entry = files[index];
      index += 1;
      processed += 1;
      await this.scanSearchEntry(entry, { terms, hits, seen, maxHits: max });
      if (hits.length >= max) break;
    }

    const maybeMore = index < files.length;
    const includeCursor = cursorProvided || chunkProvided;
    const total = hits.length;
    const summary = total === 0 ? 'No results.' : `${total} hits`;
    return {
      mode: 'keyword',
      query,
      summary,
      candidates: hits,
      next_cursor: includeCursor ? (maybeMore ? index : null) : undefined,
    };
  }

  async findBlocksById({ ids, project_path, project_dir } = {}) {
    await ensureWslHomesLoaded();
    const targets = Array.isArray(ids)
      ? ids.map(id => stripSourcePrefix('claude', String(id))).filter(Boolean)
      : [];
    if (targets.length === 0) return { blocks: [] };
    const projectDir = typeof project_dir === 'string' && project_dir.trim()
      ? project_dir.trim()
      : resolveClaudeProjectDir(typeof project_path === 'string' ? project_path.trim() : '');
    if (!projectDir || !pathExists(projectDir)) {
      return { blocks: [] };
    }

    const projectKey = projectDir;
    const pending = new Set(targets);
    const found = [];
    const files = await listJsonlFiles(projectDir);

    for (const file of files) {
      if (pending.size === 0) break;
      const events = await readJsonlTail(file.path, CLAUDE_LOG_TAIL_BYTES);
      const headCwd = await findFirstClaudeCwdInFile(file.path);

      let currentUserUuid = '';
      let currentSessionId = '';
      let currentUserText = '';
      let currentCreatedAt = 0;
      let currentLastOutputAt = 0;
      let assistantTexts = [];

      const flush = () => {
        if (!currentUserUuid) return;
        const outputText = assistantTexts.filter(Boolean).join('\n').trimEnd();
        const output = String(outputText || '');
        if (!output.trim()) return;
        if (!pending.has(currentUserUuid)) return;
        pending.delete(currentUserUuid);
        const block = {
          id: currentUserUuid,
          session_id: currentSessionId || 'claude',
          session_label: currentSessionId ? currentSessionId.slice(-6) : 'claude',
          pane_id: projectKey,
          pane_label: 'Claude',
          inputs: currentUserText ? [currentUserText] : [],
          input: currentUserText || '',
          output_raw: '',
          output_text: output,
          output_head: output.slice(0, 400),
          output_tail: output.length > 400 ? output.slice(-400) : output,
          created_at: currentCreatedAt || 0,
          last_output_at: currentLastOutputAt || currentCreatedAt || 0,
          has_output: Boolean(output.trim()),
          is_tui: false,
          cwd: headCwd,
        };
        attachWslMetadata(block, { sourcePath: file?.path, projectDir: projectKey });
        found.push(block);
      };

      for (const entry of events) {
        if (!isClaudeMainConversationEntry(entry)) continue;

        if (isClaudeUserPromptEntry(entry)) {
          flush();
          currentUserUuid = String(entry.uuid || '').trim();
          currentSessionId = String(entry.sessionId || '').trim();
          currentUserText = extractClaudeUserPromptText(entry);
          currentCreatedAt = parseClaudeTimestampMs(entry.timestamp);
          currentLastOutputAt = currentCreatedAt;
          assistantTexts = [];
          continue;
        }

        if (entry.type === 'assistant' && currentUserUuid) {
          const text = extractClaudeAssistantText(entry);
          if (text) assistantTexts.push(text);
          const ts = parseClaudeTimestampMs(entry.timestamp);
          if (ts) currentLastOutputAt = ts;
        }
      }

      flush();
    }

    return { blocks: found };
  }
}

async function isClaudeSessionPathAllowed(filePath) {
  if (!filePath) return false;
  const roots = await listClaudeProjectRoots();
  return isPathInRoots(filePath, roots);
}

module.exports = {
  ClaudeJsonlSource,
  resolveClaudeProjectDir,
  listClaudeProjectRoots,
};
