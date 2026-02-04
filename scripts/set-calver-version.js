const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');

const readJson = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
};

const writeJson = (filePath, data) => {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

const now = new Date();
const year = now.getFullYear();
const month = now.getMonth() + 1;
const day = now.getDate();

const base = `${year}.${month}.${day}`;
const versionPattern = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-alpha\.(\d+))?$/;

const pkg = readJson(pkgPath);
if (!pkg) {
  console.error('Failed to read package.json');
  process.exit(1);
}

let alpha = 1;
const current = typeof pkg.version === 'string' ? pkg.version.trim() : '';
const match = versionPattern.exec(current);
if (match) {
  const currentBase = `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
  if (currentBase === base) {
    const currentAlpha = Number.parseInt(match[4] || '0', 10);
    alpha = currentAlpha + 1;
  }
}

const nextVersion = `${base}-alpha.${alpha}`;
pkg.version = nextVersion;
writeJson(pkgPath, pkg);

const lock = readJson(lockPath);
if (lock) {
  lock.version = nextVersion;
  if (lock.packages && lock.packages['']) {
    lock.packages[''].version = nextVersion;
  }
  writeJson(lockPath, lock);
}

console.log(`Version set to ${nextVersion}`);
