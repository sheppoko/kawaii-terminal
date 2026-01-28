const fs = require('fs');
const os = require('os');
const path = require('path');

function pathExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
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

function resolveHomePath(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('~')) {
    return path.join(os.homedir(), raw.slice(1));
  }
  return raw;
}

function isPathInside(candidate, root) {
  if (!candidate || !root) return false;
  const rel = path.relative(root, candidate);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isPathInRoots(candidate, roots) {
  if (!candidate) return false;
  for (const root of roots || []) {
    if (isPathInside(candidate, root)) return true;
  }
  return false;
}

module.exports = {
  isPathInRoots,
  pathExists,
  pathExistsAsync,
  resolveHomePath,
};
