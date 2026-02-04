const { execFile, spawn } = require('child_process');
const os = require('os');
const path = require('path');

const { listWslDistros, resolveWslExe } = require('../../history/infra/wsl-homes');
const { findInPath, pathExists } = require('../path/path-utils');

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

const SHELL_PATH_CACHE_MS = 60_000;
const SHELL_PATH_TIMEOUT_MS = 1800;
const SHELL_PATH_MARKER_START = '__KAWAII_TERMINAL_PATH_START__';
const SHELL_PATH_MARKER_END = '__KAWAII_TERMINAL_PATH_END__';

let shellPathCache = null;
let shellPathCheckedAt = 0;
let shellPathPromise = null;

function getUserShell() {
  const envShell = String(process.env.SHELL || '').trim();
  if (envShell) return envShell;
  try {
    const info = os.userInfo();
    const shell = String(info?.shell || '').trim();
    if (shell) return shell;
  } catch (_) {
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
    path.join(os.homedir(), '.codex', 'bin'),
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

function decodeCommandOutput(output) {
  if (typeof output === 'string') return output.replace(/^\uFEFF/, '');
  if (!Buffer.isBuffer(output)) return String(output);
  if (!output.length) return '';
  let zeroCount = 0;
  for (const byte of output) {
    if (byte === 0) zeroCount += 1;
  }
  const likelyUtf16 = zeroCount > Math.max(2, Math.floor(output.length / 4));
  let text = output.toString(likelyUtf16 ? 'utf16le' : 'utf8');
  if (!likelyUtf16 && text.includes('\u0000')) {
    // eslint-disable-next-line no-control-regex
    text = text.replace(/\u0000/g, '');
  }
  return text.replace(/^\uFEFF/, '');
}

function execFileText(command, args, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    if (!command) {
      resolve('');
      return;
    }
    execFile(command, args, {
      encoding: 'buffer',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error) {
        resolve('');
        return;
      }
      resolve(decodeCommandOutput(stdout));
    });
  });
}

class AgentCliDetector {
  constructor({
    cacheMs = 5000,
    shellPathTimeoutMs = SHELL_PATH_TIMEOUT_MS,
  } = {}) {
    this.cacheMs = cacheMs;
    this.shellPathTimeoutMs = shellPathTimeoutMs;
    this.localCache = new Map();
    this.wslCache = new Map();
  }

  async resolveLocal(command, { fallbackPaths = [], refresh = false, allowWindowsAppStub = false } = {}) {
    const key = String(command || '').trim().toLowerCase();
    if (!key) return null;
    const cached = this.localCache.get(key);
    const now = Date.now();
    if (!refresh && cached && now - cached.checkedAt < this.cacheMs) {
      return cached.path;
    }

    ensureMacGuiPath();
    let resolved = findInPath(command, { allowWindowsAppStub });
    if (!resolved && process.platform === 'darwin') {
      const shellPath = await resolvePathFromUserShell(this.shellPathTimeoutMs);
      if (shellPath) {
        process.env.PATH = mergePathStrings(shellPath, process.env.PATH);
        resolved = findInPath(command, { allowWindowsAppStub });
      }
    }
    if (!resolved && Array.isArray(fallbackPaths)) {
      for (const candidate of fallbackPaths) {
        if (pathExists(candidate)) {
          resolved = candidate;
          break;
        }
      }
    }

    this.localCache.set(key, { path: resolved || null, checkedAt: now });
    return resolved || null;
  }

  async detectLocal(command, opts = {}) {
    const pathValue = await this.resolveLocal(command, opts);
    return {
      present: Boolean(pathValue),
      path: pathValue || null,
    };
  }

  async detectWsl(command, { refresh = false, timeoutMs = 1500 } = {}) {
    const key = String(command || '').trim().toLowerCase();
    if (!key || process.platform !== 'win32') {
      return { present: false, distros: [] };
    }

    const cached = this.wslCache.get(key);
    const now = Date.now();
    if (!refresh && cached && now - cached.checkedAt < this.cacheMs) {
      return cached.value;
    }

    const wslExe = resolveWslExe();
    if (!wslExe) {
      const value = { present: false, distros: [] };
      this.wslCache.set(key, { value, checkedAt: now });
      return value;
    }

    const distros = await listWslDistros();
    const items = [];
    for (const distro of distros || []) {
      const name = typeof distro === 'string' ? distro : distro?.name;
      if (!name) continue;
      const args = ['-d', name, '--', 'sh', '-lc', `command -v ${key}`];
      const stdout = await execFileText(wslExe, args, { timeoutMs });
      const resolved = String(stdout || '').trim();
      if (resolved) {
        items.push({ name, path: resolved });
      }
    }

    const value = { present: items.length > 0, distros: items };
    this.wslCache.set(key, { value, checkedAt: now });
    return value;
  }
}

function getClaudeFallbackPaths() {
  return CLAUDE_FALLBACK_PATHS.slice();
}

module.exports = {
  AgentCliDetector,
  getClaudeFallbackPaths,
};
