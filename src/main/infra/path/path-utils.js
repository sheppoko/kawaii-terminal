const fs = require('fs');
const path = require('path');

function pathExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function isWindowsAppStub(filePath) {
  if (!filePath) return false;
  const normalized = filePath.toLowerCase();
  return normalized.includes('\\windowsapps\\');
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

module.exports = {
  findInPath,
  isWindowsAppStub,
  pathExists,
};
