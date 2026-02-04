const fs = require('fs');
const path = require('path');

const KEEP_LOCALES_MAC = new Set(['en.lproj', 'ja.lproj']);
const KEEP_LOCALES_WIN = new Set(['en-US.pak', 'ja.pak']);

const isDir = (entry) => entry && entry.isDirectory && entry.isDirectory();

const removeDir = async (target) => {
  await fs.promises.rm(target, { recursive: true, force: true });
};

const pruneMacLocales = async (rootDir) => {
  const stack = [rootDir];
  let removed = 0;

  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch (err) {
      console.warn(`skip: ${current} (${err.message})`);
      continue;
    }

    for (const entry of entries) {
      if (!isDir(entry)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.name.endsWith('.lproj')) {
        if (!KEEP_LOCALES_MAC.has(entry.name)) {
          await removeDir(fullPath);
          removed += 1;
        }
        continue;
      }
      stack.push(fullPath);
    }
  }

  return removed;
};

const pruneWinLocales = async (localesDir) => {
  let removed = 0;
  let entries;
  try {
    entries = await fs.promises.readdir(localesDir, { withFileTypes: true });
  } catch (err) {
    console.warn(`Prune locales: skip ${localesDir} (${err.message})`);
    return removed;
  }

  for (const entry of entries) {
    if (!entry.isFile || !entry.isFile()) continue;
    if (!entry.name.endsWith('.pak')) continue;
    if (KEEP_LOCALES_WIN.has(entry.name)) continue;
    await fs.promises.rm(path.join(localesDir, entry.name), { force: true });
    removed += 1;
  }

  return removed;
};

module.exports = async (context = {}) => {
  if (!context.appOutDir) {
    console.warn('Prune locales: missing appOutDir');
    return;
  }

  if (context.electronPlatformName === 'darwin') {
    const productFilename = context.packager && context.packager.appInfo
      ? context.packager.appInfo.productFilename
      : null;
    if (!productFilename) {
      console.warn('Prune locales: missing productFilename');
      return;
    }

    const appPath = path.join(context.appOutDir, `${productFilename}.app`);
    const contentsPath = path.join(appPath, 'Contents');

    try {
      const removed = await pruneMacLocales(contentsPath);
      console.log(`Prune locales (mac): removed ${removed} directories`);
    } catch (err) {
      console.error(`Prune locales (mac) failed: ${err.message}`);
      throw err;
    }
    return;
  }

  if (context.electronPlatformName === 'win32') {
    const localesDir = path.join(context.appOutDir, 'locales');
    try {
      const removed = await pruneWinLocales(localesDir);
      console.log(`Prune locales (win): removed ${removed} files`);
    } catch (err) {
      console.error(`Prune locales (win) failed: ${err.message}`);
      throw err;
    }
    return;
  }

  console.log('Prune locales: skipped (unsupported platform)');
};
