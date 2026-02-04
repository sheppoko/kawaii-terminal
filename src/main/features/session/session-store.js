const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WORKSPACE_FILENAME = 'workspace.json';
const WORKSPACE_PREVIOUS_FILENAME = 'workspace.previous.json';
const SNAPSHOTS_DIRNAME = 'snapshots';

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function ensureDir(dirPath) {
  if (!dirPath) return;
  fs.mkdirSync(dirPath, { recursive: true });
}

async function ensureDirAsync(dirPath) {
  if (!dirPath) return;
  await fs.promises.mkdir(dirPath, { recursive: true });
}

function sanitizeIdForFilename(value) {
  const raw = String(value || '').trim();
  if (!raw) return crypto.randomUUID();
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_');
  const safe = cleaned.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe.slice(0, 160) || crypto.randomUUID();
}

function atomicWriteFile(targetPath, content, { encoding = 'utf8' } = {}) {
  const dir = path.dirname(targetPath);
  ensureDir(dir);
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, content, { encoding });
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

async function atomicWriteFileAsync(targetPath, content, { encoding = 'utf8', shouldCommit } = {}) {
  const dir = path.dirname(targetPath);
  await ensureDirAsync(dir);
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmpPath, content, { encoding });
  if (typeof shouldCommit === 'function') {
    let ok = false;
    try {
      const result = shouldCommit();
      ok = result && typeof result.then === 'function' ? await result : Boolean(result);
    } catch (_) {
      ok = false;
    }
    if (!ok) {
      try { await fs.promises.unlink(tmpPath); } catch (_) { /* noop */ }
      return false;
    }
  }
  try {
    await fs.promises.rename(tmpPath, targetPath);
  } catch (_) {
    try {
      await fs.promises.copyFile(tmpPath, targetPath);
    } finally {
      try { await fs.promises.unlink(tmpPath); } catch (_) { /* noop */ }
    }
  }
}

function rmDirSyncSafe(dirPath) {
  if (!dirPath) return false;
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
    return true;
  } catch (_) {
    try {
      fs.rmdirSync(dirPath, { recursive: true });
      return true;
    } catch (_) {
      return false;
    }
  }
}

function defaultWorkspaceState() {
  return {
    version: 1,
    savedAt: null,
    lastShutdown: {
      clean: true,
      crashStreak: 0,
      lastStartAt: null,
      lastExitAt: null,
      appVersion: null,
    },
    snapshot: {
      enabled: true,
      intervalMs: 30_000,
      maxLinesPerPane: 500,
      maxCharsPerPane: 200_000,
      maxTotalChars: 8_000_000,
    },
    lastActiveWindowKey: null,
    windows: [],
  };
}

function normalizeBounds(bounds) {
  if (!bounds) return null;
  const next = {};
  if (Number.isFinite(bounds.x)) next.x = Math.round(bounds.x);
  if (Number.isFinite(bounds.y)) next.y = Math.round(bounds.y);
  if (Number.isFinite(bounds.width)) next.width = Math.max(400, Math.round(bounds.width));
  if (Number.isFinite(bounds.height)) next.height = Math.max(300, Math.round(bounds.height));
  return Object.keys(next).length ? next : null;
}

function countWorkspaceSummary(workspace) {
  const windows = Array.isArray(workspace?.windows) ? workspace.windows : [];
  let tabCount = 0;
  let paneCount = 0;
  for (const win of windows) {
    const tabs = Array.isArray(win?.tabs) ? win.tabs : [];
    tabCount += tabs.length;
    for (const tab of tabs) {
      const panes = Array.isArray(tab?.panes) ? tab.panes : [];
      paneCount += panes.length;
    }
  }
  return {
    windows: windows.length,
    tabs: tabCount,
    panes: paneCount,
  };
}

class SessionStore {
  constructor({ userDataDir } = {}) {
    const baseDir = path.join(userDataDir || process.cwd(), 'session');
    this.baseDir = baseDir;
    this.workspacePath = path.join(baseDir, WORKSPACE_FILENAME);
    this.workspacePreviousPath = path.join(baseDir, WORKSPACE_PREVIOUS_FILENAME);
    this.snapshotsDir = path.join(baseDir, SNAPSHOTS_DIRNAME);
    this.workspace = defaultWorkspaceState();
    this._prevCleanExit = true;
    this._flushTimer = null;
    this._flushPromise = null;
    this._flushSeq = 0;
    this._flushBarrier = 0;
  }

  load() {
    ensureDir(this.baseDir);
    ensureDir(this.snapshotsDir);
    if (fs.existsSync(this.workspacePath)) {
      const raw = fs.readFileSync(this.workspacePath, 'utf8');
      const parsed = safeJsonParse(raw);
      if (parsed && typeof parsed === 'object') {
        this.workspace = { ...defaultWorkspaceState(), ...parsed };
      }
    }
    this._prevCleanExit = Boolean(this.workspace?.lastShutdown?.clean);
    return this.workspace;
  }

  getPreviousExitInfo() {
    return {
      clean: Boolean(this._prevCleanExit),
      crashStreak: Number(this.workspace?.lastShutdown?.crashStreak) || 0,
    };
  }

  markStartup({ appVersion } = {}) {
    const last = this.workspace.lastShutdown || {};
    const prevClean = Boolean(last.clean);
    const prevStreak = Number(last.crashStreak) || 0;
    const crashStreak = prevClean ? 0 : Math.min(10, prevStreak + 1);
    this.workspace.lastShutdown = {
      clean: false,
      crashStreak,
      lastStartAt: nowIso(),
      lastExitAt: last.lastExitAt || null,
      appVersion: appVersion || last.appVersion || null,
    };
    this.workspace.savedAt = nowIso();
    this.flushSync();
  }

  async markCleanExit({ appVersion } = {}) {
    const last = this.workspace.lastShutdown || {};
    this.workspace.lastShutdown = {
      ...last,
      clean: true,
      crashStreak: 0,
      lastExitAt: nowIso(),
      appVersion: appVersion || last.appVersion || null,
    };
    this.workspace.savedAt = nowIso();
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    // Ensure any in-flight async flush finishes before the clean-exit write.
    const pending = this._flushPromise;
    if (pending) {
      try {
        await pending;
      } catch (_) {
        // ignore
      }
    }
    this.flushSync();
  }

  getSummary() {
    return countWorkspaceSummary(this.workspace);
  }

  hasRestorableSession() {
    return Array.isArray(this.workspace?.windows) && this.workspace.windows.length > 0;
  }

  ensureWindow(windowKey) {
    if (!windowKey) return null;
    if (!Array.isArray(this.workspace.windows)) this.workspace.windows = [];
    let entry = this.workspace.windows.find((w) => w && w.key === windowKey) || null;
    if (!entry) {
      entry = {
        key: windowKey,
        bounds: null,
        isMaximized: false,
        activeTabId: null,
        tabs: [],
        updatedAt: nowIso(),
      };
      this.workspace.windows.push(entry);
    }
    return entry;
  }

  updateWindowState(windowKey, payload) {
    if (!windowKey || !payload || typeof payload !== 'object') return;
    const entry = this.ensureWindow(windowKey);
    if (!entry) return;
    entry.activeTabId = payload.activeTabId || entry.activeTabId || null;
    entry.tabs = Array.isArray(payload.tabs) ? payload.tabs : entry.tabs || [];
    entry.updatedAt = nowIso();
    this.workspace.savedAt = nowIso();
    this.scheduleFlush();
  }

  updateWindowBounds(windowKey, { bounds, isMaximized } = {}) {
    if (!windowKey) return;
    const entry = this.ensureWindow(windowKey);
    if (!entry) return;
    const normalized = normalizeBounds(bounds);
    if (normalized) entry.bounds = normalized;
    entry.isMaximized = Boolean(isMaximized);
    entry.updatedAt = nowIso();
    this.workspace.savedAt = nowIso();
    this.scheduleFlush();
  }

  removeWindow(windowKey) {
    if (!windowKey || !Array.isArray(this.workspace.windows)) return;
    this.workspace.windows = this.workspace.windows.filter((w) => w && w.key !== windowKey);
    if (this.workspace.lastActiveWindowKey === windowKey) {
      this.workspace.lastActiveWindowKey = this.workspace.windows[0]?.key || null;
    }
    this.workspace.savedAt = nowIso();
    this.scheduleFlush();
  }

  setLastActiveWindow(windowKey) {
    if (!windowKey) return;
    this.workspace.lastActiveWindowKey = windowKey;
    this.workspace.savedAt = nowIso();
    this.scheduleFlush();
  }

  filterToWindows(windowKeys = []) {
    const keep = new Set((windowKeys || []).filter(Boolean));
    if (!keep.size) {
      this.workspace.windows = [];
      this.workspace.lastActiveWindowKey = null;
    } else {
      this.workspace.windows = (this.workspace.windows || []).filter((w) => w && keep.has(w.key));
      if (this.workspace.lastActiveWindowKey && !keep.has(this.workspace.lastActiveWindowKey)) {
        this.workspace.lastActiveWindowKey = this.workspace.windows[0]?.key || null;
      }
    }
    this.workspace.savedAt = nowIso();
    this.scheduleFlush();
  }

  resetToNewSession() {
    try {
      if (fs.existsSync(this.workspacePath)) {
        fs.copyFileSync(this.workspacePath, this.workspacePreviousPath);
      }
    } catch (_) {
      // ignore
    }
    this.workspace = defaultWorkspaceState();
    rmDirSyncSafe(this.snapshotsDir);
    ensureDir(this.snapshotsDir);
    this.flushSync();
  }

  getSnapshotPath(paneId) {
    const safe = sanitizeIdForFilename(paneId);
    return path.join(this.snapshotsDir, `${safe}.txt`);
  }

  readSnapshot(paneId, { maxChars } = {}) {
    if (!paneId) return '';
    const filePath = this.getSnapshotPath(paneId);
    if (!fs.existsSync(filePath)) return '';
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (Number.isFinite(maxChars) && maxChars > 0 && content.length > maxChars) {
        return content.slice(-maxChars);
      }
      return content;
    } catch (_) {
      return '';
    }
  }

  saveSnapshots(snapshots = []) {
    if (!Array.isArray(snapshots) || snapshots.length === 0) return;
    ensureDir(this.snapshotsDir);
    const maxCharsPerPane = Number(this.workspace?.snapshot?.maxCharsPerPane) || 200_000;
    for (const item of snapshots) {
      const paneId = item?.paneId;
      if (!paneId) continue;
      let content = typeof item?.content === 'string' ? item.content : '';
      if (!content) continue;
      if (maxCharsPerPane > 0 && content.length > maxCharsPerPane) {
        content = content.slice(-maxCharsPerPane);
      }
      const filePath = this.getSnapshotPath(paneId);
      atomicWriteFile(filePath, content, { encoding: 'utf8' });
    }
    this.pruneSnapshotsByTotalSize();
  }

  pruneSnapshotsByTotalSize() {
    const maxTotalChars = Number(this.workspace?.snapshot?.maxTotalChars) || 8_000_000;
    if (!Number.isFinite(maxTotalChars) || maxTotalChars <= 0) return;
    if (!fs.existsSync(this.snapshotsDir)) return;
    let files = [];
    try {
      files = fs.readdirSync(this.snapshotsDir)
        .filter((name) => name.endsWith('.txt'))
        .map((name) => {
          const filePath = path.join(this.snapshotsDir, name);
          try {
            const stat = fs.statSync(filePath);
            return { filePath, size: stat.size, mtimeMs: stat.mtimeMs };
          } catch (_) {
            return null;
          }
        })
        .filter(Boolean);
    } catch (_) {
      return;
    }

    let total = files.reduce((sum, f) => sum + (f.size || 0), 0);
    if (total <= maxTotalChars) return;

    files.sort((a, b) => (a.mtimeMs || 0) - (b.mtimeMs || 0));
    for (const file of files) {
      if (total <= maxTotalChars) break;
      try {
        fs.unlinkSync(file.filePath);
        total -= file.size || 0;
      } catch (_) {
        // ignore
      }
    }
  }

  buildRestorePayloadForWindow(windowKey) {
    const entry = (this.workspace.windows || []).find((w) => w && w.key === windowKey) || null;
    if (!entry) return null;
    const maxChars = Number(this.workspace?.snapshot?.maxCharsPerPane) || 200_000;
    const tabs = Array.isArray(entry.tabs) ? entry.tabs : [];
    const tabsWithSnapshots = tabs.map((tab) => {
      const panes = Array.isArray(tab?.panes) ? tab.panes : [];
      const panesWithSnapshots = panes.map((pane) => ({
        ...pane,
        snapshot: this.readSnapshot(pane?.paneId, { maxChars }),
      }));
      return {
        ...tab,
        panes: panesWithSnapshots,
      };
    });
    return {
      windowKey: entry.key,
      activeTabId: entry.activeTabId || null,
      tabs: tabsWithSnapshots,
    };
  }

  flushSync() {
    const flushSeq = ++this._flushSeq;
    this._flushBarrier = flushSeq;
    const json = JSON.stringify(this.workspace, null, 2);
    atomicWriteFile(this.workspacePath, json, { encoding: 'utf8' });
  }

  async flushAsync() {
    const flushSeq = ++this._flushSeq;
    const json = JSON.stringify(this.workspace, null, 2);
    const write = async () => {
      try {
        await atomicWriteFileAsync(this.workspacePath, json, {
          encoding: 'utf8',
          shouldCommit: () => flushSeq >= this._flushBarrier,
        });
      } catch (_) {
        // ignore
      }
    };
    this._flushPromise = (this._flushPromise || Promise.resolve()).then(write, write);
    return this._flushPromise;
  }

  scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      void this.flushAsync();
    }, 500);
  }
}

module.exports = SessionStore;
