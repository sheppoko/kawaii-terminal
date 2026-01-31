const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const {
  DEFAULT_SETTINGS,
  deepClone,
  deepMerge,
  normalizeSettings,
} = require('./settings-schema');

const isPlainObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value);

function ensureDir(dirPath) {
  if (!dirPath) return;
  fs.mkdirSync(dirPath, { recursive: true });
}

function atomicWriteFile(targetPath, content) {
  const dir = path.dirname(targetPath);
  ensureDir(dir);
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, content, { encoding: 'utf8' });
  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (_) {
    try {
      fs.copyFileSync(tmpPath, targetPath);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (_) { /* noop */ }
    }
  }
}

class SettingsStore extends EventEmitter {
  constructor({ userDataDir, filename = 'settings.json' } = {}) {
    super();
    this.userDataDir = userDataDir || process.cwd();
    this.filePath = path.join(this.userDataDir, filename);
    this.data = deepClone(DEFAULT_SETTINGS);
    this.loaded = false;
  }

  load() {
    if (this.loaded) return this.get();
    let parsed = null;
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        if (raw && raw.trim()) {
          parsed = JSON.parse(raw);
        }
      }
    } catch (error) {
      console.error('[Settings] Failed to load settings:', error?.message || error);
    }
    this.data = normalizeSettings(parsed);
    this.loaded = true;
    return this.get();
  }

  get() {
    if (!this.loaded) this.load();
    return deepClone(this.data);
  }

  update(patch, { source = 'unknown' } = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: 'Invalid settings patch', settings: this.get() };
    }
    const base = deepClone(this.data);
    if (isPlainObject(patch.shortcuts)) {
      base.shortcuts = deepClone(DEFAULT_SETTINGS.shortcuts);
    }
    const merged = normalizeSettings(deepMerge(base, patch));
    this.data = merged;
    this.loaded = true;
    this.flush();
    const payload = { settings: this.get(), patch: deepClone(patch), source };
    this.emit('change', payload);
    return { ok: true, settings: payload.settings };
  }

  flush() {
    const content = `${JSON.stringify(this.data, null, 2)}\n`;
    atomicWriteFile(this.filePath, content);
  }
}

module.exports = {
  SettingsStore,
};
