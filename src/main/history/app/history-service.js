const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const HistoryRepository = require('../domain/repository');
const { createDefaultSources, resolveClaudeProjectDir } = require('../domain/sources');
const { normalizeSearchTerms } = require('../utils/keyword-search');
const { ensureWslHomesLoaded, resetWslCaches } = require('../infra/wsl-homes');
const { SESSION_INDEX_CACHE_TTL_MS } = require('../domain/history-constants');

// Windowsは python / py -3、macOS/Linuxは python3 / python
const PYTHON_CANDIDATES = process.platform === 'win32'
  ? [
      { cmd: 'python', checkArgs: ['--version'], runArgs: [] },
      { cmd: 'py', checkArgs: ['-3', '--version'], runArgs: ['-3'] },
    ]
  : [
      // macOS (Apple Silicon) Homebrew
      { cmd: path.join(path.sep, 'opt', 'homebrew', 'bin', 'python3'), checkArgs: ['--version'], runArgs: [] },
      // macOS (Intel) Homebrew
      { cmd: path.join(path.sep, 'usr', 'local', 'bin', 'python3'), checkArgs: ['--version'], runArgs: [] },
      { cmd: 'python3', checkArgs: ['--version'], runArgs: [] },
      { cmd: 'python', checkArgs: ['--version'], runArgs: [] },
    ];

const CLAUDE_FALLBACK_PATHS = [
  path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude'),
  path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
  path.join(os.homedir(), '.claude', 'bin', 'claude'),
  path.join(os.homedir(), '.claude', 'local', 'bin', 'claude'),
  path.join(os.homedir(), '.bun', 'bin', 'claude'),
  path.join(os.homedir(), '.volta', 'bin', 'claude'),
  path.join(os.homedir(), '.asdf', 'shims', 'claude'),
  path.join(os.homedir(), '.nix-profile', 'bin', 'claude'),
  path.join(os.homedir(), 'Library', 'pnpm', 'claude'),
  path.join(os.homedir(), '.local', 'share', 'pnpm', 'claude'),
  path.join(path.sep, 'opt', 'homebrew', 'bin', 'claude'),
  path.join(path.sep, 'usr', 'local', 'bin', 'claude'),
];

const DEP_CHECK_CACHE_MS = 5000;
// Timeout for Python/Claude search execution.
// Set HISTORY_TIMEOUT_MS (>0) to enable; 0/empty disables timeout (useful for debugging long searches).
const HISTORY_TIMEOUT_MS = (() => {
  const raw = process.env.HISTORY_TIMEOUT_MS;
  if (raw == null) return 0;
  const ms = Number(raw);
  return Number.isFinite(ms) ? ms : 0;
})();
const SHELL_PATH_CACHE_MS = 60_000;
const SHELL_PATH_TIMEOUT_MS = 1800;
const SHELL_PATH_MARKER_START = '__KAWAII_TERMINAL_PATH_START__';
const SHELL_PATH_MARKER_END = '__KAWAII_TERMINAL_PATH_END__';

let shellPathCache = null;
let shellPathCheckedAt = 0;
let shellPathPromise = null;
const logHistoryDebug = () => {};

function getUserShell() {
  const envShell = String(process.env.SHELL || '').trim();
  if (envShell) return envShell;
  try {
    const info = os.userInfo();
    const shell = String(info?.shell || '').trim();
    if (shell) return shell;
  } catch {
    return null;
  }
  return null;
}

function ensureMacGuiPath() {
  if (process.platform !== 'darwin') return;
  const current = process.env.PATH || '';
  const extraDirs = [
    path.join(path.sep, 'opt', 'homebrew', 'bin'),
    path.join(path.sep, 'opt', 'homebrew', 'sbin'),
    path.join(path.sep, 'usr', 'local', 'bin'),
    path.join(path.sep, 'usr', 'local', 'sbin'),
    path.join(os.homedir(), '.claude', 'bin'),
    path.join(os.homedir(), '.claude', 'local', 'bin'),
    path.join(os.homedir(), '.bun', 'bin'),
    path.join(os.homedir(), '.volta', 'bin'),
    path.join(os.homedir(), '.asdf', 'shims'),
    path.join(os.homedir(), '.nix-profile', 'bin'),
    path.join(os.homedir(), 'Library', 'pnpm'),
    path.join(os.homedir(), '.local', 'share', 'pnpm'),
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.npm-global', 'bin'),
  ];

  const parts = current.split(path.delimiter).filter(Boolean);
  const next = [];
  const seen = new Set();
  for (const dir of [...extraDirs, ...parts]) {
    if (!dir) continue;
    if (seen.has(dir)) continue;
    seen.add(dir);
    next.push(dir);
  }
  process.env.PATH = next.join(path.delimiter);
}

function mergePathStrings(primary, secondary) {
  const merged = [];
  const seen = new Set();

  const add = (value) => {
    const raw = String(value || '');
    if (!raw) return;
    for (const part of raw.split(path.delimiter)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      merged.push(trimmed);
    }
  };

  add(primary);
  add(secondary);
  return merged.join(path.delimiter);
}

function extractMarkedValue(text, startMarker, endMarker) {
  const raw = String(text || '');
  const start = raw.lastIndexOf(startMarker);
  if (start < 0) return null;
  const end = raw.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return null;
  return raw.slice(start + startMarker.length, end);
}

function resolvePathFromUserShell(timeoutMs = SHELL_PATH_TIMEOUT_MS) {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  const now = Date.now();
  if (shellPathCheckedAt && now - shellPathCheckedAt < SHELL_PATH_CACHE_MS) {
    return Promise.resolve(shellPathCache);
  }
  if (shellPathPromise) return shellPathPromise;

  shellPathPromise = new Promise((resolve) => {
    const shell = getUserShell() || path.join(path.sep, 'bin', 'zsh');
    const shellName = path.basename(shell).toLowerCase();
    const markerStart = SHELL_PATH_MARKER_START;
    const markerEnd = SHELL_PATH_MARKER_END;
    const variants = [];

    if (shellName.includes('fish')) {
      const cmd = `printf '${markerStart}%s${markerEnd}' (string join ':' $PATH)`;
      variants.push(['-lc', cmd]);
      variants.push(['-ic', cmd]);
    } else {
      const cmd = `printf '${markerStart}%s${markerEnd}' "$PATH"`;
      variants.push(['-ilc', cmd]);
      variants.push(['-lc', cmd]);
      variants.push(['-ic', cmd]);
    }

    const tryNext = (index) => {
      if (index >= variants.length) {
        shellPathCache = null;
        shellPathCheckedAt = Date.now();
        shellPathPromise = null;
        resolve(null);
        return;
      }

      const args = variants[index];
      let settled = false;
      let stdout = '';
      let proc;
      const done = (value) => {
        if (settled) return;
        settled = true;
        shellPathPromise = null;
        resolve(value);
      };

      try {
        proc = spawn(shell, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: {
            ...process.env,
            TERM: 'dumb',
          },
        });
      } catch (_) {
        tryNext(index + 1);
        return;
      }

      const timer = setTimeout(() => {
        try { proc.kill(); } catch (_) { /* noop */ }
      }, timeoutMs);

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.on('error', () => {
        clearTimeout(timer);
        tryNext(index + 1);
      });

      proc.on('exit', () => {
        clearTimeout(timer);
        const extracted = extractMarkedValue(stdout, markerStart, markerEnd);
        const normalized = extracted ? extracted.trim() : '';
        if (normalized) {
          shellPathCache = normalized;
          shellPathCheckedAt = Date.now();
          done(shellPathCache);
          return;
        }
        tryNext(index + 1);
      });
    };

    tryNext(0);
  });

  return shellPathPromise;
}

function pathExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function findInPath(command, { allowWindowsAppStub = true } = {}) {
  const envPath = process.env.PATH || '';
  if (!envPath) return null;
  const pathExts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  const dirs = envPath.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of pathExts) {
      const fullPath = path.join(dir, `${command}${ext}`);
      if (!pathExists(fullPath)) continue;
      if (!allowWindowsAppStub && isWindowsAppStub(fullPath)) continue;
      return fullPath;
    }
  }
  return null;
}

function isWindowsAppStub(filePath) {
  if (!filePath) return false;
  const normalized = filePath.toLowerCase();
  return normalized.includes('\\windowsapps\\');
}

function resolveClaudePath() {
  const inPath = findInPath('claude');
  if (inPath) return inPath;
  for (const candidate of CLAUDE_FALLBACK_PATHS) {
    if (pathExists(candidate)) return candidate;
  }
  return null;
}

function checkCommand(cmd, args, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: 'ignore' });
    } catch (_) {
      done(false);
      return;
    }
    const timer = setTimeout(() => {
      if (proc && !proc.killed) {
        try { proc.kill(); } catch (_) { /* noop */ }
      }
      done(false);
    }, timeoutMs);
    proc.on('error', () => {
      clearTimeout(timer);
      done(false);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
  });
}

async function resolvePythonCommand() {
  if (process.platform === 'win32') {
    for (const candidate of PYTHON_CANDIDATES) {
      const resolved = findInPath(candidate.cmd, { allowWindowsAppStub: false });
      if (!resolved) continue;
      return { ...candidate, cmd: resolved };
    }
    return null;
  }

  for (const candidate of PYTHON_CANDIDATES) {
    const ok = await checkCommand(candidate.cmd, candidate.checkArgs);
    if (ok) return candidate;
  }

  return null;
}

class HistoryService {
  constructor({ userDataDir } = {}) {
    const basePath = __dirname.includes('app.asar')
      ? __dirname.replace('app.asar', 'app.asar.unpacked')
      : __dirname;
    this.userDataDir = userDataDir || path.join(os.tmpdir(), 'kawaii-terminal');
    this.depsCache = null;
    this.depsCheckedAt = 0;
    this.pythonCommand = null;
    this.pythonArgs = null;
    this.scriptPath = path.join(basePath, '../../scripts/claude-history-search.py');
    this.sources = createDefaultSources({ logger: logHistoryDebug });
    this.connectors = this.sources;
    this.repository = new HistoryRepository({
      connectors: this.connectors,
      cacheTtlMs: SESSION_INDEX_CACHE_TTL_MS,
      useMetaForCache: false,
      logger: logHistoryDebug,
    });
  }

  resetWslCaches() {
    resetWslCaches();
    if (this.sources) {
      for (const source of this.sources.values()) {
        if (typeof source?.resetCaches === 'function') {
          source.resetCaches();
        }
      }
    }
    if (this.repository) this.repository.resetCaches();
  }


  async keywordSearch({ query, source, project_path, project_dir, project_scope, limit, cursor, chunk_size } = {}) {
    const rawQuery = String(query || '').trim();
    if (!rawQuery) {
      return { mode: 'keyword', query: '', summary: 'Missing query', candidates: [] };
    }

    const max = Number.isFinite(limit) ? Math.max(1, Math.min(2000, limit)) : 400;
    const terms = normalizeSearchTerms(rawQuery);
    const normalized = String(source || 'all').trim().toLowerCase();
    if (!this.repository?.keywordSearch) {
      return { mode: 'keyword', query: rawQuery, summary: 'HistoryService not ready', candidates: [] };
    }
    return this.repository.keywordSearch({
      source: normalized,
      query: rawQuery,
      terms,
      limit: max,
      cursor,
      chunk_size,
      project_path,
      project_dir,
      project_scope,
    });
  }

  async keywordSearchClaude({ query, terms, project_path, project_dir, project_scope, limit, cursor, chunk_size } = {}) {
    if (this.repository?.keywordSearch) {
      return this.repository.keywordSearch({
        source: 'claude',
        query,
        terms,
        project_path,
        project_dir,
        project_scope,
        limit,
        cursor,
        chunk_size,
      });
    }
    const sourceImpl = this.sources?.get('claude');
    if (!sourceImpl?.keywordSearch) {
      return { mode: 'keyword', query, summary: 'Claude search unavailable.', candidates: [] };
    }
    return sourceImpl.keywordSearch({
      query,
      terms,
      project_path,
      project_dir,
      project_scope,
      limit,
      cursor,
      chunk_size,
    });
  }

  async keywordSearchCodex({ query, terms, limit, cursor, chunk_size } = {}) {
    if (this.repository?.keywordSearch) {
      return this.repository.keywordSearch({
        source: 'codex',
        query,
        terms,
        limit,
        cursor,
        chunk_size,
      });
    }
    const sourceImpl = this.sources?.get('codex');
    if (!sourceImpl?.keywordSearch) {
      return { mode: 'keyword', query, summary: 'Codex search unavailable.', candidates: [] };
    }
    return sourceImpl.keywordSearch({ query, terms, limit, cursor, chunk_size });
  }

  async keywordSearchAll({ query, terms, limit, cursor, chunk_size } = {}) {
    if (!this.repository?.keywordSearch) {
      return { mode: 'keyword', query, summary: 'HistoryService not ready', candidates: [] };
    }
    return this.repository.keywordSearch({
      source: 'all',
      query,
      terms,
      limit,
      cursor,
      chunk_size,
    });
  }

  async listClaudeProjects() {
    const source = this.sources?.get('claude');
    if (!source || typeof source.listProjects !== 'function') return { projects: [] };
    return source.listProjects();
  }

  async loadSessionSummaries({ limit = 200, source, cursor, chunk_size } = {}) {
    if (!this.repository?.listSessions) return { sessions: [] };
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : undefined;
    const safeCursor = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : undefined;
    const safeChunk = Number.isFinite(chunk_size) ? Math.max(1, Math.floor(chunk_size)) : undefined;
    return this.repository.listSessions({
      limit: safeLimit,
      source,
      cursor: safeCursor,
      chunk_size: safeChunk,
    });
  }

  async loadAllSessionSummaries({ limit = 200, cursor, chunk_size } = {}) {
    return this.loadSessionSummaries({
      limit,
      source: 'all',
      cursor,
      chunk_size,
    });
  }

  async loadClaudeSessionSummaries({ limit = 200, cursor, chunk_size } = {}) {
    return this.loadSessionSummaries({
      limit,
      source: 'claude',
      cursor,
      chunk_size,
    });
  }

  async loadCodexSessionSummaries({ limit = 200, cursor, chunk_size } = {}) {
    return this.loadSessionSummaries({
      limit,
      source: 'codex',
      cursor,
      chunk_size,
    });
  }

  async loadSessionEntries({ session_id, source, limit = 200, project_path, project_dir, source_path, load_all } = {}) {
    if (!this.repository?.loadSession) return { blocks: [], error: 'HistoryService not ready' };
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : undefined;
    return this.repository.loadSession({
      session_id,
      source,
      limit: safeLimit,
      project_path,
      project_dir,
      source_path,
      load_all,
    });
  }

  async loadClaudeSessionEntries({ sessionId, limit = 200, project_path, project_dir, source_path, load_all } = {}) {
    return this.loadSessionEntries({
      session_id: sessionId,
      source: 'claude',
      limit,
      project_path,
      project_dir,
      source_path,
      load_all,
    });
  }

  async loadCodexSessionEntries({ sessionId, limit = 200, source_path, load_all } = {}) {
    return this.loadSessionEntries({
      session_id: sessionId,
      source: 'codex',
      limit,
      source_path,
      load_all,
    });
  }

  async loadClaudeRecent({ project_path, project_dir, project_scope, limit = 200 } = {}) {
    if (this.repository?.loadRecent) {
      return this.repository.loadRecent({
        source: 'claude',
        limit,
        project_path,
        project_dir,
        project_scope,
      });
    }
    const source = this.sources?.get('claude');
    if (!source || typeof source.loadRecent !== 'function') return { blocks: [] };
    return source.loadRecent({ project_path, project_dir, project_scope, limit });
  }

  async loadCodexRecent({ limit = 200 } = {}) {
    if (this.repository?.loadRecent) {
      return this.repository.loadRecent({ source: 'codex', limit });
    }
    const source = this.sources?.get('codex');
    if (!source || typeof source.loadRecent !== 'function') return { blocks: [] };
    return source.loadRecent({ limit });
  }

  async loadAllRecent({ limit = 200, project_path, project_dir } = {}) {
    if (!this.repository?.loadRecent) {
      return { blocks: [], error: 'HistoryService not ready' };
    }
    return this.repository.loadRecent({ source: 'all', limit, project_path, project_dir });
  }

  async loadRecent({ limit = 200, source, project_path, project_dir } = {}) {
    if (!this.repository?.loadRecent) {
      return { blocks: [], error: 'HistoryService not ready' };
    }
    const normalized = String(source || 'all').trim().toLowerCase();
    if (normalized === 'claude') {
      return this.repository.loadRecent({
        source: 'claude',
        limit,
        project_path,
        project_dir,
        project_scope: 'all',
      });
    }
    if (normalized === 'codex') {
      return this.repository.loadRecent({ source: 'codex', limit });
    }
    if (normalized === 'all') {
      return this.repository.loadRecent({ source: 'all', limit, project_path, project_dir });
    }
    return { blocks: [], error: 'Unsupported source' };
  }

  async getHistoryMeta({ source } = {}) {
    if (!this.repository?.getMeta) return { signature: '' };
    return this.repository.getMeta({ source });
  }

  async findBlocksById({ ids, source, project_path, project_dir } = {}) {
    const normalized = String(source || '').trim().toLowerCase();
    if (normalized === 'claude') {
      const sourceImpl = this.sources?.get('claude');
      if (!sourceImpl?.findBlocksById) return { blocks: [] };
      return sourceImpl.findBlocksById({ ids, project_path, project_dir });
    }

    if (normalized === 'codex') {
      const sourceImpl = this.sources?.get('codex');
      if (!sourceImpl?.findBlocksById) return { blocks: [] };
      return sourceImpl.findBlocksById({ ids });
    }

    if (normalized === 'all') {
      const [claude, codex] = await Promise.all([
        this.findBlocksById({ ids, source: 'claude', project_path, project_dir }),
        this.findBlocksById({ ids, source: 'codex' }),
      ]);
      const blocks = [...(claude?.blocks || []), ...(codex?.blocks || [])];
      return { blocks };
    }

    return { blocks: [] };
  }

  async checkDependencies({ refresh = false } = {}) {
    ensureMacGuiPath();
    const now = Date.now();
    if (!refresh && this.depsCache && now - this.depsCheckedAt < DEP_CHECK_CACHE_MS) {
      return this.depsCache;
    }

    let pythonCandidate = await resolvePythonCommand();
    let claudePath = resolveClaudePath();
    if (process.platform === 'darwin' && (!pythonCandidate || !claudePath)) {
      const shellPath = await resolvePathFromUserShell();
      if (shellPath) {
        process.env.PATH = mergePathStrings(shellPath, process.env.PATH);
        if (!pythonCandidate) {
          pythonCandidate = await resolvePythonCommand();
        }
        if (!claudePath) {
          claudePath = resolveClaudePath();
        }
      }
    }
    const pythonOk = Boolean(pythonCandidate);
    const claudeOk = Boolean(claudePath);
    const missing = [];
    if (!pythonOk) missing.push('python');
    if (!claudeOk) missing.push('claude');

    if (pythonCandidate) {
      this.pythonCommand = pythonCandidate.cmd;
      this.pythonArgs = pythonCandidate.runArgs || [];
    }

    this.depsCache = {
      available: pythonOk && claudeOk,
      missing,
      python: pythonCandidate
        ? { ok: true, command: pythonCandidate.cmd, args: pythonCandidate.runArgs || [] }
        : { ok: false },
      claude: claudeOk
        ? { ok: true, path: claudePath }
        : { ok: false, path: null },
    };
    this.depsCheckedAt = now;
    return this.depsCache;
  }

  async search(payload = {}) {
    const {
      query,
      blocks,
      mode,
      source,
      project_path,
      project_dir,
      project_scope,
      pane_id,
      limit,
      cursor,
      chunk_size,
    } = payload || {};
    if (!query) return { error: 'Missing query' };
    // Default: keyword search (scan Claude/Codex history).
    // To force the legacy LLM-based search, set mode: 'llm' and provide blocks.
    if (mode !== 'llm') {
      return this.keywordSearch({
        query,
        source,
        project_path,
        project_dir,
        project_scope,
        pane_id,
        limit,
        cursor,
        chunk_size,
      });
    }

    const deps = await this.checkDependencies();
    if (!deps.available) {
      return { unavailable: true, missing: deps.missing };
    }
    const pythonPayload = {
      mode: 'search',
      query,
      blocks: Array.isArray(blocks) ? blocks : [],
    };
    return this.runPython(pythonPayload);
  }

  async deepSearch({ query, source, project_path } = {}) {
    if (!query) return { error: 'Missing query' };
    const deps = await this.checkDependencies();
    if (!deps.available) {
      return { unavailable: true, missing: deps.missing };
    }
    if (source === 'claude') {
      await ensureWslHomesLoaded();
      const projectPath = typeof project_path === 'string' ? project_path.trim() : '';
      const projectDir = resolveClaudeProjectDir(projectPath);
      if (!projectDir || !pathExists(projectDir)) {
        return { error: 'Claude project logs not found' };
      }
      const payload = {
        mode: 'deepsearch',
        query,
        folder_path: projectDir,
        source: 'claude',
        project_path: projectPath,
      };
      return this.runPython(payload);
    }

    return { error: 'DeepSearch unavailable for this source.' };
  }

  runPython(payload) {
    return new Promise((resolve) => {
      let settled = false;
      let timeoutId = null;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        resolve(result);
      };

      const options = {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
        },
      };

      if (process.platform === 'win32') {
        options.windowsHide = true;
      }

      const pythonCmd = this.pythonCommand || (process.platform === 'win32' ? 'python' : 'python3');
      const pythonArgs = this.pythonArgs || [];
      let proc;
      try {
        proc = spawn(pythonCmd, [...pythonArgs, '-u', this.scriptPath], options);
      } catch (e) {
        settle({ error: e?.message || 'Failed to start Python' });
        return;
      }

      const inputData = JSON.stringify(payload);
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        const trimmedStdout = stdout.trim();
        if (code !== 0) {
          if (trimmedStdout) {
            try {
              const errorResult = JSON.parse(trimmedStdout);
              settle(errorResult);
              return;
            } catch (_) {
              // fall through
            }
          }
          settle({ error: stderr.trim() || trimmedStdout || 'Python script failed' });
          return;
        }

        try {
          const result = JSON.parse(trimmedStdout);
          settle(result);
        } catch (e) {
          settle({ error: 'Invalid response' });
        }
      });

      proc.on('error', (error) => {
        settle({ error: error?.message || 'Spawn error' });
      });

      try {
        proc.stdin?.write?.(inputData);
        proc.stdin?.end?.();
      } catch (e) {
        try { proc.kill(); } catch (_) { /* noop */ }
        settle({ error: e?.message || 'Failed to write stdin' });
      }

      if (HISTORY_TIMEOUT_MS > 0) {
        timeoutId = setTimeout(() => {
          try {
            if (proc && proc.exitCode == null && !proc.killed) {
              proc.kill();
            }
          } catch (_) { /* noop */ }
          settle({ error: 'Timeout' });
        }, HISTORY_TIMEOUT_MS);
      }
    });
  }
}

module.exports = HistoryService;
