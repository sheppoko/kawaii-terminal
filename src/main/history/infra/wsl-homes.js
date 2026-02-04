const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const { findInPath, pathExists } = require('../../infra/path/path-utils');
const { sanitizeFsSegment } = require('./wsl-utils');

const WSL_SHARE_ROOTS = ['\\\\wsl$', '\\\\wsl.localhost'];
const WSL_SCAN_CACHE_MS = 60_000;
const WSL_EXEC_TIMEOUT_MS = 4000;
const WSL_DISABLE_ENV = [
  'KAWAII_DISABLE_WSL_SCAN',
  'KAWAII_DISABLE_WSL_HISTORY',
  'KAWAII_DISABLE_WSL',
];

let wslDistroCache = { list: [], fetchedAt: 0, pending: null };
let wslHomeCache = { list: [], fetchedAt: 0, pending: null };
let logWsl = () => {};

function setWslLogger(logger) {
  logWsl = typeof logger === 'function' ? logger : () => {};
}

function isTruthyEnv(value) {
  if (value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return false;
  return !['0', 'false', 'no', 'off'].includes(normalized);
}

function shouldSkipWslScan() {
  for (const key of WSL_DISABLE_ENV) {
    if (isTruthyEnv(process.env[key])) return true;
  }
  return false;
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

function execFileText(command, args, { timeout = 1000 } = {}) {
  return new Promise((resolve) => {
    if (!command) {
      resolve('');
      return;
    }
    execFile(command, args, {
      encoding: 'buffer',
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error) {
        logWsl('execFileText error', {
          command,
          args,
          message: error.message,
          code: error.code,
          signal: error.signal,
          killed: error.killed,
        });
        resolve('');
        return;
      }
      resolve(decodeCommandOutput(stdout));
    });
  });
}

function resolveWslExe() {
  if (process.platform !== 'win32') return null;
  const windir = process.env.WINDIR || 'C:\\Windows';
  const systemPath = path.join(windir, 'System32', 'wsl.exe');
  if (pathExists(systemPath)) return systemPath;
  const inPath = findInPath('wsl', { allowWindowsAppStub: false });
  return inPath || null;
}

async function listSubDirectories(dirPath) {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter(entry => entry?.isDirectory?.())
      .map(entry => sanitizeFsSegment(entry.name))
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

async function pathExistsAsync(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

async function listWslShareDistros(shareRoot) {
  if (!shareRoot) return [];
  try {
    const entries = await fs.promises.readdir(shareRoot, { withFileTypes: true });
    return entries
      .filter(entry => entry?.isDirectory?.())
      .map(entry => sanitizeFsSegment(entry.name))
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

async function listWslDistros() {
  if (process.platform !== 'win32') return [];
  if (shouldSkipWslScan()) return [];
  const now = Date.now();
  if (wslDistroCache.fetchedAt && now - wslDistroCache.fetchedAt < WSL_SCAN_CACHE_MS) {
    return wslDistroCache.list;
  }
  if (wslDistroCache.pending) return wslDistroCache.pending;

  wslDistroCache.pending = (async () => {
    const nameMap = new Map();
    const add = (name, root) => {
      const cleaned = sanitizeFsSegment(name);
      if (!cleaned) return;
      if (!nameMap.has(cleaned)) {
        nameMap.set(cleaned, root || '');
      } else if (root && !nameMap.get(cleaned)) {
        nameMap.set(cleaned, root);
      }
    };

    const wslExe = resolveWslExe();
    if (wslExe) {
      const stdout = await execFileText(wslExe, ['-l', '-q'], { timeout: WSL_EXEC_TIMEOUT_MS });
      const rawList = String(stdout || '').split(/\r?\n/).map((line) => sanitizeFsSegment(line)).filter(Boolean);
      logWsl('listWslDistros wsl.exe', { wslExe, rawList });
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const name = sanitizeFsSegment(line);
        if (!name) continue;
        if (/wsl\//i.test(name)) continue;
        add(name, '');
      }
    }

    for (const root of WSL_SHARE_ROOTS) {
      const shareList = await listWslShareDistros(root);
      logWsl('listWslDistros share', { root, count: shareList.length });
      for (const name of shareList) {
        add(name, root);
      }
    }

    const accessibleRoots = WSL_SHARE_ROOTS.filter((root) => {
      try {
        return fs.existsSync(root);
      } catch (_) {
        return false;
      }
    });
    logWsl('listWslDistros roots', { accessibleRoots });
    const fallbackRoot = accessibleRoots[0] || WSL_SHARE_ROOTS[0];
    const distros = Array.from(nameMap.entries()).map(([name, root]) => ({
      name,
      root: root || fallbackRoot,
    }));
    logWsl('listWslDistros result', { count: distros.length, distros });

    if (distros.length > 0) {
      wslDistroCache.list = distros;
      wslDistroCache.fetchedAt = Date.now();
    } else {
      wslDistroCache.list = [];
      wslDistroCache.fetchedAt = 0;
    }
    wslDistroCache.pending = null;
    return distros;
  })();

  return wslDistroCache.pending;
}

async function listWslHomes() {
  if (process.platform !== 'win32') return [];
  if (shouldSkipWslScan()) return [];
  const now = Date.now();
  if (wslHomeCache.fetchedAt && now - wslHomeCache.fetchedAt < WSL_SCAN_CACHE_MS) {
    return wslHomeCache.list;
  }
  if (wslHomeCache.pending) return wslHomeCache.pending;

  wslHomeCache.pending = (async () => {
    const distros = await listWslDistros();
    const homes = new Set();
    const accessibleRoots = WSL_SHARE_ROOTS.filter((root) => {
      try {
        return fs.existsSync(root);
      } catch (_) {
        return false;
      }
    });
    logWsl('listWslHomes roots', { distros: distros.map(d => d.name), accessibleRoots });

    for (const distro of distros) {
      if (!distro?.name) continue;
      const rootsToTry = [];
      if (distro.root) rootsToTry.push(distro.root);
      for (const root of accessibleRoots) {
        if (root && !rootsToTry.includes(root)) rootsToTry.push(root);
      }
      if (rootsToTry.length === 0) rootsToTry.push(WSL_SHARE_ROOTS[0]);

      for (const root of rootsToTry) {
        const distroRoot = path.join(root, distro.name);
        const homeRoot = path.join(distroRoot, 'home');
        const rootHome = path.join(distroRoot, 'root');

        const users = await listSubDirectories(homeRoot);
        logWsl('listWslHomes scan', { distro: distro.name, root, users });
        for (const user of users) {
          if (!user) continue;
          homes.add(path.join(homeRoot, user));
        }

        if (await pathExistsAsync(rootHome)) {
          logWsl('listWslHomes rootHome', { distro: distro.name, rootHome });
          homes.add(rootHome);
        }
      }
    }

    const list = Array.from(homes);
    logWsl('listWslHomes result', { count: list.length, list });
    if (list.length > 0) {
      wslHomeCache.list = list;
      wslHomeCache.fetchedAt = Date.now();
    } else {
      wslHomeCache.list = [];
      wslHomeCache.fetchedAt = 0;
    }
    wslHomeCache.pending = null;
    return list;
  })();

  return wslHomeCache.pending;
}

function getCachedWslHomes() {
  if (shouldSkipWslScan()) return [];
  return Array.isArray(wslHomeCache.list) ? wslHomeCache.list : [];
}

async function ensureWslHomesLoaded() {
  if (process.platform !== 'win32') return;
  if (shouldSkipWslScan()) return;
  await listWslHomes();
}

function resetWslCaches() {
  wslDistroCache = { list: [], fetchedAt: 0, pending: null };
  wslHomeCache = { list: [], fetchedAt: 0, pending: null };
}

module.exports = {
  ensureWslHomesLoaded,
  getCachedWslHomes,
  listWslDistros,
  listWslHomes,
  resetWslCaches,
  resolveWslExe,
  setWslLogger,
  WSL_SHARE_ROOTS,
};
