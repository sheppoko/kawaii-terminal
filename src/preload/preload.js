const { contextBridge, ipcRenderer, shell, webUtils } = require('electron');

let markdownReady = false;
let markdownInitPromise = null;
let markdownParse = (content) => String(content ?? '');

async function initMarkdownParser() {
  if (markdownReady) return;
  if (!markdownInitPromise) {
    markdownInitPromise = (async () => {
      let markedModule = null;
      try {
        markedModule = require('marked');
      } catch (err) {
        if (err && err.code === 'ERR_REQUIRE_ESM') {
          const mod = await import('marked');
          markedModule = mod?.marked || mod?.default || mod;
        } else {
          throw err;
        }
      }

      const marked = markedModule?.marked || markedModule;
      if (!marked) return;

      let hljs = null;
      try {
        hljs = require('highlight.js');
      } catch (_) {
        hljs = null;
      }

      if (typeof marked.setOptions === 'function') {
        marked.setOptions({
          gfm: true,
          breaks: true,
          highlight: function (code, lang) {
            if (hljs && lang && hljs.getLanguage(lang)) {
              try {
                return hljs.highlight(code, { language: lang }).value;
              } catch (_) { /* noop */ }
            }
            if (hljs) {
              try {
                return hljs.highlightAuto(code).value;
              } catch (_) { /* noop */ }
            }
            return code;
          },
        });
      }

      if (typeof marked.parse === 'function') {
        markdownParse = (content) => marked.parse(content);
      } else if (typeof marked === 'function') {
        markdownParse = (content) => marked(content);
      }
    })()
      .catch((err) => {
        console.error('[markdownAPI] Failed to init:', err);
      })
      .finally(() => {
        markdownReady = true;
      });
  }
  await markdownInitPromise;
}

// Markdown API
contextBridge.exposeInMainWorld('markdownAPI', {
  parse: async (content) => {
    try {
      await initMarkdownParser();
      return markdownParse(String(content ?? ''));
    } catch (err) {
      console.error('[markdownAPI] Parse failed:', err);
      return String(content ?? '');
    }
  },
});

async function exposeDomPurify() {
  let mod = null;
  try {
    mod = require('dompurify');
  } catch (err) {
    if (err && err.code === 'ERR_REQUIRE_ESM') {
      mod = await import('dompurify');
    } else {
      throw err;
    }
  }
  const createDOMPurify = mod?.default || mod;
  if (typeof createDOMPurify !== 'function') {
    throw new Error('DOMPurify export is not a function.');
  }
  const domContext = typeof globalThis.window !== 'undefined' ? globalThis.window : globalThis;
  const purifier = createDOMPurify(domContext);
  if (!purifier || typeof purifier.sanitize !== 'function') {
    throw new Error('DOMPurify sanitizer is unavailable.');
  }
  contextBridge.exposeInMainWorld('DOMPurify', purifier);
}

exposeDomPurify().catch((err) => {
  console.error('[preload] DOMPurify failed to load:', err);
  process.nextTick(() => {
    throw err;
  });
});

// ANSI to HTML API (supports 16/256/24-bit colors)
const ANSI_THEME_FALLBACK = {
  defaultFg: '#e0e0e0',
  defaultBg: '#1e1e1e',
  palette: [
    '#0c0c0c', '#c50f1f', '#13a10e', '#c19c00',
    '#0037da', '#881798', '#3a96dd', '#cccccc',
    '#767676', '#e74856', '#16c60c', '#f9f1a5',
    '#3b78ff', '#b4009e', '#61d6d6', '#f2f2f2',
  ],
};
let ANSI_DEFAULT_FG = ANSI_THEME_FALLBACK.defaultFg;
let ANSI_DEFAULT_BG = ANSI_THEME_FALLBACK.defaultBg;
let ANSI_PALETTE_16 = ANSI_THEME_FALLBACK.palette.slice();

function normalizeAnsiColor(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function setAnsiTheme(theme = {}) {
  const nextFg = normalizeAnsiColor(theme.defaultFg);
  if (nextFg) ANSI_DEFAULT_FG = nextFg;
  const nextBg = normalizeAnsiColor(theme.defaultBg);
  if (nextBg) ANSI_DEFAULT_BG = nextBg;
  if (Array.isArray(theme.palette) && theme.palette.length >= 16) {
    ANSI_PALETTE_16 = ANSI_THEME_FALLBACK.palette.map((fallback, idx) => {
      const value = normalizeAnsiColor(theme.palette[idx]);
      return value || fallback;
    });
  }
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ansi256ToCss(index) {
  const idx = Number(index);
  if (!Number.isFinite(idx)) return null;
  if (idx >= 0 && idx < ANSI_PALETTE_16.length) {
    return ANSI_PALETTE_16[idx];
  }
  if (idx >= 16 && idx <= 231) {
    const offset = idx - 16;
    const r = Math.floor(offset / 36);
    const g = Math.floor((offset % 36) / 6);
    const b = offset % 6;
    const levels = [0, 95, 135, 175, 215, 255];
    return `rgb(${levels[r]},${levels[g]},${levels[b]})`;
  }
  if (idx >= 232 && idx <= 255) {
    const level = 8 + (idx - 232) * 10;
    return `rgb(${level},${level},${level})`;
  }
  return null;
}

function buildAnsiStyle(state) {
  let fg = state.fg;
  let bg = state.bg;
  if (state.inverse) {
    const nextFg = bg || ANSI_DEFAULT_BG;
    const nextBg = fg || ANSI_DEFAULT_FG;
    fg = nextFg;
    bg = nextBg;
  }

  const styles = [];
  if (fg) styles.push(`color:${fg};`);
  if (bg) styles.push(`background-color:${bg};`);
  if (state.bold) styles.push('font-weight:bold;');
  if (state.italic) styles.push('font-style:italic;');
  if (state.dim) styles.push('opacity:0.7;');
  const decorations = [];
  if (state.underline) decorations.push('underline');
  if (state.strike) decorations.push('line-through');
  if (decorations.length > 0) styles.push(`text-decoration:${decorations.join(' ')};`);
  return styles.join('');
}

function ansiToHtml(text) {
  if (typeof text !== 'string') return '';
  if (!text) return '';

  let out = '';
  let open = false;
  let currentStyle = '';
  const state = {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strike: false,
    inverse: false,
  };

  const applyStyle = () => {
    const css = buildAnsiStyle(state);
    if (css === currentStyle) return;
    if (open) {
      out += '</span>';
      open = false;
    }
    currentStyle = css;
    if (css) {
      out += `<span style="${css}">`;
      open = true;
    }
  };

  const resetState = () => {
    state.fg = null;
    state.bg = null;
    state.bold = false;
    state.dim = false;
    state.italic = false;
    state.underline = false;
    state.strike = false;
    state.inverse = false;
  };

  const handleSgr = (params) => {
    if (params.length === 0) params = [0];
    for (let i = 0; i < params.length; i += 1) {
      const code = Number(params[i]) || 0;
      if (code === 0) {
        resetState();
        continue;
      }
      if (code === 1) { state.bold = true; continue; }
      if (code === 2) { state.dim = true; continue; }
      if (code === 3) { state.italic = true; continue; }
      if (code === 4) { state.underline = true; continue; }
      if (code === 7) { state.inverse = true; continue; }
      if (code === 9) { state.strike = true; continue; }
      if (code === 22) { state.bold = false; state.dim = false; continue; }
      if (code === 23) { state.italic = false; continue; }
      if (code === 24) { state.underline = false; continue; }
      if (code === 27) { state.inverse = false; continue; }
      if (code === 29) { state.strike = false; continue; }
      if (code === 39) { state.fg = null; continue; }
      if (code === 49) { state.bg = null; continue; }

      if (code >= 30 && code <= 37) {
        state.fg = ANSI_PALETTE_16[code - 30];
        continue;
      }
      if (code >= 90 && code <= 97) {
        state.fg = ANSI_PALETTE_16[8 + (code - 90)];
        continue;
      }
      if (code >= 40 && code <= 47) {
        state.bg = ANSI_PALETTE_16[code - 40];
        continue;
      }
      if (code >= 100 && code <= 107) {
        state.bg = ANSI_PALETTE_16[8 + (code - 100)];
        continue;
      }
      if (code === 38 || code === 48) {
        const mode = Number(params[i + 1]);
        if (mode === 5 && Number.isFinite(Number(params[i + 2]))) {
          const color = ansi256ToCss(params[i + 2]);
          if (code === 38) state.fg = color;
          else state.bg = color;
          i += 2;
          continue;
        }
        if (mode === 2 && Number.isFinite(Number(params[i + 2])) && Number.isFinite(Number(params[i + 3])) && Number.isFinite(Number(params[i + 4]))) {
          const r = Math.max(0, Math.min(255, Number(params[i + 2])));
          const g = Math.max(0, Math.min(255, Number(params[i + 3])));
          const b = Math.max(0, Math.min(255, Number(params[i + 4])));
          const color = `rgb(${r},${g},${b})`;
          if (code === 38) state.fg = color;
          else state.bg = color;
          i += 4;
        }
        continue;
      }
    }
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\x1b') {
      const next = text[i + 1];
      if (next === '[') {
        let j = i + 2;
        let codes = '';
        while (j < text.length && !/[A-Za-z]/.test(text[j])) {
          codes += text[j];
          j += 1;
        }
        const command = text[j] || '';
        if (command === 'm') {
          const params = codes.length ? codes.split(';').map(item => item.trim()).filter(item => item !== '') : [];
          handleSgr(params);
          applyStyle();
        }
        i = j;
        continue;
      }
      if (next === ']') {
        let j = i + 2;
        while (j < text.length) {
          if (text[j] === '\x07') {
            j += 1;
            break;
          }
          if (text[j] === '\x1b' && text[j + 1] === '\\') {
            j += 2;
            break;
          }
          j += 1;
        }
        i = j - 1;
        continue;
      }
      continue;
    }
    if (ch === '\r') {
      continue;
    }
    out += escapeHtml(ch);
  }

  if (open) {
    out += '</span>';
  }
  return out;
}

contextBridge.exposeInMainWorld('ansiAPI', {
  toHtml: (text) => {
    try {
      return ansiToHtml(text);
    } catch (err) {
      console.error('[ansiAPI] Conversion failed:', err);
      return escapeHtml(text || '');
    }
  },
  setTheme: (theme) => {
    try {
      setAnsiTheme(theme || {});
    } catch (err) {
      console.error('[ansiAPI] Failed to set theme:', err);
    }
  },
});

const terminalOutputSubscribers = new Set();
const terminalActivitySubscribers = new Set();
let terminalOutputListenerAttached = false;

const terminalOutputListener = (_event, payload) => {
  if (terminalOutputSubscribers.size > 0) {
    terminalOutputSubscribers.forEach((callback) => {
      try {
        callback(payload);
      } catch (err) {
        console.error('[terminalAPI] onOutput callback failed:', err);
      }
    });
  }
  if (terminalActivitySubscribers.size > 0) {
    terminalActivitySubscribers.forEach((callback) => {
      try {
        callback();
      } catch (err) {
        console.error('[avatarAPI] onTerminalActivity callback failed:', err);
      }
    });
  }
};

const ensureTerminalOutputListener = () => {
  if (terminalOutputListenerAttached) return;
  ipcRenderer.on('terminal:output', terminalOutputListener);
  terminalOutputListenerAttached = true;
};

const maybeRemoveTerminalOutputListener = () => {
  if (!terminalOutputListenerAttached) return;
  if (terminalOutputSubscribers.size > 0 || terminalActivitySubscribers.size > 0) return;
  ipcRenderer.removeListener('terminal:output', terminalOutputListener);
  terminalOutputListenerAttached = false;
};

// ターミナルAPI
contextBridge.exposeInMainWorld('terminalAPI', {
  start: (tabId, cols, rows, options = {}) => ipcRenderer.invoke('terminal:start', { tabId, cols, rows, ...options }),
  attach: (tabId, cols, rows) => ipcRenderer.invoke('terminal:attach', { tabId, cols, rows }),
  sendInput: (tabId, data) => ipcRenderer.send('terminal:input', { tabId, data }),
  resize: (tabId, cols, rows) => ipcRenderer.send('terminal:resize', { tabId, cols, rows }),
  close: (tabId) => ipcRenderer.invoke('terminal:close', { tabId }),
  getCwd: (tabId) => ipcRenderer.invoke('terminal:getCwd', { tabId }),
  status: (tabId) => ipcRenderer.invoke('terminal:status', { tabId }),
  listProfiles: () => ipcRenderer.invoke('terminal:list-profiles'),
  onOutput: (callback) => {
    if (typeof callback !== 'function') return () => {};
    ensureTerminalOutputListener();
    terminalOutputSubscribers.add(callback);
    return () => {
      terminalOutputSubscribers.delete(callback);
      maybeRemoveTerminalOutputListener();
    };
  },
});

// アバターAPI（将来拡張用）
contextBridge.exposeInMainWorld('avatarAPI', {
  onTerminalActivity: (callback) => {
    if (typeof callback !== 'function') return () => {};
    ensureTerminalOutputListener();
    terminalActivitySubscribers.add(callback);
    return () => {
      terminalActivitySubscribers.delete(callback);
      maybeRemoveTerminalOutputListener();
    };
  },
});

const startupCwd = (() => {
  try {
    const cwd = process.cwd();
    if (!cwd || process.platform !== 'win32') return '';
    const path = require('path');
    const exeDir = path.dirname(process.execPath || '');
    if (!exeDir) return cwd;
    const normalizedCwd = path.resolve(cwd).toLowerCase();
    const normalizedExeDir = path.resolve(exeDir).toLowerCase();
    if (normalizedCwd === normalizedExeDir) return '';
    return cwd;
  } catch (_) {
    return '';
  }
})();

// ウィンドウ操作API
contextBridge.exposeInMainWorld('windowAPI', {
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  titlebarDoubleClick: () => ipcRenderer.send('window:titlebar-double-click'),
  close: () => ipcRenderer.send('window:close'),
  toggleDevTools: () => ipcRenderer.send('window:toggleDevTools'),
  setPosition: (x, y) => ipcRenderer.send('window:setPosition', { x, y }),
  setBounds: (bounds = {}) => ipcRenderer.send('window:setBounds', bounds),
  setOpacity: (opacity) => ipcRenderer.send('window:setOpacity', { opacity }),
  newWindow: (options) => {
    if (options) {
      return ipcRenderer.invoke('window:new', options);
    }
    ipcRenderer.send('window:new');
    return null;
  },
  onAdoptTab: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('window:adopt-tab', listener);
    return () => {
      ipcRenderer.removeListener('window:adopt-tab', listener);
    };
  },
  onMaximizedChange: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('window:maximized-change', listener);
    return () => {
      ipcRenderer.removeListener('window:maximized-change', listener);
    };
  },
  onFullscreenChange: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('window:fullscreen-change', listener);
    return () => {
      ipcRenderer.removeListener('window:fullscreen-change', listener);
    };
  },
  notifyTabTransferred: (sourceWindowId, tabId) => {
    ipcRenderer.send('tab:transferred', { sourceWindowId, tabId });
  },
  notifyTabDropAccepted: (sourceWindowId, tabId) => {
    ipcRenderer.send('tab:drop-accepted', { sourceWindowId, tabId });
  },
  onTabTransferred: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('window:tab-transferred', listener);
    return () => {
      ipcRenderer.removeListener('window:tab-transferred', listener);
    };
  },
  onTabDropAccepted: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('window:tab-drop-accepted', listener);
    return () => {
      ipcRenderer.removeListener('window:tab-drop-accepted', listener);
    };
  },
  tabDragStart: (payload) => {
    ipcRenderer.send('tab:drag-start', payload);
  },
  tabDragMove: (payload) => {
    ipcRenderer.send('tab:drag-move', payload);
  },
  tabDragEnd: (payload) => {
    ipcRenderer.send('tab:drag-end', payload);
  },
  onTabDragOver: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('window:tab-drag-over', listener);
    return () => {
      ipcRenderer.removeListener('window:tab-drag-over', listener);
    };
  },
  onTabDragLeave: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('window:tab-drag-leave', listener);
    return () => {
      ipcRenderer.removeListener('window:tab-drag-leave', listener);
    };
  },
  createWindowWithTab: (payload) => {
    ipcRenderer.send('window:create-with-tab', payload);
  },
  platform: process.platform, // 'win32', 'darwin', 'linux'
  startupCwd,
});

// メニュー（main -> renderer）
contextBridge.exposeInMainWorld('menuAPI', {
  onAction: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('menu:action', listener);
    return () => {
      ipcRenderer.removeListener('menu:action', listener);
    };
  },
});

// セッションAPI（復元/保存）
contextBridge.exposeInMainWorld('sessionAPI', {
  getRestoreWindow: (windowKey) => ipcRenderer.invoke('session:get-restore-window', { windowKey }),
  getSnapshotConfig: () => ipcRenderer.invoke('session:get-snapshot-config'),
  updateWindow: (windowKey, state) => {
    if (!windowKey || !state) return;
    ipcRenderer.send('session:update-window', { windowKey, state });
  },
  saveSnapshots: (snapshots) => ipcRenderer.invoke('session:save-snapshots', { snapshots }),
  onShowRecoveryModal: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('session:show-recovery-modal', listener);
    return () => ipcRenderer.removeListener('session:show-recovery-modal', listener);
  },
  sendRecoveryChoice: (choice) => ipcRenderer.send('session:recovery-choice', { choice }),
});

// 応援メッセージAPI
contextBridge.exposeInMainWorld('cheerAPI', {
  generate: (language, sessionId) => ipcRenderer.invoke('cheer:generate', { language, session_id: sessionId }),
  checkAvailability: () => ipcRenderer.invoke('cheer:check'),
});

// 履歴API
contextBridge.exposeInMainWorld('historyAPI', {
  getSnapshot: (options) => ipcRenderer.invoke('history:snapshot', options || {}),
  listSessions: (options) => ipcRenderer.invoke('history:list-sessions', options || {}),
  loadSession: (options) => ipcRenderer.invoke('history:load-session', options || {}),
  getMeta: (options) => ipcRenderer.invoke('history:get-meta', options || {}),
  search: (options) => ipcRenderer.invoke('history:search', options || {}),
  deepSearch: (options) => ipcRenderer.invoke('history:deep-search', options || {}),
  timeMachine: (payload) => ipcRenderer.invoke('history:time-machine', payload || {}),
  checkCwd: (payload) => ipcRenderer.invoke('history:check-cwd', payload || {}),
  warmupWsl: (options) => ipcRenderer.invoke('history:warmup-wsl', options || {}),
  onDelta: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('history:delta', listener);
    return () => ipcRenderer.removeListener('history:delta', listener);
  },
  onInvalidate: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('history:invalidate', listener);
    return () => ipcRenderer.removeListener('history:invalidate', listener);
  },
  ack: (payload) => ipcRenderer.send('history:ack', payload || {}),
});

// セッション要約API
contextBridge.exposeInMainWorld('summaryAPI', {
  generate: (payload) => ipcRenderer.invoke('summary:generate', payload || {}),
  check: () => ipcRenderer.invoke('summary:check'),
});

// AI provider capability API
contextBridge.exposeInMainWorld('aiProviderAPI', {
  check: (payload) => ipcRenderer.invoke('ai:check', payload || {}),
});

// Git API
contextBridge.exposeInMainWorld('gitAPI', {
  check: (payload) => ipcRenderer.invoke('git:check', payload || {}),
  status: (payload) => ipcRenderer.invoke('git:status', payload || {}),
  diff: (payload) => ipcRenderer.invoke('git:diff', payload || {}),
  commit: (payload) => ipcRenderer.invoke('git:commit', payload || {}),
  push: (payload) => ipcRenderer.invoke('git:push', payload || {}),
});

// Commit message AI API
contextBridge.exposeInMainWorld('commitMessageAPI', {
  generate: (payload) => ipcRenderer.invoke('ai:commit-message', payload || {}),
});

// Notify API (hooks/notify events)
// Status API (runtime status updates)
contextBridge.exposeInMainWorld('statusAPI', {
  getSnapshot: () => ipcRenderer.invoke('status:snapshot'),
  onUpdate: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('status:update', listener);
    return () => {
      ipcRenderer.removeListener('status:update', listener);
    };
  },
  sendCommand: (payload) => ipcRenderer.send('status:command', payload || {}),
  sendPaneEvent: (payload) => ipcRenderer.send('status:pane', payload || {}),
  sendOutput: (payload) => ipcRenderer.send('status:output', payload || {}),
});

// Auto-config API
contextBridge.exposeInMainWorld('configAPI', {
  applyAutoConfig: (options) => ipcRenderer.invoke('config:auto-config', options || {}),
});

// Settings API
contextBridge.exposeInMainWorld('settingsAPI', {
  get: () => ipcRenderer.invoke('settings:get'),
  update: (patch) => ipcRenderer.invoke('settings:update', patch || {}),
  onChange: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('settings:changed', listener);
    return () => ipcRenderer.removeListener('settings:changed', listener);
  },
});

// Onboarding API
contextBridge.exposeInMainWorld('onboardingAPI', {
  getStatus: () => ipcRenderer.invoke('onboarding:status'),
});

// Reset API (debug)
contextBridge.exposeInMainWorld('resetAPI', {
  requestReset: (options) => ipcRenderer.invoke('app:reset', options || {}),
});

// クリップボードAPI
contextBridge.exposeInMainWorld('clipboardAPI', {
  readText: () => ipcRenderer.invoke('clipboard:read'),
  writeText: (text) => ipcRenderer.invoke('clipboard:write', { text }),
});

// 外部リンクAPI
contextBridge.exposeInMainWorld('shellAPI', {
  openExternal: (url) => {
    if (typeof url !== 'string') return;
    if (!/^https?:\/\//i.test(url)) return;
    shell.openExternal(url);
  },
});

// ファイルAPI（画像プレビュー用）
const fs = require('fs');
const path = require('path');
const os = require('os');

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico'];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const PIN_TEMP_ROOT = path.join(os.tmpdir(), 'kawaii-terminal-pins');
const PIN_TEMP_INSTANCE = process.env.KAWAII_TERMINAL_INSTANCE_ID || `instance-${process.pid}`;

function resolvePath(filePath, basePath) {
  if (!filePath || typeof filePath !== 'string') {
    return null;
  }
  let resolved = filePath.trim();

  // Handle ~ for home directory
  if (resolved.startsWith('~')) {
    resolved = path.join(os.homedir(), resolved.slice(1));
  }

  // Normalize slashes for Windows (convert forward slashes to backslashes)
  if (process.platform === 'win32') {
    resolved = resolved.replace(/\//g, '\\');
  }

  // Check if absolute path
  const isAbsolute = path.isAbsolute(resolved);

  if (!isAbsolute) {
    // Resolve relative path from basePath or homedir
    const base = basePath || os.homedir();
    resolved = path.resolve(base, resolved);
  }

  const normalized = path.normalize(resolved);
  return normalized;
}

function getPathCandidates(filePath, basePath) {
  const primary = resolvePath(filePath, basePath);
  if (!primary) return [];
  return [primary];
}

function isImageExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}

function getPinTempDir() {
  return path.join(PIN_TEMP_ROOT, PIN_TEMP_INSTANCE);
}

function rmDirSyncSafe(dirPath) {
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

function isWithinDir(targetPath, baseDir) {
  try {
    const resolvedTarget = path.resolve(targetPath);
    const resolvedBase = path.resolve(baseDir);
    return resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + path.sep);
  } catch (_) {
    return false;
  }
}

function sanitizeFilename(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'pin';
  const cleaned = raw.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '-');
  const safe = cleaned.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe.slice(0, 40) || 'pin';
}

function pickTextExtension(content) {
  const text = String(content || '').trim();
  if (!text) return '.txt';
  if ((text.startsWith('{') || text.startsWith('[')) && text.length < 5_000_000) {
    try {
      JSON.parse(text);
      return '.json';
    } catch (_) {
      // fall through
    }
  }
  return '.txt';
}

contextBridge.exposeInMainWorld('fileAPI', {
  // Get home directory
  getHomedir: () => os.homedir(),
  // File path resolution (Electron 32+ removes File.path)
  getPathForFile: (file) => {
    try {
      if (webUtils?.getPathForFile) {
        return webUtils.getPathForFile(file);
      }
      if (file && typeof file.path === 'string') return file.path;
      return '';
    } catch (_) {
      return '';
    }
  },

  // Check if path is a valid image file
  checkImageFile: async (filePath, basePath) => {
    try {
      const candidates = getPathCandidates(filePath, basePath);
      if (candidates.length === 0) {
        return { exists: false, error: 'Invalid path' };
      }
      if (!isImageExtension(candidates[0])) {
        return { exists: false, error: 'Not an image file' };
      }

      let lastError = null;
      for (const resolved of candidates) {
        try {
          const stats = await fs.promises.stat(resolved);
          if (!stats.isFile()) {
            lastError = new Error('Not a file');
            continue;
          }
          if (stats.size > MAX_IMAGE_SIZE) {
            return { exists: false, tooLarge: true, error: 'File too large' };
          }
          return { exists: true, size: stats.size, path: resolved };
        } catch (e) {
          lastError = e;
        }
      }

      return { exists: false, error: lastError?.message || 'File not found' };
    } catch (e) {
      return { exists: false, error: e.message };
    }
  },

  // Read image as data URL
  readImageAsDataUrl: async (filePath, basePath) => {
    try {
      const candidates = getPathCandidates(filePath, basePath);
      if (candidates.length === 0) {
        return null;
      }
      if (!isImageExtension(candidates[0])) {
        return null;
      }

      for (const resolved of candidates) {
        try {
          const stats = await fs.promises.stat(resolved);
          if (!stats.isFile() || stats.size > MAX_IMAGE_SIZE) {
            continue;
          }

          const buffer = await fs.promises.readFile(resolved);
          const ext = path.extname(resolved).toLowerCase();

          const mimeTypes = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.bmp': 'image/bmp',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
          };

          const mime = mimeTypes[ext] || 'image/png';
          const base64 = buffer.toString('base64');
          return `data:${mime};base64,${base64}`;
        } catch (_) {
          // try next candidate
        }
      }
    } catch (_) {
      return null;
    }
  },

  // Open file in system default app
  openFile: (filePath, basePath) => {
    try {
      const candidates = getPathCandidates(filePath, basePath);
      if (candidates.length === 0) return;
      for (const resolved of candidates) {
        if (fs.existsSync(resolved)) {
          shell.openPath(resolved);
          return;
        }
      }
      shell.openPath(candidates[0]);
    } catch {
      // Ignore errors
    }
  },

  // Write text to a temp file and return the path
  writeTempTextFile: async (content, filenameHint) => {
    try {
      if (typeof content !== 'string') return null;
      const dir = getPinTempDir();
      await fs.promises.mkdir(dir, { recursive: true });
      const safeName = sanitizeFilename(filenameHint);
      const ext = pickTextExtension(content);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rand = Math.random().toString(36).slice(2, 8);
      const fileName = `${safeName}-${stamp}-${rand}${ext}`;
      const filePath = path.join(dir, fileName);
      await fs.promises.writeFile(filePath, content, 'utf8');
      return filePath;
    } catch (_) {
      return null;
    }
  },

  deleteFile: async (filePath) => {
    try {
      if (typeof filePath !== 'string') return false;
      const dir = getPinTempDir();
      if (!isWithinDir(filePath, dir)) return false;
      await fs.promises.unlink(filePath);
      return true;
    } catch (_) {
      return false;
    }
  },
  cleanupPinTempDir: () => {
    const dir = getPinTempDir();
    return rmDirSyncSafe(dir);
  },

  // Check if path is a valid text file (for MD preview, etc.)
  checkTextFile: async (filePath, basePath, maxSize = 512 * 1024) => {
    try {
      const candidates = getPathCandidates(filePath, basePath);
      if (candidates.length === 0) {
        return { exists: false, error: 'Invalid path' };
      }

      let lastError = null;
      for (const resolved of candidates) {
        try {
          const stats = await fs.promises.stat(resolved);
          if (!stats.isFile()) {
            lastError = new Error('Not a file');
            continue;
          }
          if (stats.size > maxSize) {
            return { exists: false, tooLarge: true, error: 'File too large' };
          }
          return { exists: true, size: stats.size, path: resolved };
        } catch (e) {
          lastError = e;
        }
      }

      return { exists: false, error: lastError?.message || 'File not found' };
    } catch (e) {
      return { exists: false, error: e.message };
    }
  },

  // Read text file content
  readTextFile: async (filePath, basePath, maxSize = 512 * 1024) => {
    try {
      const candidates = getPathCandidates(filePath, basePath);
      if (candidates.length === 0) {
        return null;
      }

      for (const resolved of candidates) {
        try {
          const stats = await fs.promises.stat(resolved);
          if (!stats.isFile() || stats.size > maxSize) {
            continue;
          }

          const content = await fs.promises.readFile(resolved, 'utf8');
          return content;
        } catch (_) {
          // try next candidate
        }
      }
      return null;
    } catch (_) {
      return null;
    }
  },
});
