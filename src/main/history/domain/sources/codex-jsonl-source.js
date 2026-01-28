const fs = require('fs');
const path = require('path');

const JsonlSource = require('./jsonl-source');
const { listJsonlFilesRecursive, readJsonlFile, readJsonlHead, readJsonlTail } = require('../../infra/jsonl-reader');
const { SessionIndexBuilder, selectLatestBlockWithInput, blockHasInput } = require('../builders/session-index-builder');
const {
  buildCodexDedupKey,
  extractCodexBlockFromEntry,
  extractCodexContentText,
  extractCodexSessionIdFromFilename,
  parseCodexSessionEntries,
  resolveCodexSessionIdFromEntries,
  scanCodexSessionFile,
  shouldSkipCodexUserMessage,
} = require('../builders/codex-blocks');
const { buildTimeMachineSessionId, extractCodexCwd } = require('../../utils/codex-utils');
const { normalizeRole } = require('../../utils/text-utils');
const { buildCodexTimeMachineFile, parseCodexSessionIdFromSourceId } = require('../builders/time-machine');
const { attachWslMetadata } = require('../../infra/wsl-utils');
const { computeKeywordMatchScore } = require('../../utils/keyword-search');
const { pathExists, isPathInRoots } = require('../../infra/path-utils');
const { stripSourcePrefix, parseTimestampMs } = require('../../utils/block-utils');
const {
  listLocalCodexRoots,
  listWslCodexRoots,
} = require('../../../infra/agents/agent-roots');
const {
  CODEX_DEDUP_BUCKET_MS,
  CODEX_HEAD_BYTES,
  CODEX_SESSION_SUMMARY_TAIL_BYTES,
  CODEX_SESSION_TAIL_BYTES_BASE,
  CODEX_SESSION_TAIL_BYTES_MAX,
  CODEX_SESSIONS_DIRNAME,
  CODEX_SUMMARY_HEAD_BYTES,
  CODEX_TAIL_BYTES_BASE,
  SUMMARY_READ_CONCURRENCY,
} = require('../history-constants');

function formatCodexSessionStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day}T${hours}-${minutes}-${seconds}`;
}

async function listWslCodexHomes() {
  return listWslCodexRoots();
}

async function listCodexHomes() {
  const homes = new Set(listLocalCodexRoots());
  const wslHomes = await listWslCodexHomes();
  for (const home of wslHomes) {
    homes.add(home);
  }
  return Array.from(homes);
}

async function listCodexSessionRoots() {
  const homes = await listCodexHomes();
  return homes.map(home => path.join(home, CODEX_SESSIONS_DIRNAME));
}

async function listCodexHistoryFiles() {
  const homes = await listCodexHomes();
  const files = [];
  for (const home of homes) {
    const sessionsRoot = path.join(home, CODEX_SESSIONS_DIRNAME);
    const nested = await listJsonlFilesRecursive(sessionsRoot, 6);
    if (nested.length > 0) files.push(...nested);
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return { mode: 'sessions', files };
}

async function isCodexSessionPathAllowed(filePath) {
  if (!filePath) return false;
  const roots = await listCodexSessionRoots();
  return isPathInRoots(filePath, roots);
}

async function findCodexSessionFilesById(sessionId) {
  const needle = String(sessionId || '').trim();
  if (!needle) return [];
  const { files } = await listCodexHistoryFiles();
  if (!files || files.length === 0) return [];
  const direct = files.filter(file => String(file.path || '').includes(needle));
  if (direct.length > 0) return direct;
  const matches = [];
  for (const file of files) {
    const headEntries = await readJsonlHead(file.path, CODEX_HEAD_BYTES);
    const headId = resolveCodexSessionIdFromEntries(headEntries) || extractCodexSessionIdFromFilename(file.path);
    if (headId === needle) {
      matches.push(file);
    }
  }
  return matches;
}

function resolveCodexCwdFromEntries(entries) {
  if (!Array.isArray(entries)) return '';
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'session_meta' || entry.type === 'turn_context') {
      const payload = entry.payload || {};
      const candidate = extractCodexCwd(payload);
      if (candidate) return candidate;
    }
    const candidate = extractCodexCwd(entry);
    if (candidate) return candidate;
  }
  return '';
}

function inferCodexStatusHint(entries) {
  let sawUser = false;
  let assistantAfterUser = false;
  let sawTurnAborted = false;
  let lastHintTs = 0;

  const pendingToolCalls = new Set();
  const pendingRequestCalls = new Set();
  let pendingToolAnon = 0;
  let pendingRequestAnon = 0;

  const noteTimestamp = (entry) => {
    const ts = parseTimestampMs(entry?.timestamp ?? entry?.ts ?? entry?.time);
    if (Number.isFinite(ts) && ts > 0) lastHintTs = ts;
  };

  const extractPayload = (entry) => {
    if (!entry || typeof entry !== 'object') return null;
    if (entry.type !== 'response_item') return null;
    const payload = entry.payload || entry.item || entry.data || null;
    if (!payload || typeof payload !== 'object') return null;
    const itemType = String(payload.type || '').trim().toLowerCase();
    if (!itemType) return null;
    return { payload, itemType };
  };

  const extractCallId = (payload, entry) => {
    const raw = payload?.call_id
      ?? payload?.callId
      ?? payload?.id
      ?? payload?.tool_call_id
      ?? payload?.toolCallId
      ?? payload?.command_id
      ?? payload?.commandId
      ?? entry?.call_id
      ?? entry?.id
      ?? '';
    return String(raw || '').trim();
  };

  const hasPendingTools = () => pendingToolCalls.size > 0 || pendingToolAnon > 0;
  const hasPendingRequest = () => pendingRequestCalls.size > 0 || pendingRequestAnon > 0;

  const markToolStart = (callId, isRequest, entry) => {
    if (callId) pendingToolCalls.add(callId);
    else pendingToolAnon += 1;
    if (isRequest) {
      if (callId) pendingRequestCalls.add(callId);
      else pendingRequestAnon += 1;
    }
    sawTurnAborted = false;
    noteTimestamp(entry);
  };

  const markToolOutput = (callId, entry) => {
    if (callId) {
      pendingToolCalls.delete(callId);
      pendingRequestCalls.delete(callId);
    } else {
      if (pendingToolAnon > 0) pendingToolAnon -= 1;
      if (pendingRequestAnon > 0) pendingRequestAnon -= 1;
    }
    noteTimestamp(entry);
  };

  const markMessage = (role, entry) => {
    if (role === 'user') {
      sawUser = true;
      assistantAfterUser = false;
      sawTurnAborted = false;
      noteTimestamp(entry);
      return;
    }
    if (role === 'assistant') {
      if (sawUser) assistantAfterUser = true;
      noteTimestamp(entry);
    }
  };

  for (const entry of entries || []) {
    if (!entry || typeof entry !== 'object') continue;

    if (entry.type === 'event_msg') {
      const payload = entry.payload || {};
      const kind = String(payload.type || '').trim().toLowerCase();
      if (kind === 'turn_aborted') {
        sawTurnAborted = true;
        pendingToolCalls.clear();
        pendingRequestCalls.clear();
        pendingToolAnon = 0;
        pendingRequestAnon = 0;
        noteTimestamp(entry);
      }
      continue;
    }

    const item = extractPayload(entry);
    if (!item) continue;
    const { payload, itemType } = item;

    if (itemType === 'message') {
      const role = normalizeRole(payload.role);
      if (role !== 'user' && role !== 'assistant') continue;
      const content = payload.content ?? payload.message ?? payload.text;
      if (role === 'user' && shouldSkipCodexUserMessage(content)) continue;
      const text = extractCodexContentText(content, role);
      if (!text) continue;
      markMessage(role, entry);
      continue;
    }

    if (itemType === 'function_call' || itemType === 'custom_tool_call') {
      const callId = extractCallId(payload, entry);
      const name = String(payload.name || '').trim().toLowerCase();
      const isRequest = name === 'request_user_input';
      markToolStart(callId, isRequest, entry);
      continue;
    }

    if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
      const callId = extractCallId(payload, entry);
      markToolOutput(callId, entry);
      continue;
    }

    if (itemType === 'local_shell_call') {
      const rawStatus = payload.status ?? payload.state ?? entry.status ?? entry.state ?? '';
      const status = String(rawStatus || '').trim().toLowerCase();
      const callId = extractCallId(payload, entry);
      if (status === 'completed') {
        markToolOutput(callId, entry);
      } else if (status === 'in_progress' || status === 'incomplete') {
        markToolStart(callId, false, entry);
      }
    }
  }

  let status = '';
  if (sawTurnAborted) {
    status = 'completed';
  } else if (sawUser && hasPendingRequest()) {
    status = 'waiting_user';
  } else if (sawUser && assistantAfterUser && !hasPendingTools()) {
    status = 'completed';
  } else if (sawUser && (!assistantAfterUser || hasPendingTools())) {
    status = 'working';
  }

  return { status, timestamp: lastHintTs || 0 };
}

async function readFastCodexSummaryBlock(file) {
  if (!file?.path) return null;
  const fileSize = Number(file.size || 0);
  let tailBytes = Math.max(4096, CODEX_SESSION_SUMMARY_TAIL_BYTES);
  let initialCwd = '';
  let headEntries = null;
  for (;;) {
    const entries = await readJsonlTail(file.path, tailBytes);
    if (!entries || entries.length === 0) return null;
    let parsed = parseCodexSessionEntries(entries, file, { initialCwd });
    let block = selectLatestBlockWithInput(parsed);
    if (block && !block.cwd && !initialCwd) {
      try {
        headEntries = headEntries || await readJsonlHead(file.path, CODEX_SUMMARY_HEAD_BYTES);
        const headCwd = resolveCodexCwdFromEntries(headEntries);
        if (headCwd) {
          initialCwd = headCwd;
          parsed = parseCodexSessionEntries(entries, file, { initialCwd });
          block = selectLatestBlockWithInput(parsed);
        }
      } catch (_) {
        // ignore
      }
    }
    if (block) {
      if (!block.created_at && file?.mtime) block.created_at = file.mtime;
      if (!block.last_output_at && block.created_at) block.last_output_at = block.created_at;
      const statusHint = inferCodexStatusHint(entries);
      if (statusHint?.status) {
        block.status_hint = statusHint.status;
        block.status_hint_ts = statusHint.timestamp || 0;
      }
      return block;
    }
    if ((fileSize && tailBytes >= fileSize) || tailBytes >= CODEX_SESSION_TAIL_BYTES_MAX) break;
    tailBytes = Math.min(CODEX_SESSION_TAIL_BYTES_MAX, tailBytes * 2);
  }
  return null;
}

async function buildCodexSummaryBlock(entry) {
  if (!entry?.file) return null;
  let block = await readFastCodexSummaryBlock(entry.file);
  if (!block || !blockHasInput(block)) return null;
  const rawId = String(block.session_id || '').trim();
  let resolvedSessionId = rawId;
  if (!resolvedSessionId || resolvedSessionId.length < 20) {
    const headEntries = await readJsonlHead(entry.file.path, CODEX_SUMMARY_HEAD_BYTES);
    const headId = resolveCodexSessionIdFromEntries(headEntries);
    resolvedSessionId = headId || entry.sessionId || rawId || '';
  }
  if (resolvedSessionId) {
    block.session_id = resolvedSessionId;
    block.session_label = resolvedSessionId.slice(-6);
  } else {
    block.session_id = entry.sessionId || 'codex';
    block.session_label = (entry.sessionId || 'codex').slice(-6);
  }
  if (!block.source_path && entry.file?.path) {
    attachWslMetadata(block, { sourcePath: entry.file.path });
  }
  if (!block.created_at && entry.file?.mtime) block.created_at = entry.file.mtime;
  if (!block.last_output_at && block.created_at) block.last_output_at = block.created_at;
  return block;
}

async function collectCodexSessionIndex() {
  const { files } = await listCodexHistoryFiles();
  if (!files || files.length === 0) return [];
  const bySession = new Map();
  for (const file of files) {
    const sessionId = extractCodexSessionIdFromFilename(file?.path || '');
    if (!sessionId) continue;
    const existing = bySession.get(sessionId);
    if (!existing || (file.mtime || 0) > (existing.file?.mtime || 0)) {
      bySession.set(sessionId, { file, sessionId });
    }
  }
  const entries = Array.from(bySession.values());
  entries.sort((a, b) => (b.file?.mtime || 0) - (a.file?.mtime || 0));
  return entries;
}

async function scanCodexFileForKeywordSearch(fileInfo, { terms, hits, seen, maxHits } = {}) {
  if (!fileInfo?.path) return;
  await scanCodexSessionFile(fileInfo.path, (block) => {
    if (!block) return;
    if (maxHits && hits.length >= maxHits) return;
    if (!block.created_at && fileInfo?.mtime) block.created_at = fileInfo.mtime;
    if (!block.last_output_at && block.created_at) block.last_output_at = block.created_at;
    const match = computeKeywordMatchScore({ input: block.input, output: block.output_text, terms });
    if (!match.matched) return;
    const id = block.id ? String(block.id) : '';
    if (id && seen?.has(id)) return;
    if (id && seen) seen.add(id);
    hits.push({ score: match.score, why: match.why, block });
  });
}

class CodexJsonlSource extends JsonlSource {
  constructor({ logger } = {}) {
    super({
      id: 'codex',
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
      source: 'codex',
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

  async listSessionFiles() {
    const { files } = await listCodexHistoryFiles();
    return Array.isArray(files) ? files : [];
  }

  async listSessionIndexEntries() {
    return collectCodexSessionIndex();
  }

  async buildSummaryBlock(entry) {
    return buildCodexSummaryBlock(entry);
  }

  async buildSummaryFromFile(filePath, { mtime, size, trustedPath } = {}) {
    const pathValue = typeof filePath === 'string' ? filePath.trim() : '';
    if (!pathValue) return null;
    if (!trustedPath) {
      if (!await isCodexSessionPathAllowed(pathValue)) return null;
    }
    const file = {
      path: pathValue,
      mtime: Number.isFinite(mtime) ? mtime : undefined,
      size: Number.isFinite(size) ? size : undefined,
    };
    const sessionId = extractCodexSessionIdFromFilename(pathValue);
    const entry = { file, sessionId };
    return buildCodexSummaryBlock(entry);
  }

  async loadSession({ sessionId, limit = 200, source_path, load_all } = {}) {
    const max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 200;
    let file = null;
    const sourcePath = typeof source_path === 'string' ? source_path.trim() : '';
    if (sourcePath && pathExists(sourcePath) && await isCodexSessionPathAllowed(sourcePath)) {
      const stat = await fs.promises.stat(sourcePath).catch(() => null);
      file = { path: sourcePath, mtime: stat?.mtimeMs || 0, size: stat?.size || 0 };
    }
    if (!file) {
      const candidates = await findCodexSessionFilesById(sessionId);
      if (!candidates || candidates.length === 0) {
        return { blocks: [], error: 'Codex session not found' };
      }
      const sorted = candidates.slice().sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      file = sorted[0];
    }
    if (load_all) {
      const blocks = [];
      await scanCodexSessionFile(file.path, (block) => {
        if (!block) return;
        if (!block.created_at && file?.mtime) block.created_at = file.mtime;
        if (!block.last_output_at && block.created_at) block.last_output_at = block.created_at;
        blocks.push(block);
      });

      let headSessionId = '';
      const needsHead = blocks.some((block) => {
        const id = String(block?.session_id || '');
        return !id || id.length < 20;
      });
      if (needsHead) {
        const headEntries = await readJsonlHead(file.path, CODEX_HEAD_BYTES);
        headSessionId = resolveCodexSessionIdFromEntries(headEntries);
      }

      for (const block of blocks) {
        if (headSessionId) {
          block.session_id = headSessionId;
          block.session_label = headSessionId ? headSessionId.slice(-6) : 'codex';
        } else if (!block.session_id) {
          block.session_id = sessionId;
          block.session_label = sessionId.slice(-6);
        }
      }

      blocks.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      return { blocks, maybe_more: false };
    }
    const tailMultiplier = Math.max(1, Math.ceil(max / 200));
    let tailBytes = Math.max(4096, CODEX_SESSION_TAIL_BYTES_BASE * tailMultiplier);
    tailBytes = Math.min(CODEX_SESSION_TAIL_BYTES_MAX, tailBytes);
    let headEntries = null;
    let initialCwd = '';
    try {
      headEntries = await readJsonlHead(file.path, CODEX_HEAD_BYTES);
      initialCwd = resolveCodexCwdFromEntries(headEntries);
    } catch (_) {
      headEntries = null;
      initialCwd = '';
    }
    let blocks = [];
    for (;;) {
      const entries = await readJsonlTail(file.path, tailBytes);
      blocks = parseCodexSessionEntries(entries, file, { initialCwd });
      if (blocks.length > 0) break;
      if ((file.size && tailBytes >= file.size) || tailBytes >= CODEX_SESSION_TAIL_BYTES_MAX) break;
      tailBytes = Math.min(CODEX_SESSION_TAIL_BYTES_MAX, tailBytes * 2);
    }

    let headSessionId = '';
    const needsHead = blocks.some((block) => {
      const id = String(block?.session_id || '');
      return !id || id.length < 20;
    });
    if (needsHead) {
      if (!headEntries) {
        headEntries = await readJsonlHead(file.path, CODEX_HEAD_BYTES);
      }
      headSessionId = resolveCodexSessionIdFromEntries(headEntries);
    }

    for (const block of blocks) {
      if (headSessionId) {
        block.session_id = headSessionId;
        block.session_label = headSessionId ? headSessionId.slice(-6) : 'codex';
      } else if (!block.session_id) {
        block.session_id = sessionId;
        block.session_label = sessionId.slice(-6);
      }
      if (!block.created_at && file?.mtime) block.created_at = file.mtime;
      if (!block.last_output_at && block.created_at) block.last_output_at = block.created_at;
    }

    blocks.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    const maybeMore = Number(file?.size || 0) > tailBytes;
    return { blocks: blocks.slice(0, max), maybe_more: maybeMore };
  }

  async loadRecent({ limit = 200 } = {}) {
    const max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 200;
    const { mode, files } = await listCodexHistoryFiles();
    if (!files || files.length === 0) {
      return { blocks: [] };
    }

    const blocks = [];
    const seen = new Set();
    const dedupeIndex = new Map();
    let maybeMore = false;
    const multiplier = Math.max(1, Math.ceil(max / 200));
    const tailBytes = CODEX_TAIL_BYTES_BASE * multiplier;
    const bufferTarget = Math.max(max * 2, 200);
    let scannedCount = 0;

    for (const file of files) {
      if (blocks.length >= bufferTarget) break;
      scannedCount += 1;
      const entries = await readJsonlTail(file.path, tailBytes);
      if (mode === 'sessions') {
        let headEntries = null;
        let initialCwd = '';
        try {
          headEntries = await readJsonlHead(file.path, CODEX_HEAD_BYTES);
          initialCwd = resolveCodexCwdFromEntries(headEntries);
        } catch (_) {
          headEntries = null;
          initialCwd = '';
        }
        const parsed = parseCodexSessionEntries(entries, file, { initialCwd });
        let headSessionId = '';
        const needsHead = parsed.some(block => {
          const id = String(block?.session_id || '');
          return !id || id.length < 20;
        });
        if (needsHead) {
          if (!headEntries) {
            headEntries = await readJsonlHead(file.path, CODEX_HEAD_BYTES);
          }
          headSessionId = resolveCodexSessionIdFromEntries(headEntries);
        }
        for (const block of parsed) {
          if (!block || seen.has(block.id)) continue;
          if (headSessionId) {
            block.session_id = headSessionId;
            block.session_label = headSessionId ? headSessionId.slice(-6) : 'codex';
          }
          if (!block.created_at && file?.mtime) {
            block.created_at = file.mtime;
          }
          if (!block.last_output_at && block.created_at) {
            block.last_output_at = block.created_at;
          }
          const dedupeKey = buildCodexDedupKey(block, { bucketMs: CODEX_DEDUP_BUCKET_MS });
          const existingIndex = dedupeKey ? dedupeIndex.get(dedupeKey) : null;
          if (typeof existingIndex === 'number' && blocks[existingIndex]) {
            const existing = blocks[existingIndex];
            const nextLen = String(block.output_text || '').length;
            const prevLen = String(existing.output_text || '').length;
            if (nextLen > prevLen) {
              blocks[existingIndex] = block;
            }
            seen.add(block.id);
            continue;
          }
          seen.add(block.id);
          if (dedupeKey) dedupeIndex.set(dedupeKey, blocks.length);
          blocks.push(block);
          if (blocks.length >= bufferTarget) break;
        }
        if (Number(file?.size || 0) > tailBytes) {
          maybeMore = true;
        }
        continue;
      }

      for (const entry of entries) {
        const block = extractCodexBlockFromEntry(entry);
        if (!block || seen.has(block.id)) continue;
        attachWslMetadata(block, { sourcePath: file?.path });
        if (!block.created_at && file?.mtime) {
          block.created_at = file.mtime;
        }
        if (!block.last_output_at && block.created_at) {
          block.last_output_at = block.created_at;
        }
        const dedupeKey = buildCodexDedupKey(block, { bucketMs: CODEX_DEDUP_BUCKET_MS });
        const existingIndex = dedupeKey ? dedupeIndex.get(dedupeKey) : null;
        if (typeof existingIndex === 'number' && blocks[existingIndex]) {
          const existing = blocks[existingIndex];
          const nextLen = String(block.output_text || '').length;
          const prevLen = String(existing.output_text || '').length;
          if (nextLen > prevLen) {
            blocks[existingIndex] = block;
          }
          seen.add(block.id);
          continue;
        }
        seen.add(block.id);
        if (dedupeKey) dedupeIndex.set(dedupeKey, blocks.length);
        blocks.push(block);
      }
      if (Number(file?.size || 0) > tailBytes) {
        maybeMore = true;
      }
    }

    if (scannedCount < files.length) {
      maybeMore = true;
    }
    blocks.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    if (blocks.length > max) {
      maybeMore = true;
    }
    return { blocks: blocks.slice(0, max), maybe_more: maybeMore };
  }

  async keywordSearch({ query, terms, limit, cursor, chunk_size } = {}) {
    const hits = [];
    const seen = new Set();
    const max = Math.max(1, Number(limit) || 1);
    const cursorProvided = Number.isFinite(cursor);
    const start = cursorProvided ? Math.max(0, Math.floor(cursor)) : 0;
    const chunkProvided = Number.isFinite(chunk_size);
    const chunkSize = chunkProvided ? Math.max(1, Math.floor(chunk_size)) : 0;
    const targetFiles = chunkSize > 0 ? chunkSize : Number.POSITIVE_INFINITY;

    const searchEntries = await this.listSearchEntries({ cursor, chunk_size });
    const files = Array.isArray(searchEntries?.entries) ? searchEntries.entries : [];
    if (searchEntries?.error) {
      return { mode: 'keyword', query, summary: searchEntries.error, candidates: [] };
    }
    if (!files || files.length === 0) {
      return { mode: 'keyword', query, summary: 'Codex history not found.', candidates: [] };
    }

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

  async listSearchEntries({ cursor, chunk_size } = {}) {
    const cursorProvided = Number.isFinite(cursor);
    const start = cursorProvided ? Math.max(0, Math.floor(cursor)) : 0;
    const chunkProvided = Number.isFinite(chunk_size);
    const useCache = cursorProvided || chunkProvided;
    const refresh = start === 0;

    const cacheKey = 'codex:all';
    const entries = await this.getSearchFileList(cacheKey, async () => {
      const { files: historyFiles } = await listCodexHistoryFiles();
      return (historyFiles || []).map(file => ({
        source: 'codex',
        file,
        mtime: file?.mtime || 0,
      }));
    }, { useCache, refresh });

    return { entries };
  }

  async scanSearchEntry(entry, { terms, hits, seen, maxHits } = {}) {
    if (!entry?.file?.path) return;
    await scanCodexFileForKeywordSearch(entry.file, { terms, hits, seen, maxHits });
  }

  async findBlocksById({ ids } = {}) {
    const targets = Array.isArray(ids)
      ? ids.map(id => String(id)).filter(Boolean)
      : [];
    if (targets.length === 0) return { blocks: [] };
    const rawTargets = new Set(targets.map(id => stripSourcePrefix('codex', id)));
    const targetSet = new Set(targets);
    const found = [];
    try {
      const { mode, files } = await listCodexHistoryFiles();
      if (!files || files.length === 0) return { blocks: [] };
      for (const file of files) {
        if (mode === 'sessions') {
          await scanCodexSessionFile(file.path, (block) => {
            if (!block) return;
            const rawId = String(block.source_id || '').trim();
            if (rawTargets.has(rawId) || targetSet.has(block.id)) {
              rawTargets.delete(rawId);
              targetSet.delete(block.id);
              found.push(block);
            }
          });
        } else {
          await readJsonlFile(file.path, (entry) => {
            if (targetSet.size === 0 && rawTargets.size === 0) return;
            const block = extractCodexBlockFromEntry(entry);
            if (!block) return;
            attachWslMetadata(block, { sourcePath: file?.path });
            const rawId = String(block.source_id || '').trim();
            if (rawTargets.has(rawId) || targetSet.has(block.id)) {
              rawTargets.delete(rawId);
              targetSet.delete(block.id);
              found.push(block);
            }
          });
        }
        if (targetSet.size === 0 && rawTargets.size === 0) break;
      }
      return { blocks: found };
    } catch (e) {
      return { blocks: [], error: e?.message || 'Failed to load blocks' };
    }
  }

  async createTimeMachine({ block } = {}) {
    if (!block || typeof block !== 'object') {
      this.logTimeMachineFailure('Missing block', { block });
      return { success: false, error: 'Missing block' };
    }
    const rawSourceId = String(block.source_id || '').trim();
    const rawBlockId = String(block.block_id || block.id || '').trim();
    const targetSourceId = stripSourcePrefix('codex', rawSourceId || rawBlockId);
    const derivedSessionId = targetSourceId ? parseCodexSessionIdFromSourceId(targetSourceId) : '';
    const sessionId = String(derivedSessionId || block.session_id || '').trim();
    if (!sessionId) {
      this.logTimeMachineFailure('Missing session id', { block });
      return { success: false, error: 'Missing session id' };
    }

    let candidates = [];
    const resolvedPath = typeof block.source_path === 'string' ? block.source_path.trim() : '';
    if (resolvedPath) {
      candidates = [{ path: resolvedPath }];
    } else {
      candidates = await findCodexSessionFilesById(sessionId);
    }
    if (candidates.length === 0) {
      this.logTimeMachineFailure('Codex session not found', { sessionId, block });
      return { success: false, error: 'Codex session not found' };
    }

    const targetInput = block.input || (Array.isArray(block.inputs) ? block.inputs[0] : '') || '';
    const targetTimestamp = block.created_at || block.last_output_at || 0;
    const sourceSessionId = sessionId;
    let lastError = null;

    for (const file of candidates) {
      const newSessionId = buildTimeMachineSessionId();
      const dir = path.dirname(file.path);
      const stamp = formatCodexSessionStamp(new Date());
      const outputPath = path.join(dir, `rollout-${stamp}-${newSessionId}.jsonl`);
      try {
        const result = await buildCodexTimeMachineFile({
          sourcePath: file.path,
          outputPath,
          targetInput,
          targetTimestamp,
          targetSourceId,
          sourceSessionId,
          newSessionId,
          forkedFromId: sourceSessionId || sessionId,
        });
        if (result?.success) {
          return {
            success: true,
            source: 'codex',
            session_id: newSessionId,
            command: `codex resume ${newSessionId}`,
            file_path: outputPath,
          };
        }
        lastError = result?.error || null;
      } catch (err) {
        lastError = err?.message || 'Failed to build Time Machine';
      }
    }

    this.logTimeMachineFailure('Failed to build Time Machine', {
      sessionId,
      candidateCount: candidates.length,
      targetSourceId,
      targetTimestamp,
      targetInputPreview: String(targetInput || '').slice(0, 200),
      message: lastError || 'unknown',
    });
    return { success: false, error: lastError || 'Target not found in Codex session' };
  }
}

module.exports = {
  CodexJsonlSource,
  listCodexHistoryFiles,
};
