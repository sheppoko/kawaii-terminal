const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  listClaudeConfigRoots,
  listCodexConfigRoots,
} = require('../path/agent-paths');
const { listWslHomes, getCachedWslHomes } = require('../../history/infra/wsl-homes');

const CODEX_SESSIONS_DIRNAME = 'sessions';

function pathExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (_) {
    return false;
  }
}

function unique(list) {
  const out = [];
  const seen = new Set();
  for (const item of list || []) {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function filterExisting(paths) {
  return unique(paths).filter(pathExists);
}

function listLocalClaudeRoots({ includeAppData = true } = {}) {
  const roots = listClaudeConfigRoots({
    home: os.homedir(),
    env: process.env,
    includeAppData,
  });
  return filterExisting(roots);
}

function listLocalCodexRoots({ includeMissing = false } = {}) {
  const roots = listCodexConfigRoots({ home: os.homedir(), env: process.env });
  return includeMissing ? unique(roots) : filterExisting(roots);
}

function buildWslRootsFromHomes(homes, dirname, extraCheckDir) {
  const roots = [];
  for (const home of homes || []) {
    const base = path.join(home, dirname);
    if (pathExists(base)) {
      roots.push(base);
      continue;
    }
    if (extraCheckDir && pathExists(path.join(base, extraCheckDir))) {
      roots.push(base);
    }
  }
  return unique(roots);
}

async function listWslClaudeRoots() {
  if (process.platform !== 'win32') return [];
  const homes = await listWslHomes();
  return buildWslRootsFromHomes(homes, '.claude', 'projects');
}

async function listWslCodexRoots() {
  if (process.platform !== 'win32') return [];
  const homes = await listWslHomes();
  return buildWslRootsFromHomes(homes, '.codex', CODEX_SESSIONS_DIRNAME);
}

function listWslClaudeRootsSync() {
  if (process.platform !== 'win32') return [];
  const homes = getCachedWslHomes();
  return buildWslRootsFromHomes(homes, '.claude', 'projects');
}

function listWslCodexRootsSync() {
  if (process.platform !== 'win32') return [];
  const homes = getCachedWslHomes();
  return buildWslRootsFromHomes(homes, '.codex', CODEX_SESSIONS_DIRNAME);
}

async function listClaudeRoots() {
  const wslRoots = await listWslClaudeRoots();
  return unique([...listLocalClaudeRoots(), ...wslRoots]);
}

async function listCodexRoots() {
  const wslRoots = await listWslCodexRoots();
  return unique([...listLocalCodexRoots(), ...wslRoots]);
}

module.exports = {
  listClaudeRoots,
  listCodexRoots,
  listLocalClaudeRoots,
  listLocalCodexRoots,
  listWslClaudeRoots,
  listWslCodexRoots,
  listWslClaudeRootsSync,
  listWslCodexRootsSync,
};
