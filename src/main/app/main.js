const { app, BrowserWindow, ipcMain, session, webContents, screen, Menu, nativeImage, systemPreferences, clipboard } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const SessionStore = require('../features/session/session-store');
const NotifyService = require('../features/notify/notify-service');
const AutoConfigService = require('../features/config/auto-config-service');
const { HistorySyncService } = require('../history/app/history-sync-service');
const { StatusService } = require('../status/status-service');
const { registerStatusIpc } = require('../status/status-ipc');
const { registerHistoryIpc } = require('../history/app/history-ipc');
const { ClaudeHooksSource } = require('../status/sources/claude-hooks-source');
const { CodexCommandSource } = require('../status/sources/codex-command-source');
const { CodexJsonlStatusSource } = require('../status/sources/codex-jsonl-source');
const { PaneLifecycleSource } = require('../status/sources/pane-lifecycle-source');
const { SettingsStore } = require('../core/settings/settings-store');
const { registerSettingsIpc } = require('../core/settings/settings-ipc');
const { registerOnboardingIpc } = require('../features/onboarding/onboarding-ipc');

// 終了時のspawnエラーを抑制（node-ptyのクリーンアップ時に発生することがある）
let isQuitting = false;
process.on('uncaughtException', (error) => {
  if (isQuitting && error.code === 'ENOENT') {
    // 終了中のENOENTエラーは無視
    return;
  }
  console.error('Uncaught exception:', error);
});

// 重いモジュールは遅延ロード
let PtyManager;
let CheerService;
let HistoryService;
let SummaryService;
let PresenceService;
let ProviderCapabilityService;
let GitService;
let CommitMessageService;

let ptyManager;
let cheerService;
let historyService;
let summaryService;
let presenceService;
let capabilityService;
let gitService;
let commitMessageService;
let notifyService;
let autoConfigService;
let historySyncService;
let historyIpc;
let settingsStore;
let settingsIpcCleanup;
let onboardingIpcCleanup;
let statusService;
let claudeHooksSource;
let codexCommandSource;
let codexJsonlStatusSource;
let paneLifecycleSource;
let sessionStore;
let settingsFilePresent = false;
const windowSessionKeys = new Map(); // windowId -> sessionKey

const CACHE_INSTANCE_PREFIX = 'instance-';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24時間
const INSTANCE_ID = `instance-${process.pid}`;
process.env.KAWAII_TERMINAL_INSTANCE_ID = process.env.KAWAII_TERMINAL_INSTANCE_ID || INSTANCE_ID;
const TEMP_CACHE_ROOT = path.join(os.tmpdir(), 'kawaii-terminal-cache');
const PIN_TEMP_ROOT = path.join(os.tmpdir(), 'kawaii-terminal-pins');
const PRELOAD_PATH = path.join(__dirname, '../../preload/preload.js');
const RENDERER_PATH = path.join(__dirname, '../../renderer/index.html');
const APP_ICON_ICO_PATH = path.join(__dirname, '../../../assets/icon.ico');
const APP_ICON_PNG_PATH = path.join(__dirname, '../../../assets/icon.png');
const APP_ICON_PATH = process.platform === 'win32' ? APP_ICON_ICO_PATH : APP_ICON_PNG_PATH;

const DEV_CHANNEL = String(process.env.KAWAII_TERMINAL_CHANNEL || '').trim().toLowerCase();
const IS_DEV_BUILD = DEV_CHANNEL === 'dev' || !app.isPackaged || process.defaultApp;
const APP_DISPLAY_NAME = IS_DEV_BUILD ? 'kawaii-terminal-dev' : 'kawaii-terminal';
const APP_ID = IS_DEV_BUILD ? 'com.kawaii.terminal.dev' : 'com.kawaii.terminal';
const USER_DATA_DIRNAME = IS_DEV_BUILD ? 'KawaiiTerminal-dev' : 'KawaiiTerminal';
try {
  // 開発時にメニューが "Electron" になるのを防ぐ
  app.setName(APP_DISPLAY_NAME);
} catch (_) { /* noop */ }
try {
  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_ID);
  }
} catch (_) { /* noop */ }

function applyMacDockIcon() {
  if (process.platform !== 'darwin') return;
  try {
    const image = nativeImage.createFromPath(APP_ICON_PNG_PATH);
    if (!image?.isEmpty?.()) {
      app.dock?.setIcon?.(image);
    }
  } catch (e) {
    console.error('[Main] Failed to set macOS dock icon:', e);
  }
}

function createSessionKey() {
  try {
    return `w-${crypto.randomUUID()}`;
  } catch (_) {
    return `w-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function parseUrlSafe(value) {
  try {
    return new URL(String(value || ''));
  } catch (_) {
    return null;
  }
}

function getResetOptionsFromArgs(argv = process.argv) {
  let resetRequested = false;
  let rollbackClaude = false;
  for (const arg of argv || []) {
    if (arg === '--kawaii-reset' || String(arg || '').startsWith('--kawaii-reset=')) {
      resetRequested = true;
    }
    if (arg === '--kawaii-reset-claude' || arg === '--kawaii-reset-claude=1') {
      rollbackClaude = true;
    }
  }
  if (!resetRequested) return null;
  return { rollbackClaude };
}

function stripResetArgs(argv = process.argv) {
  return (argv || []).filter((arg) => {
    const raw = String(arg || '');
    if (raw === '--kawaii-reset' || raw.startsWith('--kawaii-reset=')) return false;
    if (raw === '--kawaii-reset-claude' || raw === '--kawaii-reset-claude=1') return false;
    return true;
  });
}

function isIndexHtmlFileUrl(urlString) {
  if (typeof urlString !== 'string') return false;
  if (!/^file:/i.test(urlString)) return false;
  const parsed = parseUrlSafe(urlString);
  if (!parsed) return false;
  const pathname = parsed.pathname || '';
  return pathname.endsWith('/index.html') || pathname.endsWith('index.html');
}

function isAllowedNavigationUrl(urlString) {
  if (typeof urlString !== 'string') return false;
  if (/^devtools:\/\//i.test(urlString)) return true;
  if (/^about:/i.test(urlString)) return true;
  if (/^data:text\/html/i.test(urlString)) return true;
  return isIndexHtmlFileUrl(urlString);
}

function hardenWebContents(contents) {
  if (!contents) return;
  try {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  } catch (_) { /* noop */ }

  const blockIfUntrusted = (event, url) => {
    if (isAllowedNavigationUrl(url)) return;
    try {
      event.preventDefault();
    } catch (_) { /* noop */ }
  };

  contents.on('will-navigate', blockIfUntrusted);
  contents.on('will-redirect', blockIfUntrusted);
}

function isTrustedIpcSender(event) {
  try {
    const url = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
    return isIndexHtmlFileUrl(url);
  } catch (_) {
    return false;
  }
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const int = Math.floor(num);
  return Math.min(max, Math.max(min, int));
}

function normalizeTabId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 160) return null;
  // dataset/tabId用途なので、制御文字やスペースは拒否
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(trimmed)) return null;
  return trimmed;
}

const WSL_LIST_CACHE_MS = 3000;
const WSL_LIST_TIMEOUT_MS = 1500;
const WSL_PROFILE_PREFIX = 'wsl:';
let wslListCache = { list: [], available: false, fetchedAt: 0, pending: null };
const WSL_WARMUP_TIMEOUT_MS = 1500;
const WSL_WARMUP_MIN_INTERVAL_MS = 10_000;
const usedWslDistros = new Set();
let wslUsageVersion = 0;
let lastWslWarmupVersion = -1;
let lastWslWarmupAt = 0;
const logHistoryDebug = () => {};

function decodeCommandOutput(output) {
  if (!output) return '';
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

function execFileText(command, args, { timeout = WSL_LIST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: 'buffer', timeout, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && error.code === 'ENOENT') {
          reject(error);
          return;
        }
        resolve({
          stdout: decodeCommandOutput(stdout),
          stderr: decodeCommandOutput(stderr),
          hasError: Boolean(error),
        });
      },
    );
  });
}

function normalizeProfileId(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return '';
  return trimmed.slice(0, 200);
}

function normalizeWslDistroName(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return '';
  return trimmed.slice(0, 120);
}

function extractWslDistroFromProfileId(profileId) {
  if (typeof profileId !== 'string') return '';
  const trimmed = profileId.trim();
  if (!trimmed) return '';
  if (!trimmed.toLowerCase().startsWith(WSL_PROFILE_PREFIX)) return '';
  const name = trimmed.slice(WSL_PROFILE_PREFIX.length).trim();
  if (!name) return '';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) return '';
  return name.slice(0, 120);
}

function recordWslDistroUsage(profileId) {
  const name = extractWslDistroFromProfileId(profileId);
  if (!name) return;
  if (!usedWslDistros.has(name)) {
    usedWslDistros.add(name);
    wslUsageVersion += 1;
    logHistoryDebug('recordWslDistroUsage', { name, used: Array.from(usedWslDistros) });
  }
}

function isWslExecutablePresent() {
  if (process.platform !== 'win32') return false;
  const windir = process.env.WINDIR || 'C:\\Windows';
  return fs.existsSync(path.join(windir, 'System32', 'wsl.exe'));
}

async function warmupWslDistro(name, timeoutMs) {
  const args = [];
  if (name && name.toLowerCase() !== 'default') {
    args.push('-d', name);
  }
  args.push('-e', 'true');
  try {
    await execFileText('wsl.exe', args, { timeout: timeoutMs });
    logHistoryDebug('warmupWslDistro ok', { name, args });
    return true;
  } catch (_) {
    logHistoryDebug('warmupWslDistro fail', { name, args });
    return false;
  }
}

async function warmupUsedWslDistros({ timeoutMs = WSL_WARMUP_TIMEOUT_MS } = {}) {
  if (process.platform !== 'win32') return { ok: false, attempted: 0 };
  if (!isWslExecutablePresent()) return { ok: false, attempted: 0 };
  const distros = Array.from(usedWslDistros);
  if (distros.length === 0) return { ok: false, attempted: 0 };
  const now = Date.now();
  if (wslUsageVersion === lastWslWarmupVersion && now - lastWslWarmupAt < WSL_WARMUP_MIN_INTERVAL_MS) {
    return { ok: true, attempted: 0, skipped: true };
  }

  logHistoryDebug('warmupUsedWslDistros start', { distros, timeoutMs });
  lastWslWarmupAt = now;
  lastWslWarmupVersion = wslUsageVersion;

  let attempted = 0;
  let warmed = 0;
  for (const distro of distros) {
    attempted += 1;
    if (await warmupWslDistro(distro, timeoutMs)) {
      warmed += 1;
    }
  }
  const result = { ok: true, attempted, warmed };
  logHistoryDebug('warmupUsedWslDistros done', result);
  return result;
}

async function listWslDistros() {
  if (process.platform !== 'win32') return { distros: [], available: false };
  const now = Date.now();
  if (wslListCache.fetchedAt && now - wslListCache.fetchedAt < WSL_LIST_CACHE_MS) {
    return { distros: wslListCache.list, available: wslListCache.available };
  }
  if (wslListCache.pending) return wslListCache.pending;
  wslListCache.pending = (async () => {
    try {
      const { stdout } = await execFileText('wsl.exe', ['-l', '-q'], { timeout: WSL_LIST_TIMEOUT_MS });
      const items = String(stdout || '')
        .split(/\r?\n/)
        .map((line) => normalizeWslDistroName(line))
        .filter(Boolean)
        .filter((line) => !/wsl\//i.test(line));
      const unique = Array.from(new Set(items));
      wslListCache.list = unique;
      wslListCache.available = true;
      wslListCache.fetchedAt = Date.now();
      return { distros: unique, available: true };
    } catch (_) {
      const available = isWslExecutablePresent();
      wslListCache.list = [];
      wslListCache.available = available;
      wslListCache.fetchedAt = Date.now();
      return { distros: [], available };
    } finally {
      wslListCache.pending = null;
    }
  })();
  return wslListCache.pending;
}

function buildTerminalProfiles({ wslDistros, wslAvailable } = {}) {
  const profiles = [];
  if (process.platform === 'win32') {
    profiles.push({
      id: 'powershell',
      label: 'PowerShell',
      kind: 'powershell',
      isDefault: true,
    });
    const distros = Array.isArray(wslDistros) ? wslDistros : [];
    for (const distro of distros) {
      const name = normalizeWslDistroName(distro);
      if (!name) continue;
      profiles.push({
        id: `${WSL_PROFILE_PREFIX}${name}`,
        label: name,
        kind: 'wsl',
        isDefault: false,
      });
    }
    if (wslAvailable && distros.length === 0) {
      profiles.push({
        id: `${WSL_PROFILE_PREFIX}default`,
        label: 'WSL',
        kind: 'wsl',
        isDefault: false,
      });
    }
  } else {
    profiles.push({
      id: 'default',
      label: 'Default Shell',
      kind: 'default',
      isDefault: true,
    });
  }
  return profiles;
}

function sendMenuAction(action) {
  if (!action) return;
  const win = BrowserWindow.getFocusedWindow() || windowManager.getAll()?.[0] || null;
  if (!win || win.isDestroyed()) return;
  win.webContents.send('menu:action', { action });
}

function registerGlobalShortcuts() {
  // Global shortcuts disabled: rely on in-app handlers + menu accelerators.
}

function unregisterGlobalShortcuts() {
  // Global shortcuts disabled.
}

function bindWindowShortcutFallback(_win) {
  // In-app shortcuts are handled in the renderer to support customization.
  return;
}

function setupApplicationMenu() {
  if (process.platform === 'darwin') {
    // ターミナルなので、実装していない標準Editメニュー（Undo/Redo/Select All等）は表示しない。
    // 代わりに、アプリで実装済みのアクションのみをメニュー化する。
    const template = [
      {
        label: APP_DISPLAY_NAME,
        submenu: [
          { role: 'about', label: `About ${APP_DISPLAY_NAME}` },
          { type: 'separator' },
          { role: 'hide', label: `Hide ${APP_DISPLAY_NAME}` },
          { role: 'hideOthers', label: 'Hide Others' },
          { role: 'unhide', label: 'Show All' },
          { type: 'separator' },
          { label: `Quit ${APP_DISPLAY_NAME}`, accelerator: 'Command+Q', click: () => app.quit() },
        ],
      },
      {
        label: 'Tab',
        submenu: [
          { label: 'New Tab', click: () => sendMenuAction('tab:new') },
          { label: 'Close Tab', click: () => sendMenuAction('tab:close') },
          { type: 'separator' },
          { label: 'Split Right', click: () => sendMenuAction('pane:split-right') },
          { label: 'Split Down', click: () => sendMenuAction('pane:split-down') },
          { label: 'Close Pane', click: () => sendMenuAction('pane:close') },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { label: 'Cut', click: () => sendMenuAction('terminal:cut') },
          { label: 'Copy', click: () => sendMenuAction('terminal:copy') },
          { label: 'Paste', click: () => sendMenuAction('terminal:paste') },
          { label: 'Select All', click: () => sendMenuAction('terminal:select-all') },
          { type: 'separator' },
          { label: 'Find', click: () => sendMenuAction('terminal:find') },
          { label: 'Clear', click: () => sendMenuAction('terminal:clear') },
        ],
      },
      {
        label: 'View',
        submenu: [
          { label: 'Pins', click: () => sendMenuAction('view:pins') },
          { label: 'Pin Last Output', click: () => sendMenuAction('view:pin') },
          // Electronのacceleratorは "?" を直接指定すると無効扱いになりやすいので、実体のキーである "/" を指定する
          // （ユーザー入力としては Shift+/ = ? なので、⌘+⇧+? でも同じショートカットとして動作する）
          { label: 'Keyboard Shortcuts', click: () => sendMenuAction('view:shortcuts') },
          { type: 'separator' },
          {
            label: 'Developer Tools',
            click: () => {
              const win = BrowserWindow.getFocusedWindow() || null;
              if (!win || win.isDestroyed()) return;
              win.webContents.toggleDevTools();
            },
          },
        ],
      },
      {
        label: 'Window',
        submenu: [
          {
            label: 'New Window',
            click: () => {
              const win = windowManager.createWindow();
              win.focus();
            },
          },
          { type: 'separator' },
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          { role: 'front' },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    return;
  }
  Menu.setApplicationMenu(null);
}

class TabRegistry {
  constructor() {
    this.tabToWebContents = new Map();
    this.webContentsToTabs = new Map();
  }

  register(tabId, webContentsId) {
    if (!tabId || !webContentsId) return;
    const previous = this.tabToWebContents.get(tabId);
    if (previous && previous !== webContentsId) {
      const prevSet = this.webContentsToTabs.get(previous);
      if (prevSet) {
        prevSet.delete(tabId);
        if (prevSet.size === 0) {
          this.webContentsToTabs.delete(previous);
        }
      }
    }
    this.tabToWebContents.set(tabId, webContentsId);
    if (!this.webContentsToTabs.has(webContentsId)) {
      this.webContentsToTabs.set(webContentsId, new Set());
    }
    this.webContentsToTabs.get(webContentsId).add(tabId);
  }

  unregister(tabId) {
    const webContentsId = this.tabToWebContents.get(tabId);
    if (!webContentsId) return;
    this.tabToWebContents.delete(tabId);
    const set = this.webContentsToTabs.get(webContentsId);
    if (set) {
      set.delete(tabId);
      if (set.size === 0) {
        this.webContentsToTabs.delete(webContentsId);
      }
    }
  }

  getWebContentsId(tabId) {
    return this.tabToWebContents.get(tabId) || null;
  }

  takeTabsForWebContents(webContentsId) {
    const set = this.webContentsToTabs.get(webContentsId);
    if (!set) return [];
    const tabs = Array.from(set);
    for (const tabId of tabs) {
      this.tabToWebContents.delete(tabId);
    }
    this.webContentsToTabs.delete(webContentsId);
    return tabs;
  }
}

class WindowManager {
  constructor({ onWindowClosed } = {}) {
    this.windows = new Map();
    this.onWindowClosed = onWindowClosed;
  }

  createWindow({ bounds, adoptPayload, sessionKey, restoreSession, recoveryPrompt } = {}) {
    const windowSessionKey = sessionKey || createSessionKey();
    const windowOptions = {
      width: 1200,
      height: 700,
      minWidth: 800,
      minHeight: 500,
      frame: false,
      titleBarStyle: 'hidden',
      show: false, // 準備完了まで非表示
      icon: APP_ICON_PATH,
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // Required for fs access in preload
      },
      backgroundColor: '#0d0d14',
    };

    if (bounds) {
      if (Number.isFinite(bounds.width)) windowOptions.width = Math.max(400, bounds.width);
      if (Number.isFinite(bounds.height)) windowOptions.height = Math.max(300, bounds.height);
      if (Number.isFinite(bounds.x)) windowOptions.x = Math.round(bounds.x);
      if (Number.isFinite(bounds.y)) windowOptions.y = Math.round(bounds.y);
    }

    const win = new BrowserWindow(windowOptions);
    hardenWebContents(win.webContents);
    bindWindowShortcutFallback(win);
    win.__kawaiiSessionKey = windowSessionKey;
    windowSessionKeys.set(win.id, windowSessionKey);

    this.registerWindow(win);

    // 準備完了したら表示
    win.once('ready-to-show', () => {
      win.show();
      if (win.isMaximized()) {
        if (process.platform !== 'darwin') {
          // 最大化状態の場合、リサイズを無効化
          win.setResizable(false);
        }
        win.webContents.send('window:maximized-change', { isMaximized: true });
      }
    });

    const query = { windowId: String(win.id), sessionKey: String(windowSessionKey) };
    if (adoptPayload?.tabId) {
      query.adopt = '1';
    }
    if (restoreSession) {
      query.restore = '1';
    }
    if (recoveryPrompt) {
      query.recovery = '1';
    }
    win.loadFile(RENDERER_PATH, { query });

    if (adoptPayload?.tabId) {
      win.webContents.once('did-finish-load', () => {
        win.webContents.send('window:adopt-tab', adoptPayload);
      });
    }

    // ブラウザズームを無効化（ターミナルのフォントサイズのみ変更するため）
    win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
    win.webContents.on('zoom-changed', () => {
      win.webContents.setZoomLevel(0);
    });

    // ウィンドウが閉じる前にストレージをフラッシュ
    win.on('close', () => {
      try {
        session.defaultSession.flushStorageData();
      } catch (e) {
        console.error('[Main] Failed to flush storage:', e);
      }
    });

    return win;
  }

  registerWindow(win) {
    const windowId = win.id;
    const webContentsId = win.webContents.id;
    this.windows.set(windowId, win);
    const sessionKey = win.__kawaiiSessionKey || null;

    if (sessionKey && sessionStore) {
      try {
        sessionStore.ensureWindow(sessionKey);
        sessionStore.updateWindowBounds(sessionKey, { bounds: win.getBounds(), isMaximized: win.isMaximized() });
      } catch (_) { /* noop */ }
    }

    const updateBounds = () => {
      if (!sessionKey || !sessionStore) return;
      try {
        sessionStore.updateWindowBounds(sessionKey, { bounds: win.getBounds(), isMaximized: win.isMaximized() });
      } catch (_) { /* noop */ }
    };

    win.on('move', () => updateBounds());
    win.on('resize', () => updateBounds());
    win.on('maximize', () => {
      updateBounds();
      if (process.platform !== 'darwin') {
        // 最大化時はリサイズを無効化（画面端のリサイズカーソル問題を回避）
        win.setResizable(false);
      }
      // rendererに通知（CSS調整用）
      if (!win.isDestroyed()) {
        win.webContents.send('window:maximized-change', { isMaximized: true });
      }
    });
    win.on('unmaximize', () => {
      updateBounds();
      if (process.platform !== 'darwin') {
        win.setResizable(true);
      }
      if (!win.isDestroyed()) {
        win.webContents.send('window:maximized-change', { isMaximized: false });
      }
    });
    win.on('enter-full-screen', () => {
      if (!win.isDestroyed()) {
        win.webContents.send('window:fullscreen-change', { isFullscreen: true });
      }
    });
    win.on('leave-full-screen', () => {
      if (!win.isDestroyed()) {
        win.webContents.send('window:fullscreen-change', { isFullscreen: false });
      }
    });
    win.on('focus', () => {
      if (!sessionKey || !sessionStore) return;
      sessionStore.setLastActiveWindow(sessionKey);
    });

    win.on('closed', () => {
      this.windows.delete(windowId);
      this.onWindowClosed?.(webContentsId, windowId);
    });
    return win;
  }

  getAll() {
    return Array.from(this.windows.values());
  }

  getById(windowId) {
    if (!windowId) return null;
    return this.windows.get(Number(windowId)) || null;
  }

  getByWebContentsId(webContentsId) {
    for (const win of this.windows.values()) {
      if (win.webContents?.id === webContentsId) return win;
    }
    return null;
  }
}

const tabRegistry = new TabRegistry();
const windowManager = new WindowManager({
  onWindowClosed: (webContentsId, windowId) => {
    const sessionKey = windowSessionKeys.get(windowId) || null;
    windowSessionKeys.delete(windowId);
    const remainingWindows = windowManager.getAll().length;
    const isLastWindow = remainingWindows === 0;
    const treatAsAppQuit = isLastWindow && process.platform !== 'darwin';
    if (sessionKey && sessionStore && !isQuitting && !treatAsAppQuit) {
      sessionStore.removeWindow(sessionKey);
    }

    const tabIds = tabRegistry.takeTabsForWebContents(webContentsId);
    if (!ptyManager || tabIds.length === 0) return;
    for (const tabId of tabIds) {
      ptyManager.kill(tabId);
    }
  },
});

const DRAG_GHOST_HTML = (title) => `<!DOCTYPE html>
<html lang="en">
<meta charset="utf-8" />
<style>
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: transparent;
    font-family: "Segoe UI", "Yu Gothic UI", sans-serif;
  }
  .ghost {
    height: 100%;
    width: 100%;
    background: rgba(10, 10, 10, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 12px;
    box-shadow: 0 18px 40px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    color: #e0e0e0;
    font-size: 11px;
    letter-spacing: 0.2px;
    backdrop-filter: blur(10px);
  }
  .header {
    height: 32px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: rgba(26, 26, 26, 0.9);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .content {
    flex: 1;
    background: rgba(0, 0, 0, 0.3);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: rgba(16, 185, 129, 0.9);
    box-shadow: 0 0 8px rgba(16, 185, 129, 0.6);
    flex-shrink: 0;
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
</style>
<div class="ghost">
  <div class="header">
    <div class="dot"></div>
    <div class="title">${String(title || 'Terminal').replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s]))}</div>
  </div>
  <div class="content"></div>
</div>
</html>`;

let dragGhostWindow = null;
let dragGhostTimer = null;
let dragGhostReady = false;
let dragSession = null;

function stopTabDragSession() {
  dragSession = null;
  dragGhostReady = false;
  if (dragGhostTimer) {
    clearInterval(dragGhostTimer);
    dragGhostTimer = null;
  }
  if (dragGhostWindow && !dragGhostWindow.isDestroyed()) {
    dragGhostWindow.close();
  }
  dragGhostWindow = null;
}

function findWindowAtTabbar(point, tabbarHeight) {
  const wins = windowManager.getAll();
  for (const win of wins) {
    if (!win || win.isDestroyed()) continue;
    if (dragGhostWindow && win.id === dragGhostWindow.id) continue;
    const bounds = win.getBounds();
    if (point.x < bounds.x || point.x > bounds.x + bounds.width) continue;
    if (point.y < bounds.y || point.y > bounds.y + Math.max(20, tabbarHeight || 36)) continue;
    return win;
  }
  return null;
}

function startTabDragSession(payload = {}) {
  stopTabDragSession();
  const {
    title = 'Terminal',
    customTitle = false,
    snapshot = '',
    panes,
    splitLayout,
    activePaneId,
    width = 180,
    height = 26,
    offsetX = 12,
    offsetY = 12,
    startScreenX,
    startScreenY,
    detachThreshold = 28,
    attachThreshold = 18,
    tabbarHeight = 36,
    sourceWindowId,
    tabId,
  } = payload;

  if (!Number.isFinite(startScreenX) || !Number.isFinite(startScreenY)) return;

  const adoptPayload = {
    tabId,
    title,
    customTitle: Boolean(customTitle),
    snapshot: typeof snapshot === 'string' ? snapshot : '',
    panes: Array.isArray(panes) ? panes : null,
    splitLayout: splitLayout || null,
    activePaneId: activePaneId || null,
    sourceWindowId,
  };

  dragSession = {
    title,
    width: Math.max(120, Math.round(width)),
    height: Math.max(22, Math.round(height)),
    offsetX: Math.max(4, Math.round(offsetX)),
    offsetY: Math.max(4, Math.round(offsetY)),
    startScreenX,
    startScreenY,
    detachThreshold,
    attachThreshold,
    tabbarHeight,
    visible: false,
    wantVisible: false,
    sourceWindowId,
    tabId,
    adoptPayload,
    lastPoint: { x: startScreenX, y: startScreenY },
    hoverWindowId: null,
    forceDetach: false,
    ghostOpacity: 0,
    ghostTargetOpacity: 0,
  };

  dragGhostWindow = new BrowserWindow({
    width: dragSession.width,
    height: dragSession.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  hardenWebContents(dragGhostWindow.webContents);
  try {
    dragGhostWindow.setOpacity(0);
  } catch (_) {
    // ignore
  }
  dragGhostWindow.setIgnoreMouseEvents(true, { forward: true });
  dragGhostWindow.once('ready-to-show', () => {
    dragGhostReady = true;
    if (dragSession?.wantVisible) {
      dragGhostWindow.showInactive();
      dragSession.visible = true;
    }
  });
  dragGhostWindow.webContents?.on('did-finish-load', () => {
    dragGhostReady = true;
    if (dragSession?.wantVisible) {
      dragGhostWindow.showInactive();
      dragSession.visible = true;
    }
  });
  dragGhostWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(DRAG_GHOST_HTML(title))}`).catch(() => {});

  dragGhostTimer = setInterval(() => {
    if (!dragSession || !dragGhostWindow || dragGhostWindow.isDestroyed()) return;
    const point = screen.getCursorScreenPoint();
    const dy = point.y - dragSession.startScreenY;
    const absDy = Math.abs(dy);
    const overTabbarWin = findWindowAtTabbar(point, dragSession.tabbarHeight);
    const overSourceTabbar = overTabbarWin
      && String(overTabbarWin.id) === String(dragSession.sourceWindowId);
    const threshold = dragSession.visible ? dragSession.attachThreshold : dragSession.detachThreshold;
    let shouldShow = (absDy > threshold && !overTabbarWin)
      || (dragSession.forceDetach && (!overTabbarWin || overSourceTabbar));

    dragSession.wantVisible = shouldShow;
    dragSession.ghostTargetOpacity = shouldShow ? 1 : 0;
    const delta = dragSession.ghostTargetOpacity - dragSession.ghostOpacity;
    if (Math.abs(delta) > 0.001) {
      dragSession.ghostOpacity += delta * 0.2;
      if (Math.abs(dragSession.ghostOpacity - dragSession.ghostTargetOpacity) < 0.01) {
        dragSession.ghostOpacity = dragSession.ghostTargetOpacity;
      }
    }

    if (dragGhostReady) {
      const nextX = Math.round(point.x - dragSession.offsetX);
      const nextY = Math.round(point.y - dragSession.offsetY);
      dragGhostWindow.setBounds({
        x: nextX,
        y: nextY,
        width: dragSession.width,
        height: dragSession.height,
      }, false);

      if (dragSession.ghostOpacity > 0.02) {
        if (!dragSession.visible) {
          dragGhostWindow.showInactive();
          dragSession.visible = true;
        }
        try {
          dragGhostWindow.setOpacity(dragSession.ghostOpacity);
        } catch (_) {
          // ignore
        }
      } else {
        if (dragSession.visible && dragGhostWindow.isVisible()) {
          dragGhostWindow.hide();
        }
        dragSession.visible = false;
      }
    }
  }, 16);
}

function ensureDirWritable(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const probePath = path.join(dirPath, '.write-probe');
    fs.writeFileSync(probePath, 'ok');
    fs.unlinkSync(probePath);
    return true;
  } catch (e) {
    return false;
  }
}

function initAppPaths() {
  const appDataDir = path.join(app.getPath('appData'), USER_DATA_DIRNAME);

  // 固定のuserDataディレクトリを使用（localStorageの永続化のため）
  // キャッシュのみプロセスごとに分離して競合を防ぐ
  let userDataDir = appDataDir;

  if (!ensureDirWritable(userDataDir)) {
    userDataDir = path.join(os.tmpdir(), 'kawaii-terminal');
    ensureDirWritable(userDataDir);
  }
  app.setPath('userData', userDataDir);

  // キャッシュは多重起動時の競合を防ぐためプロセスごとに分離
  const cacheDir = path.join(userDataDir, 'Cache', INSTANCE_ID);
  if (ensureDirWritable(cacheDir)) {
    app.setPath('cache', cacheDir);
  } else {
    const tempCache = path.join(os.tmpdir(), 'kawaii-terminal-cache', INSTANCE_ID);
    ensureDirWritable(tempCache);
    app.setPath('cache', tempCache);
  }

}

function cleanupOldInstanceDirs(rootDir, { prefix = CACHE_INSTANCE_PREFIX, maxAgeMs = CACHE_MAX_AGE_MS } = {}) {
  try {
    if (!rootDir || !fs.existsSync(rootDir)) return;
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    const now = Date.now();

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(prefix)) {
        const dirPath = path.join(rootDir, entry.name);
        try {
          const stat = fs.statSync(dirPath);
          if (now - stat.mtimeMs > maxAgeMs) {
            fs.rmSync(dirPath, { recursive: true, force: true });
          }
        } catch (e) {
          // 使用中なら無視
        }
      }
    }
  } catch (e) {
    // エラーは無視
  }
}

function removeDirSafe(dirPath) {
  if (!dirPath) return false;
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
    return true;
  } catch (_) {
    return false;
  }
}

function removeFileSafe(filePath) {
  if (!filePath) return false;
  try {
    fs.rmSync(filePath, { force: true });
    return true;
  } catch (_) {
    return false;
  }
}

function cleanupCachesOnExit() {
  const roots = [
    path.join(app.getPath('userData'), 'Cache'),
    TEMP_CACHE_ROOT,
  ];
  for (const root of roots) {
    removeDirSafe(path.join(root, INSTANCE_ID));
    cleanupOldInstanceDirs(root);
  }
}

function cleanupTempPinsOnExit() {
  removeDirSafe(path.join(PIN_TEMP_ROOT, INSTANCE_ID));
  cleanupOldInstanceDirs(PIN_TEMP_ROOT);
}

async function performFullReset({ rollbackClaude = false } = {}) {
  const userDataDir = app.getPath('userData');
  try {
    await session.defaultSession.clearStorageData();
  } catch (_) {
    // ignore
  }
  try {
    session.defaultSession.flushStorageData();
  } catch (_) {
    // ignore
  }

  removeDirSafe(userDataDir);
  const settingsPath = path.join(userDataDir, 'settings.json');
  removeFileSafe(settingsPath);
  removeFileSafe(`${settingsPath}.bak`);
  removeDirSafe(TEMP_CACHE_ROOT);
  removeDirSafe(PIN_TEMP_ROOT);
  ensureDirWritable(userDataDir);

  if (rollbackClaude) {
    try {
      const service = autoConfigService || new AutoConfigService({ userHome: os.homedir() });
      await service.rollback({ enableWsl: true });
    } catch (e) {
      console.error('[Reset] Claude rollback failed:', e?.message || e);
    }
  }
}

function scheduleResetRelaunch({ rollbackClaude = false } = {}) {
  const args = stripResetArgs(process.argv.slice(1));
  args.push('--kawaii-reset=full');
  if (rollbackClaude) args.push('--kawaii-reset-claude=1');
  try {
    app.relaunch({ args });
  } catch (e) {
    console.error('[Reset] Failed to relaunch:', e?.message || e);
  }
  isQuitting = true;
  app.exit(0);
}

function sendTerminalOutput(tabId, data) {
  const webContentsId = tabRegistry.getWebContentsId(tabId);
  if (!webContentsId) return;
  const target = webContents.fromId(webContentsId);
  if (!target || target.isDestroyed()) return;
  target.send('terminal:output', { tabId, data });
}

async function waitForCheerService() {
  while (!cheerService) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return cheerService;
}

async function waitForSummaryService() {
  while (!summaryService) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return summaryService;
}

async function waitForCapabilityService() {
  while (!capabilityService) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return capabilityService;
}

async function waitForHistoryService() {
  while (!historyService) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return historyService;
}

async function waitForHistorySyncService() {
  while (!historySyncService) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return historySyncService;
}

async function waitForGitService() {
  while (!gitService) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return gitService;
}

async function waitForCommitMessageService() {
  while (!commitMessageService) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return commitMessageService;
}

function createWindow(options = {}) {
  return windowManager.createWindow(options);
}

// リカバリモーダルの選択を待つための Promise resolver
let pendingRecoveryResolve = null;

function shouldPromptRestore({ prevCleanExit, summary } = {}) {
  const windows = Number(summary?.windows) || 0;
  const panes = Number(summary?.panes) || 0;
  return !prevCleanExit || windows >= 2 || panes >= 9;
}

async function showRecoveryModalInWindow(win, { prevCleanExit, crashStreak, summary } = {}) {
  return new Promise((resolve) => {
    pendingRecoveryResolve = resolve;

    const payload = {
      windows: Number(summary?.windows) || 0,
      tabs: Number(summary?.tabs) || 0,
      panes: Number(summary?.panes) || 0,
      prevCleanExit: Boolean(prevCleanExit),
      crashStreak: Number(crashStreak) || 0,
    };

    // ウィンドウが準備できたらモーダルを表示
    const sendModal = () => {
      if (!win.isDestroyed()) {
        win.webContents.send('session:show-recovery-modal', payload);
      }
    };

    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => {
        setTimeout(sendModal, 100); // DOM準備のため少し待つ
      });
    } else {
      setTimeout(sendModal, 100);
    }
  });
}

function chooseLastActiveWindowKey(workspace) {
  const windows = Array.isArray(workspace?.windows) ? workspace.windows : [];
  const lastKey = workspace?.lastActiveWindowKey || null;
  if (lastKey && windows.some((w) => w && w.key === lastKey)) return lastKey;
  return windows[windows.length - 1]?.key || windows[0]?.key || null;
}

async function createInitialWindowsFromSession() {
  sessionStore = new SessionStore({ userDataDir: app.getPath('userData') });
  const workspace = sessionStore.load();
  const prev = sessionStore.getPreviousExitInfo();
  const summary = sessionStore.getSummary();

  const hasSession = sessionStore.hasRestorableSession();
  if (!hasSession) {
    sessionStore.resetToNewSession();
    sessionStore.markStartup({ appVersion: app.getVersion() });
    const key = createSessionKey();
    createWindow({ sessionKey: key });
    return;
  }

  // プロンプトが不要な場合は直接復元
  if (!shouldPromptRestore({ prevCleanExit: prev.clean, summary })) {
    sessionStore.markStartup({ appVersion: app.getVersion() });
    const windows = Array.isArray(sessionStore.workspace?.windows) ? sessionStore.workspace.windows : [];
    if (windows.length === 0) {
      const key = createSessionKey();
      createWindow({ sessionKey: key });
      return;
    }
    for (const entry of windows) {
      if (!entry?.key) continue;
      const win = createWindow({
        bounds: entry.bounds,
        sessionKey: entry.key,
        restoreSession: true,
      });
      if (entry.isMaximized) {
        win.once('ready-to-show', () => {
          if (!win.isDestroyed()) {
            win.maximize();
            if (process.platform !== 'darwin') {
              win.setResizable(false);
            }
          }
        });
      }
    }
    return;
  }

  // プロンプトが必要な場合: まず最初のウィンドウを作成してモーダルを表示
  const firstKey = createSessionKey();
  const firstWin = createWindow({ sessionKey: firstKey, recoveryPrompt: true });

  const mode = await showRecoveryModalInWindow(firstWin, {
    prevCleanExit: prev.clean,
    crashStreak: prev.crashStreak,
    summary,
  });

  if (mode === 'new-session') {
    sessionStore.resetToNewSession();
    sessionStore.markStartup({ appVersion: app.getVersion() });
    // 既に新規ウィンドウが作成済みなので何もしない
    return;
  }

  // Recovery prompt window should not be part of restore targets.
  // Remove it before restoring other windows.
  sessionStore.removeWindow(firstKey);

  if (mode === 'restore-last-window') {
    const lastKey = chooseLastActiveWindowKey(workspace);
    if (lastKey) {
      sessionStore.filterToWindows([lastKey]);
    }
  }

  sessionStore.markStartup({ appVersion: app.getVersion() });

  const windows = Array.isArray(sessionStore.workspace?.windows) ? sessionStore.workspace.windows : [];
  if (windows.length === 0) {
    // 復元するウィンドウがない場合は最初のウィンドウをそのまま使う
    return;
  }

  // 先に復元ウィンドウを作成してから、最初のウィンドウを閉じる（アプリ終了防止）
  for (const entry of windows) {
    if (!entry?.key) continue;
    const win = createWindow({
      bounds: entry.bounds,
      sessionKey: entry.key,
      restoreSession: true,
    });
    if (entry.isMaximized) {
      win.once('ready-to-show', () => {
        if (!win.isDestroyed()) {
          win.maximize();
          if (process.platform !== 'darwin') {
            win.setResizable(false);
          }
        }
      });
    }
  }

  // 復元ウィンドウ作成後に最初のウィンドウを閉じる
  if (!firstWin.isDestroyed()) {
    firstWin.destroy();
  }
}

initAppPaths();

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
app.on('second-instance', () => {
    const openNewWindow = () => {
      const win = createWindow({ sessionKey: createSessionKey() });
      win.focus();
    };
    if (app.isReady()) {
      openNewWindow();
    } else {
      app.whenReady().then(openNewWindow);
    }
  });

  app.whenReady().then(async () => {
    const resetOptions = getResetOptionsFromArgs(process.argv);
    if (resetOptions) {
      await performFullReset(resetOptions);
    }

    applyMacDockIcon();
    try {
      session.defaultSession.setPermissionRequestHandler((_, __, callback) => callback(false));
      session.defaultSession.setPermissionCheckHandler(() => false);
    } catch (e) {
      console.error('[Main] Failed to set permission handlers:', e);
    }

    setupApplicationMenu();
    registerGlobalShortcuts();
    statusService = new StatusService();
    codexCommandSource = new CodexCommandSource({ statusService });
    paneLifecycleSource = new PaneLifecycleSource({ statusService, codexCommandSource });
    claudeHooksSource = new ClaudeHooksSource({ statusService });
    codexJsonlStatusSource = new CodexJsonlStatusSource({ statusService, codexCommandSource });
    registerStatusIpc({
      ipcMain,
      statusService,
      tabRegistry,
      isTrustedIpcSender,
      codexCommandSource,
      paneLifecycleSource,
    });
    historyIpc = registerHistoryIpc({
      ipcMain,
      isTrustedIpcSender,
      getHistorySyncService: () => historySyncService,
      waitForHistorySyncService,
    });
    settingsStore = new SettingsStore({ userDataDir: app.getPath('userData') });
    settingsStore.load();
    settingsFilePresent = fs.existsSync(settingsStore.filePath);
    settingsIpcCleanup = registerSettingsIpc({
      ipcMain,
      settingsStore,
      isTrustedIpcSender,
    });
    onboardingIpcCleanup = registerOnboardingIpc({
      ipcMain,
      isTrustedIpcSender,
    });
    createInitialWindowsFromSession().catch((e) => {
      console.error('[Session] Failed to create initial windows:', e);
      try {
        createWindow({ sessionKey: createSessionKey() });
      } catch (_) { /* noop */ }
    });


  // 重いモジュールはウィンドウ表示後に遅延ロード
  setImmediate(() => {
    PtyManager = require('../features/terminal/pty-manager');
    CheerService = require('../features/cheer/cheer-service');
    HistoryService = require('../history/app/history-service');
    SummaryService = require('../features/summary/summary-service');
    PresenceService = require('../infra/agents/agent-presence-service');
    ProviderCapabilityService = require('../features/ai/provider-capability-service');
    GitService = require('../features/git/git-service');
    CommitMessageService = require('../features/ai/commit-message-service');
    ptyManager = new PtyManager();
    cheerService = new CheerService();
    historyService = new HistoryService({ userDataDir: app.getPath('userData') });
    presenceService = new PresenceService.AgentPresenceService();
    capabilityService = new ProviderCapabilityService.ProviderCapabilityService({
      settingsStore,
      presenceService,
    });
    gitService = new GitService.GitService();
    commitMessageService = new CommitMessageService.CommitMessageService({
      settingsStore,
      capabilityService,
      gitService,
    });
    summaryService = new SummaryService.SummaryService({
      settingsStore,
      historyService,
      presenceService,
      capabilityService,
    });
    if (!settingsFilePresent) {
      (async () => {
        const presence = await presenceService.check({ refresh: true });
        const claudeAvailable = Boolean(presence?.claude?.local?.cli?.present);
        settingsStore.update({
          summaries: {
            enabled: claudeAvailable,
            provider: claudeAvailable ? 'claude' : 'gemini',
          },
        }, { source: 'system' });
      })();
    }
    notifyService = new NotifyService({
      userDataDir: app.getPath('userData'),
      onEvent: (payload) => {
        claudeHooksSource?.handleNotifyEvent?.(payload);
      },
    });
    notifyService.start();
    process.env.KAWAII_NOTIFY_PATH = notifyService.getNotifyPath();
    autoConfigService = new AutoConfigService({ userHome: os.homedir() });
    const notifyInstall = autoConfigService.ensureNotifyScriptsInstalled();
    if (!notifyInstall?.ok) {
      console.error('[AutoConfig] Notify scripts install failed:', notifyInstall?.error || 'unknown');
    }
    historySyncService = new HistorySyncService({
      historyService,
      codexStatusSource: codexJsonlStatusSource,
      intervalMs: 3000,
    });
    historyIpc?.bind?.(historySyncService);
    void historySyncService.start();
  });

  app.on('browser-window-focus', () => {
    registerGlobalShortcuts();
  });

  app.on('browser-window-blur', () => {
    if (BrowserWindow.getFocusedWindow()) return;
    unregisterGlobalShortcuts();
  });

  app.on('will-quit', () => {
    unregisterGlobalShortcuts();
    historySyncService?.stop?.();
    settingsIpcCleanup?.();
    onboardingIpcCleanup?.();
  });

    ipcMain.handle('clipboard:read', (event) => {
      if (!isTrustedIpcSender(event)) return '';
      try {
        return clipboard.readText();
      } catch (_) {
        return '';
      }
    });

    ipcMain.handle('clipboard:write', (event, { text } = {}) => {
      if (!isTrustedIpcSender(event)) return { success: false, error: 'Untrusted sender' };
      try {
        clipboard.writeText(typeof text === 'string' ? text : '');
        return { success: true };
      } catch (e) {
        return { success: false, error: e?.message || 'Clipboard write failed' };
      }
    });

    ipcMain.handle('app:reset', (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return { success: false, error: 'Untrusted sender' };
      const rollbackClaude = Boolean(payload?.rollbackClaude);
      setTimeout(() => {
        scheduleResetRelaunch({ rollbackClaude });
      }, 50);
      return { success: true };
    });

    ipcMain.handle('terminal:list-profiles', async (event) => {
      if (!isTrustedIpcSender(event)) return { profiles: [] };
      const { distros, available } = await listWslDistros();
      const profiles = buildTerminalProfiles({ wslDistros: distros, wslAvailable: available });
      return { profiles };
    });

    // ターミナル開始
    ipcMain.handle('terminal:start', async (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return { success: false, error: 'Untrusted sender' };
      const tabId = normalizeTabId(payload.tabId);
      if (!tabId) return { success: false, error: 'Invalid tabId' };
      const cols = clampInt(payload.cols, 2, 1000, 80);
      const rows = clampInt(payload.rows, 2, 1000, 24);
      const cwd = typeof payload.cwd === 'string' ? payload.cwd.trim().slice(0, 4096) : '';
      const profileId = normalizeProfileId(payload.profileId);

      const webContentsId = event.sender.id;
      tabRegistry.register(tabId, webContentsId);
      // ptyManagerが初期化されるまで待機
      while (!ptyManager) {
        await new Promise(r => setTimeout(r, 10));
      }
      const target = webContents.fromId(webContentsId);
      if (!target || target.isDestroyed()) {
        tabRegistry.unregister(tabId);
        return { success: false, error: 'Window closed' };
      }
      const spawnOptions = {};
      if (cwd) spawnOptions.cwd = cwd;
      if (profileId) spawnOptions.profileId = profileId;
      if (profileId) recordWslDistroUsage(profileId);
      try {
        await ptyManager.spawn(tabId, cols, rows, sendTerminalOutput, spawnOptions);
        return { success: true };
      } catch (err) {
        console.error('[terminal:start] spawn failed:', err);
        return { success: false, error: 'Failed to start terminal' };
      }
    });

    ipcMain.handle('terminal:attach', async (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return { success: false, error: 'Untrusted sender' };
      const tabId = normalizeTabId(payload.tabId);
      if (!tabId) return { success: false, error: 'Missing tabId' };
      const webContentsId = event.sender.id;
      tabRegistry.register(tabId, webContentsId);
      while (!ptyManager) {
        await new Promise(r => setTimeout(r, 10));
      }
      if (!ptyManager?.has?.(tabId)) {
        return { success: false, error: 'PTY not found' };
      }
      const cols = payload.cols;
      const rows = payload.rows;
      if (Number.isFinite(cols) && Number.isFinite(rows)) {
        ptyManager.resize(tabId, clampInt(cols, 2, 1000, 80), clampInt(rows, 2, 1000, 24));
      }
      return { success: true };
    });

    ipcMain.handle('history:warmup-wsl', async (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return { ok: false, attempted: 0, error: 'Untrusted sender' };
      const timeoutMs = clampInt(payload.timeoutMs, 200, 5000, WSL_WARMUP_TIMEOUT_MS);
      const profileIds = Array.isArray(payload.profileIds) ? payload.profileIds : [];
      logHistoryDebug('history:warmup-wsl request', { timeoutMs, profileIds });
      for (const profileId of profileIds) {
        const normalized = normalizeProfileId(profileId);
        if (normalized) recordWslDistroUsage(normalized);
      }
      const result = await warmupUsedWslDistros({ timeoutMs });
      if (result?.attempted) {
        historyService?.resetWslCaches?.();
      }
      logHistoryDebug('history:warmup-wsl result', result);
      return result;
    });
  
    // 入力送信
    ipcMain.on('terminal:input', (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return;
      const tabId = normalizeTabId(payload.tabId);
      if (!tabId) return;
      const data = payload.data;
      if (typeof data !== 'string' || data.length === 0) return;
      // 1回のIPCで極端に大きい入力は拒否（通常の貼り付けはチャンク送信される）
      if (data.length > 1_000_000) return;
      ptyManager?.write(tabId, data);
    });
  
    // リサイズ
    ipcMain.on('terminal:resize', (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return;
      const tabId = normalizeTabId(payload.tabId);
      if (!tabId) return;
      const cols = payload.cols;
      const rows = payload.rows;
      if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
      ptyManager?.resize(tabId, clampInt(cols, 2, 1000, 80), clampInt(rows, 2, 1000, 24));
    });
  
    // ターミナル終了
    ipcMain.handle('terminal:close', async (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return { success: false, error: 'Untrusted sender' };
      const tabId = normalizeTabId(payload.tabId);
      if (!tabId) return { success: false, error: 'Missing tabId' };
      tabRegistry.unregister(tabId);
      ptyManager?.kill(tabId);
      return { success: true };
    });
  
      // Get current working directory of PTY
    ipcMain.handle('terminal:getCwd', async (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return { cwd: null };
      const tabId = normalizeTabId(payload.tabId);
      if (!tabId) return { cwd: null };
      const cwd = await ptyManager?.getCwd(tabId);
      return { cwd: typeof cwd === 'string' ? cwd : null };
    });

    ipcMain.handle('terminal:status', async (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return { ok: false, error: 'Untrusted sender' };
      const tabId = normalizeTabId(payload.tabId);
      if (!tabId) return { ok: false, error: 'Missing tabId' };
      const callerWebContentsId = event.sender.id;
      const mappedWebContentsId = tabRegistry.getWebContentsId(tabId);
      const hasPty = Boolean(ptyManager?.has?.(tabId));
      const mappingMismatch = Boolean(mappedWebContentsId && mappedWebContentsId !== callerWebContentsId);
      return {
        ok: true,
        tabId,
        hasPty,
        mappingMismatch,
        mappedWebContentsId: mappedWebContentsId || null,
        callerWebContentsId,
      };
    });

    // セッション復元/保存
    ipcMain.handle('session:get-restore-window', async (event, { windowKey } = {}) => {
      if (!isTrustedIpcSender(event)) return null;
      if (!sessionStore || !windowKey) return null;
      return sessionStore.buildRestorePayloadForWindow(String(windowKey));
    });
  
    ipcMain.handle('session:get-snapshot-config', async (event) => {
      if (!isTrustedIpcSender(event)) return null;
      if (!sessionStore) return null;
      return sessionStore.workspace?.snapshot || null;
    });

    ipcMain.handle('config:auto-config', async (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return { success: false, error: 'Untrusted sender' };
      if (!autoConfigService) {
        autoConfigService = new AutoConfigService({ userHome: os.homedir() });
      }
      const enableWsl = payload?.enableWsl !== false;
      try {
        const result = await autoConfigService.apply({ enableWsl });
        if (!result?.ok) {
          return {
            success: false,
            results: result?.results || null,
            error: result?.error || 'auto-config failed',
            warnings: result?.warnings || null,
          };
        }
        return {
          success: true,
          results: result?.results || null,
          warnings: result?.warnings || null,
        };
      } catch (error) {
        return { success: false, error: error?.message || 'auto-config failed' };
      }
    });
  
    ipcMain.on('session:update-window', (event, payload) => {
      if (!isTrustedIpcSender(event)) return;
      const windowKey = payload?.windowKey;
      const state = payload?.state;
      if (!sessionStore || !windowKey || !state) return;

    // Renderer側のbeforeunload等で、ウィンドウclose後に遅延したIPCが届くことがある。
    // その場合、消したはずのウィンドウが session に復活してしまうので、
    // 送信元の BrowserWindow が生存していて、かつ windowKey が一致する場合のみ反映する。
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const actualKey = win.__kawaiiSessionKey || null;
    if (!actualKey || String(actualKey) !== String(windowKey)) return;

      sessionStore.updateWindowState(String(windowKey), state);
    });
  
    ipcMain.handle('session:save-snapshots', async (event, payload) => {
      if (!isTrustedIpcSender(event)) return { success: false };
      const snapshots = Array.isArray(payload?.snapshots) ? payload.snapshots : [];
      if (!sessionStore || snapshots.length === 0) return { success: false };
      sessionStore.saveSnapshots(snapshots);
      return { success: true };
    });

    // リカバリモーダルの選択受信
    ipcMain.on('session:recovery-choice', (event, payload) => {
      if (!isTrustedIpcSender(event)) return;
      const choice = payload?.choice;
      if (pendingRecoveryResolve && choice) {
        pendingRecoveryResolve(choice);
        pendingRecoveryResolve = null;
      }
    });

    // ウィンドウ操作
    ipcMain.on('window:minimize', (event) => {
      if (!isTrustedIpcSender(event)) return;
      const win = BrowserWindow.fromWebContents(event.sender);
      win?.minimize();
    });
  
    ipcMain.on('window:maximize', (event) => {
      if (!isTrustedIpcSender(event)) return;
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win?.isMaximized()) {
        win.unmaximize();
      } else {
        win?.maximize();
      }
    });

    // タイトルバーダブルクリック（OS準拠の動作）
    ipcMain.on('window:titlebar-double-click', (event) => {
      if (!isTrustedIpcSender(event)) return;
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return;

      if (process.platform === 'darwin') {
        // macOS: システム設定に従う（Maximize/Zoom or Minimize）
        const action = systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string');
        if (action === 'Minimize') {
          win.minimize();
        } else {
          // 'Maximize' or undefined -> Zoom（最大化トグル）
          if (win.isMaximized()) {
            win.unmaximize();
          } else {
            win.maximize();
          }
        }
      } else {
        // Windows/Linux: 最大化トグル
        if (win.isMaximized()) {
          win.unmaximize();
        } else {
          win.maximize();
        }
      }
    });

    ipcMain.on('window:close', (event) => {
      if (!isTrustedIpcSender(event)) return;
      const win = BrowserWindow.fromWebContents(event.sender);
      win?.close();
    });
  
    ipcMain.on('window:setPosition', (event, { x, y }) => {
      if (!isTrustedIpcSender(event)) return;
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && Number.isFinite(x) && Number.isFinite(y)) {
        win.setPosition(Math.round(x), Math.round(y));
      }
    });
  
  ipcMain.on('window:setOpacity', (event, { opacity }) => {
    if (!isTrustedIpcSender(event)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && Number.isFinite(opacity)) {
      win.setOpacity(Math.max(0, Math.min(1, opacity)));
    }
  });

  ipcMain.on('window:setBounds', (event, payload = {}) => {
    if (!isTrustedIpcSender(event)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    const bounds = {};
    if (Number.isFinite(payload.x)) bounds.x = Math.round(payload.x);
    if (Number.isFinite(payload.y)) bounds.y = Math.round(payload.y);
    if (Number.isFinite(payload.width)) bounds.width = Math.round(payload.width);
    if (Number.isFinite(payload.height)) bounds.height = Math.round(payload.height);
    if (Object.keys(bounds).length === 0) return;
    win.setBounds(bounds);
  });
  
    ipcMain.on('window:new', (event) => {
      if (!isTrustedIpcSender(event)) return;
      const win = createWindow({ sessionKey: createSessionKey() });
      win.focus();
    });
  
    ipcMain.handle('window:new', (event, options = {}) => {
      if (!isTrustedIpcSender(event)) return { windowId: null, error: 'Untrusted sender' };
      const rawBounds = options?.bounds;
      const bounds = rawBounds && typeof rawBounds === 'object'
        ? {
            x: Number.isFinite(rawBounds.x) ? Math.round(rawBounds.x) : undefined,
            y: Number.isFinite(rawBounds.y) ? Math.round(rawBounds.y) : undefined,
            width: Number.isFinite(rawBounds.width) ? Math.round(rawBounds.width) : undefined,
            height: Number.isFinite(rawBounds.height) ? Math.round(rawBounds.height) : undefined,
          }
        : undefined;
      const hasBounds = bounds && Object.values(bounds).some((v) => Number.isFinite(v));
      const win = createWindow({ bounds: hasBounds ? bounds : undefined, sessionKey: createSessionKey() });
      win.focus();
      return { windowId: win.id };
    });
  
    // DevToolsトグル
    ipcMain.on('window:toggleDevTools', (event) => {
      if (!isTrustedIpcSender(event)) return;
      const win = BrowserWindow.fromWebContents(event.sender);
      win?.webContents.toggleDevTools();
    });

    ipcMain.on('tab:drag-start', (event, payload) => {
      if (!isTrustedIpcSender(event)) return;
      if (!payload || typeof payload !== 'object') return;
      startTabDragSession(payload);
    });
  
    ipcMain.on('tab:drag-move', (event, payload) => {
      if (!isTrustedIpcSender(event)) return;
      if (!dragSession || !payload) return;
      const { screenX, screenY, forceDetach } = payload;
      if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return;
      const point = { x: Math.round(screenX), y: Math.round(screenY) };
    dragSession.lastPoint = point;
    dragSession.forceDetach = Boolean(forceDetach);

    const tabbarWin = findWindowAtTabbar(point, dragSession.tabbarHeight);
    const hoverWindowId = tabbarWin?.id || null;
    if (hoverWindowId !== dragSession.hoverWindowId) {
      if (dragSession.hoverWindowId) {
        const prevWin = windowManager.getById(dragSession.hoverWindowId);
        if (prevWin && !prevWin.isDestroyed()) {
          prevWin.webContents.send('window:tab-drag-leave', { sourceWindowId: dragSession.sourceWindowId });
        }
      }
      dragSession.hoverWindowId = hoverWindowId;
    }

    if (tabbarWin && !tabbarWin.isDestroyed()) {
      tabbarWin.webContents.send('window:tab-drag-over', {
        sourceWindowId: dragSession.sourceWindowId,
        tabId: dragSession.tabId,
        title: dragSession.title,
        screenX: point.x,
        screenY: point.y,
      });
    }
    });
  
    ipcMain.on('tab:drag-end', (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return;
      if (!dragSession) return;
      const endX = Number.isFinite(payload.screenX) ? payload.screenX : dragSession.lastPoint?.x;
      const endY = Number.isFinite(payload.screenY) ? payload.screenY : dragSession.lastPoint?.y;
      if (!Number.isFinite(endX) || !Number.isFinite(endY)) {
      stopTabDragSession();
      return;
    }

    const point = { x: Math.round(endX), y: Math.round(endY) };
    const overWin = findWindowAtTabbar(point, dragSession.tabbarHeight);
    const isDifferentWindow = overWin && String(overWin.id) !== String(dragSession.sourceWindowId);
    const adoptPayload = dragSession.adoptPayload;
    const forceDetach = Boolean(payload.forceDetach) || dragSession.forceDetach;

    if (isDifferentWindow && adoptPayload?.tabId) {
      overWin.webContents.send('window:adopt-tab', adoptPayload);
      if (dragSession.sourceWindowId) {
        const sourceWin = windowManager.getById(dragSession.sourceWindowId);
        if (sourceWin && !sourceWin.isDestroyed()) {
          sourceWin.webContents.send('window:tab-drop-accepted', { tabId: adoptPayload.tabId });
        }
      }
    } else {
      const absDy = Math.abs(point.y - dragSession.startScreenY);
      const threshold = dragSession.visible ? dragSession.attachThreshold : dragSession.detachThreshold;
      const shouldDetach = forceDetach || (absDy > threshold && !overWin);
      if (shouldDetach && adoptPayload?.tabId) {
        const bounds = {
          x: Math.round(point.x - dragSession.offsetX),
          y: Math.round(point.y - dragSession.offsetY),
          width: Math.round(dragSession.width),
          height: Math.round(dragSession.height),
        };
        createWindow({ bounds, adoptPayload });
      }
    }

    if (dragSession.hoverWindowId) {
      const hoverWin = windowManager.getById(dragSession.hoverWindowId);
      if (hoverWin && !hoverWin.isDestroyed()) {
        hoverWin.webContents.send('window:tab-drag-leave', { sourceWindowId: dragSession.sourceWindowId });
      }
    }
      stopTabDragSession();
    });
  
    ipcMain.on('tab:transferred', (event, { sourceWindowId, tabId } = {}) => {
      if (!isTrustedIpcSender(event)) return;
      if (!sourceWindowId || !tabId) return;
      const sourceWin = windowManager.getById(sourceWindowId);
      if (!sourceWin || sourceWin.isDestroyed()) return;
      sourceWin.webContents.send('window:tab-transferred', { tabId });
    });

    // Create new window with tab payload (for pane-to-window conversion)
    ipcMain.on('window:create-with-tab', (event, { payload, screenX, screenY } = {}) => {
      if (!isTrustedIpcSender(event)) return;
      if (!payload?.tabId) return;
      const bounds = {
        x: Math.round(screenX - 100),
        y: Math.round(screenY - 50),
        width: 800,
        height: 600,
      };
      createWindow({ bounds, adoptPayload: payload });
    });
  
    ipcMain.on('tab:drop-accepted', (event, { sourceWindowId, tabId } = {}) => {
      if (!isTrustedIpcSender(event)) return;
      if (!sourceWindowId || !tabId) return;
      const sourceWin = windowManager.getById(sourceWindowId);
      if (!sourceWin || sourceWin.isDestroyed()) return;
      sourceWin.webContents.send('window:tab-drop-accepted', { tabId });
    });
  
    // 応援メッセージ生成
    ipcMain.handle('cheer:generate', async (event, { language, session_id } = {}) => {
      if (!isTrustedIpcSender(event)) return { error: 'Untrusted sender' };
      const service = await waitForCheerService();
      if (!service) return { error: 'CheerService not ready' };
      const safeLang = language === 'en' ? 'en' : 'ja';
      const safeSession = typeof session_id === 'string' ? session_id.slice(0, 400) : null;
      return service.generateCheer(safeLang, safeSession);
    });
  
    // 応援メッセージ依存チェック
    ipcMain.handle('cheer:check', async (event) => {
      if (!isTrustedIpcSender(event)) return { available: false, missing: [] };
      const service = await waitForCheerService();
    if (!service) return { available: false, missing: ['claude'] };
      return service.checkDependencies({ refresh: true });
    });

    // セッション要約生成 (Gemini)
    ipcMain.handle('summary:generate', async (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return { ok: false, error: 'Untrusted sender' };
      const service = await waitForSummaryService();
      if (!service) return { ok: false, error: 'SummaryService not ready' };
      const source = typeof payload.source === 'string' ? payload.source : '';
      const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
      return service.generateSummary({ source, session_id: sessionId });
    });

    ipcMain.handle('summary:check', async (event) => {
      if (!isTrustedIpcSender(event)) return { available: false, enabled: false, hasKey: false };
      const service = await waitForSummaryService();
      if (!service) return { available: false, enabled: false, hasKey: false };
      return service.checkAvailability();
    });

    ipcMain.handle('ai:check', async (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return { ok: false, available: false, error: 'Untrusted sender' };
      const service = await waitForCapabilityService();
      if (!service) return { ok: false, available: false, error: 'CapabilityService not ready' };
      const feature = typeof payload?.feature === 'string' ? payload.feature : '';
      const refresh = Boolean(payload?.refresh);
      return service.checkFeature(feature, { refresh });
    });

    ipcMain.handle('git:check', async (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return { ok: false, available: false, error: 'Untrusted sender' };
      const service = await waitForGitService();
      if (!service) return { ok: false, available: false, error: 'GitService not ready' };
      return service.checkRepo(payload || {});
    });

    ipcMain.handle('git:status', async (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return { ok: false, error: 'Untrusted sender' };
      const service = await waitForGitService();
      if (!service) return { ok: false, error: 'GitService not ready' };
      return service.getStatus(payload || {});
    });

    ipcMain.handle('git:diff', async (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return { ok: false, error: 'Untrusted sender' };
      const service = await waitForGitService();
      if (!service) return { ok: false, error: 'GitService not ready' };
      return service.getDiff(payload || {});
    });

    ipcMain.handle('git:commit', async (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return { ok: false, error: 'Untrusted sender' };
      const service = await waitForGitService();
      if (!service) return { ok: false, error: 'GitService not ready' };
      return service.commit(payload || {});
    });

    ipcMain.handle('git:push', async (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return { ok: false, error: 'Untrusted sender' };
      const service = await waitForGitService();
      if (!service) return { ok: false, error: 'GitService not ready' };
      return service.push(payload || {});
    });

    ipcMain.handle('ai:commit-message', async (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return { ok: false, error: 'Untrusted sender' };
      const service = await waitForCommitMessageService();
      if (!service) return { ok: false, error: 'CommitMessageService not ready' };
      return service.generate(payload || {});
    });

    ipcMain.handle('history:check-cwd', async (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return { checked: false, exists: false, error: 'Untrusted sender' };
      const cwd = typeof payload?.cwd === 'string' ? payload.cwd.trim() : '';
      if (!cwd) return { checked: false, exists: false, error: 'Missing cwd' };
      const isWindows = process.platform === 'win32';
      let resolvedCwd = cwd;
      if (isWindows && cwd.startsWith('/')) {
        const match = cwd.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
        if (match) {
          const drive = match[1].toUpperCase();
          const rest = match[2] ? match[2].replace(/\//g, '\\') : '';
          resolvedCwd = `${drive}:\\${rest}`;
        } else {
          return { checked: false, exists: false, error: 'WSL path' };
        }
      }

      const normalized = resolvedCwd.replace(/\//g, '\\');
      const isLikelyWslPath = /^\\\\wsl(?:\\.localhost)?(?:\\$)?\\\\[^\\]+/i.test(normalized);
      if (isLikelyWslPath) return { checked: false, exists: false, error: 'WSL path' };

      if (!path.isAbsolute(resolvedCwd)) return { checked: false, exists: false, error: 'Not absolute' };

      try {
        const stats = fs.statSync(resolvedCwd);
        return { checked: true, exists: stats.isDirectory() };
      } catch (error) {
        return { checked: true, exists: false, error: error?.message || 'Not found' };
      }
    });

    // セッション一覧
    ipcMain.handle('history:list-sessions', async (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return { sessions: [] };
      const service = await waitForHistoryService();
      if (!service?.repository?.listSessions) return { sessions: [] };
      const { limit, source, cursor, chunk_size } = payload || {};
      const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : undefined;
      const safeSource = typeof source === 'string' ? source : undefined;
      const safeCursor = Number.isFinite(cursor) ? cursor : undefined;
      const safeChunkSize = Number.isFinite(chunk_size) ? chunk_size : undefined;
      return service.repository.listSessions({
        limit: safeLimit,
        source: safeSource,
        cursor: safeCursor,
        chunk_size: safeChunkSize,
      });
    });

    // セッション履歴読み込み
    ipcMain.handle('history:load-session', async (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return { blocks: [] };
      const service = await waitForHistoryService();
      if (!service?.repository?.loadSession) return { blocks: [] };
      const { session_id, source, limit, project_path, project_dir, source_path, load_all } = payload || {};
      const safeSessionId = typeof session_id === 'string' ? session_id : undefined;
      const safeSource = typeof source === 'string' ? source : undefined;
      const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : undefined;
      const safeProject = typeof project_path === 'string' ? project_path : undefined;
      const safeProjectDir = typeof project_dir === 'string' ? project_dir : undefined;
      const safeSourcePath = typeof source_path === 'string' ? source_path : undefined;
      const safeLoadAll = Boolean(load_all);
      return service.repository.loadSession({
        session_id: safeSessionId,
        source: safeSource,
        limit: safeLimit,
        project_path: safeProject,
        project_dir: safeProjectDir,
        source_path: safeSourcePath,
        load_all: safeLoadAll,
      });
    });

    ipcMain.handle('history:get-meta', async (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return { signature: '' };
      const service = await waitForHistoryService();
      if (!service?.repository?.getMeta) return { signature: '' };
      const { source } = payload || {};
      const safeSource = typeof source === 'string' ? source : undefined;
      return service.repository.getMeta({ source: safeSource });
    });

    ipcMain.handle('history:search', async (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return { error: 'Untrusted sender' };
      const service = await waitForHistoryService();
      if (!service?.search) return { error: 'HistoryService not ready' };
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
      const safeQuery = typeof query === 'string' ? query.slice(0, 2000) : '';
      const safeBlocks = Array.isArray(blocks) ? blocks : undefined;
      const safeMode = typeof mode === 'string' ? mode : undefined;
      const safeSource = typeof source === 'string' ? source : undefined;
      const safeProjectPath = typeof project_path === 'string' ? project_path : undefined;
      const safeProjectDir = typeof project_dir === 'string' ? project_dir : undefined;
      const safeProjectScope = typeof project_scope === 'string' ? project_scope : undefined;
      const safePaneId = typeof pane_id === 'string' ? pane_id : undefined;
      const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : undefined;
      const safeCursor = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : undefined;
      const safeChunkSize = Number.isFinite(chunk_size) ? Math.max(1, Math.floor(chunk_size)) : undefined;
      return service.search({
        query: safeQuery,
        blocks: safeBlocks,
        mode: safeMode,
        source: safeSource,
        project_path: safeProjectPath,
        project_dir: safeProjectDir,
        project_scope: safeProjectScope,
        pane_id: safePaneId,
        limit: safeLimit,
        cursor: safeCursor,
        chunk_size: safeChunkSize,
      });
    });

    ipcMain.handle('history:deep-search', async (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return { error: 'Untrusted sender' };
      const service = await waitForHistoryService();
      if (!service?.deepSearch) return { error: 'HistoryService not ready' };
      const { query, source, project_path } = payload || {};
      const safeQuery = typeof query === 'string' ? query.slice(0, 2000) : '';
      const safeSource = typeof source === 'string' ? source : undefined;
      const safeProjectPath = typeof project_path === 'string' ? project_path : undefined;
      return service.deepSearch({
        query: safeQuery,
        source: safeSource,
        project_path: safeProjectPath,
      });
    });

    ipcMain.handle('history:time-machine', async (event, payload = {}) => {
      if (!isTrustedIpcSender(event)) return { success: false, error: 'Untrusted sender' };
      const service = await waitForHistoryService();
      if (!service?.repository?.createTimeMachine) return { success: false, error: 'HistoryService not ready' };
      const { block } = payload || {};
      return service.repository.createTimeMachine({ block });
    });

    app.on('activate', () => {
      if (windowManager.getAll().length === 0) {
        createWindow();
      }
    });
  });
}

// アプリ終了前にPTYを確実にクリーンアップ
app.on('before-quit', () => {
  isQuitting = true;
  stopTabDragSession();
  // localStorageをディスクにフラッシュ（終了時に保存されない問題の修正）
  session.defaultSession.flushStorageData();
  try {
    sessionStore?.markCleanExit?.({ appVersion: app.getVersion() });
  } catch (_) { /* noop */ }
  if (ptyManager) {
    ptyManager.killAll();
    ptyManager = null;
  }
  cleanupCachesOnExit();
  cleanupTempPinsOnExit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
