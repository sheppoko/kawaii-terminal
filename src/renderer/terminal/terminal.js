if (!window.kawaiiDebugLog) {
  window.kawaiiDebugLog = () => {};
}

const DEFAULT_TERMINAL_SETTINGS = {
  fontSize: 14,
  fontFamily: '"HackGen Console NF", Consolas, monospace',
  scrollback: 5000,
  webglEnabled: true,
};
const TERMINAL_THEME_FALLBACK = {
  background: '#000000',
  foreground: '#cccccc',
  cursor: '#ffffff',
  cursorAccent: '#000000',
  selectionBackground: 'rgba(255, 255, 255, 0.3)',
  black: '#000000',
  red: '#c50f1f',
  green: '#13a10e',
  yellow: '#c19c00',
  blue: '#0037da',
  magenta: '#881798',
  cyan: '#3a96dd',
  white: '#cccccc',
  brightBlack: '#767676',
  brightRed: '#e74856',
  brightGreen: '#16c60c',
  brightYellow: '#f9f1a5',
  brightBlue: '#3b78ff',
  brightMagenta: '#b4009e',
  brightCyan: '#61d6d6',
  brightWhite: '#f2f2f2',
};
let activeTerminalTheme = null;
let activeTerminalPalette16 = null;
let activeXtermPalette = null;

let cssVarResolverEl = null;

function resolveCssVarColor(varName, fallback) {
  if (typeof document === 'undefined') return fallback;
  const root = document.documentElement;
  if (!root) return fallback;
  const raw = getComputedStyle(root).getPropertyValue(varName).trim();
  if (!raw) return fallback;
  if (!raw.includes('var(')) return raw;
  if (!document.body) return fallback || raw;
  if (!cssVarResolverEl) {
    cssVarResolverEl = document.createElement('span');
    cssVarResolverEl.style.position = 'absolute';
    cssVarResolverEl.style.visibility = 'hidden';
    cssVarResolverEl.style.pointerEvents = 'none';
    cssVarResolverEl.style.top = '-9999px';
    cssVarResolverEl.style.left = '-9999px';
    document.body.appendChild(cssVarResolverEl);
  }
  cssVarResolverEl.style.color = `var(${varName})`;
  const resolved = getComputedStyle(cssVarResolverEl).color;
  return resolved || fallback || raw;
}

function getTerminalThemeFromCss() {
  return {
    background: resolveCssVarColor('--kt-color-terminal-bg', TERMINAL_THEME_FALLBACK.background),
    foreground: resolveCssVarColor('--kt-color-terminal-fg', TERMINAL_THEME_FALLBACK.foreground),
    cursor: resolveCssVarColor('--kt-color-terminal-cursor', TERMINAL_THEME_FALLBACK.cursor),
    cursorAccent: resolveCssVarColor('--kt-color-terminal-cursor-accent', TERMINAL_THEME_FALLBACK.cursorAccent),
    selectionBackground: resolveCssVarColor('--kt-color-terminal-selection', TERMINAL_THEME_FALLBACK.selectionBackground),
    black: resolveCssVarColor('--kt-color-terminal-ansi-black', TERMINAL_THEME_FALLBACK.black),
    red: resolveCssVarColor('--kt-color-terminal-ansi-red', TERMINAL_THEME_FALLBACK.red),
    green: resolveCssVarColor('--kt-color-terminal-ansi-green', TERMINAL_THEME_FALLBACK.green),
    yellow: resolveCssVarColor('--kt-color-terminal-ansi-yellow', TERMINAL_THEME_FALLBACK.yellow),
    blue: resolveCssVarColor('--kt-color-terminal-ansi-blue', TERMINAL_THEME_FALLBACK.blue),
    magenta: resolveCssVarColor('--kt-color-terminal-ansi-magenta', TERMINAL_THEME_FALLBACK.magenta),
    cyan: resolveCssVarColor('--kt-color-terminal-ansi-cyan', TERMINAL_THEME_FALLBACK.cyan),
    white: resolveCssVarColor('--kt-color-terminal-ansi-white', TERMINAL_THEME_FALLBACK.white),
    brightBlack: resolveCssVarColor('--kt-color-terminal-ansi-bright-black', TERMINAL_THEME_FALLBACK.brightBlack),
    brightRed: resolveCssVarColor('--kt-color-terminal-ansi-bright-red', TERMINAL_THEME_FALLBACK.brightRed),
    brightGreen: resolveCssVarColor('--kt-color-terminal-ansi-bright-green', TERMINAL_THEME_FALLBACK.brightGreen),
    brightYellow: resolveCssVarColor('--kt-color-terminal-ansi-bright-yellow', TERMINAL_THEME_FALLBACK.brightYellow),
    brightBlue: resolveCssVarColor('--kt-color-terminal-ansi-bright-blue', TERMINAL_THEME_FALLBACK.brightBlue),
    brightMagenta: resolveCssVarColor('--kt-color-terminal-ansi-bright-magenta', TERMINAL_THEME_FALLBACK.brightMagenta),
    brightCyan: resolveCssVarColor('--kt-color-terminal-ansi-bright-cyan', TERMINAL_THEME_FALLBACK.brightCyan),
    brightWhite: resolveCssVarColor('--kt-color-terminal-ansi-bright-white', TERMINAL_THEME_FALLBACK.brightWhite),
  };
}

function buildTerminalPalette16(theme) {
  return [
    theme.black,
    theme.red,
    theme.green,
    theme.yellow,
    theme.blue,
    theme.magenta,
    theme.cyan,
    theme.white,
    theme.brightBlack,
    theme.brightRed,
    theme.brightGreen,
    theme.brightYellow,
    theme.brightBlue,
    theme.brightMagenta,
    theme.brightCyan,
    theme.brightWhite,
  ];
}

function buildXterm256Palette(palette16) {
  const palette = new Array(256);
  for (let i = 0; i < 16; i += 1) {
    palette[i] = palette16[i];
  }
  const steps = [0, 95, 135, 175, 215, 255];
  for (let i = 16; i <= 231; i += 1) {
    const idx = i - 16;
    const r = steps[Math.floor(idx / 36) % 6];
    const g = steps[Math.floor(idx / 6) % 6];
    const b = steps[idx % 6];
    palette[i] = `rgb(${r}, ${g}, ${b})`;
  }
  for (let i = 232; i <= 255; i += 1) {
    const level = 8 + (i - 232) * 10;
    palette[i] = `rgb(${level}, ${level}, ${level})`;
  }
  return palette;
}

function refreshTerminalThemeFromCss() {
  const theme = getTerminalThemeFromCss();
  activeTerminalTheme = theme;
  activeTerminalPalette16 = buildTerminalPalette16(theme);
  activeXtermPalette = buildXterm256Palette(activeTerminalPalette16);
  if (window.ansiAPI?.setTheme) {
    window.ansiAPI.setTheme({
      defaultFg: theme.foreground,
      defaultBg: theme.background,
      palette: activeTerminalPalette16,
    });
  }
  return theme;
}

function getActiveTerminalTheme() {
  return activeTerminalTheme || refreshTerminalThemeFromCss();
}

function getActiveXtermPalette() {
  if (activeXtermPalette) return activeXtermPalette;
  refreshTerminalThemeFromCss();
  return activeXtermPalette;
}
const terminalManagers = new Set();

function registerTerminalManager(manager) {
  terminalManagers.add(manager);
}

function unregisterTerminalManager(manager) {
  terminalManagers.delete(manager);
}

function applyThemeToAllTerminals(theme) {
  terminalManagers.forEach((manager) => {
    const terminal = manager?.terminal;
    if (!terminal?.options) return;
    try {
      terminal.options.theme = { ...theme };
      if (typeof terminal.clearTextureAtlas === 'function') {
        terminal.clearTextureAtlas();
      }
      if (typeof terminal.refresh === 'function') {
        const lastRow = Math.max(0, terminal.rows - 1);
        terminal.refresh(0, lastRow);
      }
    } catch (err) {
      console.warn('[TerminalManager] Theme refresh failed:', err);
    }
  });
}

if (typeof window !== 'undefined') {
  const scheduleThemeRefresh = () => {
    requestAnimationFrame(() => {
      const theme = refreshTerminalThemeFromCss();
      applyThemeToAllTerminals(theme);
    });
  };
  window.addEventListener('kawaii-theme-change', scheduleThemeRefresh);
  window.KawaiiTerminalTheme = {
    refresh: () => {
      scheduleThemeRefresh();
    },
  };
}

const SCREEN_CAPTURE_MAX_LINES = 400;
const SCREEN_CAPTURE_MAX_CHARS = 100000;
const RAW_PASTE_CHUNK_SIZE = 1000;
const RAW_PASTE_YIELD_MS = 8;
const MD_EXTENSIONS = /\.(md|markdown|mkd|mdx)$/i;

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (Number.isNaN(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function normalizeTerminalSettings(input) {
  const parsed = input && typeof input === 'object' ? input : {};
  const rawFontFamily = typeof parsed.fontFamily === 'string' ? parsed.fontFamily.trim() : '';
  return {
    fontSize: clampNumber(parsed.fontSize, 10, 32, DEFAULT_TERMINAL_SETTINGS.fontSize),
    fontFamily: rawFontFamily || DEFAULT_TERMINAL_SETTINGS.fontFamily,
    scrollback: clampNumber(parsed.scrollback, 1000, 50000, DEFAULT_TERMINAL_SETTINGS.scrollback),
    webglEnabled: typeof parsed.webglEnabled === 'boolean'
      ? parsed.webglEnabled
      : DEFAULT_TERMINAL_SETTINGS.webglEnabled,
  };
}

function loadTerminalSettings({ allowNull = false } = {}) {
  return allowNull ? null : { ...DEFAULT_TERMINAL_SETTINGS };
}

window.TerminalSettings = {
  load: loadTerminalSettings,
  defaults: { ...DEFAULT_TERMINAL_SETTINGS },
  normalize: normalizeTerminalSettings,
};

function isMac() {
  return window.windowAPI?.platform === 'darwin';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rgbNumberToCss(value) {
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `rgb(${r}, ${g}, ${b})`;
}

function paletteIndexToCss(index) {
  if (!Number.isFinite(index)) return null;
  const idx = Math.max(0, Math.min(255, index));
  const palette = getActiveXtermPalette();
  return palette?.[idx] || null;
}

function getCellColor(cell, isForeground) {
  if (!cell) return null;
  if (isForeground) {
    if (cell.isFgDefault?.()) return null;
    if (cell.isFgRGB?.()) return rgbNumberToCss(cell.getFgColor());
    if (cell.isFgPalette?.()) return paletteIndexToCss(cell.getFgColor());
    return null;
  }
  if (cell.isBgDefault?.()) return null;
  if (cell.isBgRGB?.()) return rgbNumberToCss(cell.getBgColor());
  if (cell.isBgPalette?.()) return paletteIndexToCss(cell.getBgColor());
  return null;
}

function buildCellStyle(cell) {
  if (!cell) return '';
  let fg = getCellColor(cell, true);
  let bg = getCellColor(cell, false);
  if (cell.isInverse?.()) {
    const tmp = fg;
    fg = bg;
    bg = tmp;
  }

  const styles = [];
  if (fg) styles.push(`color: ${fg}`);
  if (bg) styles.push(`background-color: ${bg}`);
  if (cell.isBold?.()) styles.push('font-weight: 700');
  if (cell.isDim?.()) styles.push('opacity: 0.7');
  if (cell.isItalic?.()) styles.push('font-style: italic');
  const decorations = [];
  if (cell.isUnderline?.()) decorations.push('underline');
  if (cell.isStrikethrough?.()) decorations.push('line-through');
  if (cell.isOverline?.()) decorations.push('overline');
  if (decorations.length > 0) {
    styles.push(`text-decoration: ${decorations.join(' ')}`);
  }

  return styles.join('; ');
}

function lineHasVisuals(line, cols, reuseCell) {
  if (!line) return false;
  const text = line.translateToString?.(true) || '';
  if (text.trim().length > 0) return true;
  for (let x = 0; x < cols; x += 1) {
    const cell = line.getCell(x, reuseCell);
    if (!cell) continue;
    if (cell.getWidth?.() === 0) continue;
    const chars = cell.getChars?.() || '';
    if (chars.trim().length > 0) return true;
    if (!cell.isFgDefault?.() || !cell.isBgDefault?.()) return true;
    if (cell.isBold?.() || cell.isDim?.() || cell.isItalic?.() || cell.isUnderline?.()
      || cell.isStrikethrough?.() || cell.isOverline?.() || cell.isInverse?.()) {
      return true;
    }
  }
  return false;
}

class TerminalManager {
  constructor(containerIdOrElement, tabId) {
      this.container = typeof containerIdOrElement === 'string'
        ? document.getElementById(containerIdOrElement)
        : containerIdOrElement;
      this.tabId = tabId || 'default';
      this.profileId = null;
      this.terminal = null;
    this.fitAddon = null;
    this.searchAddon = null;
    this.webLinksAddon = null;
    this.webglAddon = null;
    this.webglAddonClass = null;
    this.linkProviderDisposable = null;
    this.fileLinkProviderDisposable = null;
    this.onCommandSubmit = null; // コマンド確定時のコールバック
    this.onCommandExecuted = null; // 実行後コマンド通知（OSC）
    this.onShellInfo = null;
    this.onTitleChange = null;
    this.onOutputData = null;
    this.onCwdChange = null;
    this.currentInput = ''; // 現在入力中のコマンド
    this.settings = this.loadSettings();
    this.compositionTextarea = null;
    this.compositionActive = false;
    this.pendingCompositionClear = false;
    this.compositionFlushTimer = null;
    this.outputDisposer = null;
    this.pasteHandler = null;
    this.linkHintEl = null;
    this.lastMouseX = 0;
    this.lastMouseY = 0;
    this.currentCwd = null; // Tracked via OSC sequences
    this.oscRemainder = '';
    this.lastCommand = null;
    this.lastCommandAt = 0;
    this.commandCount = 0;
    this.oscCount = 0;
    this.oscKawaiiCount = 0;
    this.lastOsc = '';
    this.lastKawaiiOsc = '';
    this.onOsc = null;
    this.lastScrollbackY = 0;
    this.lastViewportHash = 0;
    this.cwdLastFetchedAt = 0;
    this.cwdFetchPromise = null;
    this.cwdRefreshTimer = null;
    this.fontFamily = this.buildFontFamily();
    this.previewCacheHtml = null;
    this.previewCacheLines = 200;
    this.previewCacheTimer = null;
    this.onPreviewUpdated = null;
    this.mdPreviewManager = null;
    this.isOpen = false;
    this.deferOpen = false;
    this.pendingPrefill = null;
    this.hasOutput = false;
    this.lastInputAt = 0;
    this.lastOutputAt = 0;
    this.prefillCommitted = false;
    this.openFitObserver = null;
    registerTerminalManager(this);
  }

  setMdPreviewManager(manager) {
    this.mdPreviewManager = manager || null;
  }

  scheduleCwdRefresh(delayMs = 220) {
    if (this.cwdRefreshTimer) {
      clearTimeout(this.cwdRefreshTimer);
    }
    this.cwdRefreshTimer = setTimeout(() => {
      this.cwdRefreshTimer = null;
      void this.refreshCwdFromMain({ force: true });
    }, delayMs);
  }

  async refreshCwdFromMain({ force = false } = {}) {
    if (!window.terminalAPI?.getCwd) return this.currentCwd;
    const now = Date.now();
    const minIntervalMs = 800;

    if (!force && this.cwdFetchPromise) return this.cwdFetchPromise;
    if (!force && now - this.cwdLastFetchedAt < minIntervalMs) return this.currentCwd;
    if (this.cwdFetchPromise) return this.cwdFetchPromise;

    this.cwdFetchPromise = (async () => {
      try {
        const result = await window.terminalAPI.getCwd(this.tabId);
        const cwd = typeof result?.cwd === 'string' ? result.cwd : null;
        this.cwdLastFetchedAt = Date.now();
        if (cwd && cwd !== this.currentCwd) {
          this.currentCwd = cwd;
          this.onCwdChange?.(cwd);
        }
        return cwd || this.currentCwd;
      } catch (_) {
        this.cwdLastFetchedAt = Date.now();
        return this.currentCwd;
      } finally {
        this.cwdFetchPromise = null;
      }
    })();

    return this.cwdFetchPromise;
  }

  loadSettings() {
    return { ...DEFAULT_TERMINAL_SETTINGS };
  }

  updateSettings(newSettings) {
    const prevFontFamily = this.settings?.fontFamily;
    this.settings = { ...this.settings, ...newSettings };
    if (prevFontFamily !== this.settings?.fontFamily) {
      this.fontFamily = this.buildFontFamily();
    }
    this.applySettings();
  }

  applySettings() {
    if (!this.terminal) return;
    this.terminal.options.fontSize = this.settings.fontSize;
    this.terminal.options.scrollback = this.settings.scrollback;
    if (this.fontFamily) {
      this.terminal.options.fontFamily = this.fontFamily;
    }
    this.applyWebglSetting();
    this.handleResize();
  }

  buildFontFamily() {
    const custom = typeof this.settings?.fontFamily === 'string'
      ? this.settings.fontFamily.trim()
      : '';
    return custom || DEFAULT_TERMINAL_SETTINGS.fontFamily;
  }

  applyWebglSetting() {
    if (!this.terminal || !this.webglAddonClass) return;

    if (this.settings.webglEnabled) {
      if (this.webglAddon) return;
      requestAnimationFrame(() => {
        if (!this.settings.webglEnabled || this.webglAddon) return;
        try {
          // preserveDrawingBuffer=true enables canvas.toDataURL() for previews
          const webglAddon = new this.webglAddonClass(true);
          webglAddon.onContextLoss(() => {
            try { webglAddon.dispose(); } catch (_) { /* noop */ }
            if (this.webglAddon === webglAddon) {
              this.webglAddon = null;
            }
          });
          this.terminal.loadAddon(webglAddon);
          this.webglAddon = webglAddon;
        } catch (_) {
          // WebGL利用不可でもCanvas 2Dで動作
        }
      });
    } else if (this.webglAddon) {
      try { this.webglAddon.dispose(); } catch (_) { /* noop */ }
      this.webglAddon = null;
    }
  }

  getSettings() {
    return { ...this.settings };
  }

  /**
   * Parse OSC sequences from terminal output to track CWD
   * OSC 7: file://host/path (standard)
   * OSC 9;9: "path" (Windows Terminal style)
   */
  parseOscForCwd(data) {
    if (!data || typeof data !== 'string') return;
    let text = `${this.oscRemainder || ''}${data}`;
    this.oscRemainder = '';
    if (text.includes('\x9d')) {
      text = text.replace(/\x9d/g, '\x1b]');
    }

    let index = 0;
    while (index < text.length) {
      const start = text.indexOf('\x1b]', index);
      if (start === -1) break;

      const endBel = text.indexOf('\x07', start + 2);
      const endSt = text.indexOf('\x1b\\', start + 2);
      const endStC1 = text.indexOf('\x9c', start + 2);
      let end = -1;
      let endLen = 0;
      const candidates = [
        endBel !== -1 ? { pos: endBel, len: 1 } : null,
        endSt !== -1 ? { pos: endSt, len: 2 } : null,
        endStC1 !== -1 ? { pos: endStC1, len: 1 } : null,
      ].filter(Boolean);
      if (candidates.length > 0) {
        candidates.sort((a, b) => a.pos - b.pos);
        end = candidates[0].pos;
        endLen = candidates[0].len;
      }

      if (end === -1) {
        this.oscRemainder = text.slice(start);
        break;
      }

      const osc = text.slice(start + 2, end);
      this.handleOscSequence(osc);
      index = end + endLen;
    }

    if (this.oscRemainder.length > 4096) {
      this.oscRemainder = this.oscRemainder.slice(-4096);
    }
  }

  decodeBase64Utf8(value) {
    try {
      const raw = atob(String(value || ''));
      const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
      if (typeof TextDecoder !== 'undefined') {
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      }
      // Fallback: assume ASCII
      return raw;
    } catch {
      return '';
    }
  }

  handleOscSequence(osc) {
    if (!osc) return;
    this.oscCount += 1;
    this.lastOsc = osc.slice(0, 200);
    if (osc.startsWith('1337;Kawaii')) {
      this.oscKawaiiCount += 1;
      this.lastKawaiiOsc = osc.slice(0, 200);
    }
    this.onOsc?.(osc);
    if (osc.startsWith('7;')) {
      const prev = this.currentCwd;
      const match = osc.match(/^7;file:\/\/[^/]*\/(.+)$/);
      if (!match) return;
      let path = match[1];
      try {
        path = decodeURIComponent(path);
      } catch (_) { /* noop */ }
      if (window.windowAPI?.platform === 'win32' && /^[A-Za-z]:/.test(path)) {
        path = path.replace(/\//g, '\\');
      } else if (window.windowAPI?.platform === 'win32' && /^[A-Za-z]%3A/i.test(path)) {
        path = decodeURIComponent(path).replace(/\//g, '\\');
      } else if (window.windowAPI?.platform !== 'win32' && !path.startsWith('/')) {
        path = '/' + path;
      }
      this.currentCwd = path;
      if (this.currentCwd) {
        this.onCwdChange?.(this.currentCwd, { changed: this.currentCwd !== prev });
      }
      return;
    }

    if (osc.startsWith('9;9;')) {
      const prev = this.currentCwd;
      const match = osc.match(/^9;9;"?([^"]+)"?$/);
      if (!match) return;
      this.currentCwd = match[1];
      if (this.currentCwd) {
        this.onCwdChange?.(this.currentCwd, { changed: this.currentCwd !== prev });
      }
      return;
    }

    if (osc.startsWith('1337;CurrentDir=')) {
      const prev = this.currentCwd;
      const next = osc.slice('1337;CurrentDir='.length).trim();
      if (next) {
        this.currentCwd = next;
        if (this.currentCwd) {
          this.onCwdChange?.(this.currentCwd, { changed: this.currentCwd !== prev });
        }
      }
    }

    if (osc.startsWith('1337;KawaiiCmd64=')) {
      const payload = osc.slice('1337;KawaiiCmd64='.length);
      const decoded = this.decodeBase64Utf8(payload);
      const cmd = decoded.trim();
      if (cmd) {
        this.lastCommand = cmd;
        this.lastCommandAt = Date.now();
        this.commandCount += 1;
        this.onCommandExecuted?.(cmd, { source: 'osc', encoded: 'base64' });
      }
      return;
    }

    if (osc.startsWith('1337;KawaiiShell64=')) {
      const payload = osc.slice('1337;KawaiiShell64='.length);
      const decoded = this.decodeBase64Utf8(payload);
      const info = decoded.trim();
      if (info) {
        this.onShellInfo?.(info, { source: 'osc', encoded: 'base64' });
      }
      return;
    }

    if (osc.startsWith('1337;KawaiiShell=')) {
      const info = osc.slice('1337;KawaiiShell='.length).trim();
      if (info) {
        this.onShellInfo?.(info, { source: 'osc', encoded: 'raw' });
      }
      return;
    }

    if (osc.startsWith('1337;KawaiiCmd=')) {
      const cmd = osc.slice('1337;KawaiiCmd='.length).trim();
      if (cmd) {
        this.lastCommand = cmd;
        this.lastCommandAt = Date.now();
        this.commandCount += 1;
        this.onCommandExecuted?.(cmd, { source: 'osc', encoded: 'raw' });
      }
      return;
    }

  }

  getCwd() {
    return this.currentCwd;
  }

  /**
   * Resolve a relative path against a base path (like path.resolve but for browser)
   */
  resolvePath(basePath, relativePath) {
    if (!basePath || !relativePath) return relativePath;

    const isWin = window.windowAPI?.platform === 'win32';
    const sep = isWin ? '\\' : '/';

    // Normalize separators
    const normalizedBase = basePath.replace(/[\\/]/g, sep);
    const normalizedRel = relativePath.replace(/[\\/]/g, sep);

    // Split into parts
    const baseParts = normalizedBase.split(sep).filter(p => p && p !== '.');
    const relParts = normalizedRel.split(sep).filter(p => p);

    // Process relative path parts
    for (const part of relParts) {
      if (part === '..') {
        baseParts.pop();
      } else if (part !== '.') {
        baseParts.push(part);
      }
    }

    // Reconstruct path
    let result = baseParts.join(sep);

    // Preserve drive letter on Windows
    if (isWin && /^[A-Za-z]:/.test(normalizedBase) && !result.includes(':')) {
      result = normalizedBase.substring(0, 2) + sep + result;
    }
    // Preserve UNC root on Windows
    if (isWin && normalizedBase.startsWith('\\\\') && !result.startsWith('\\\\')) {
      result = '\\\\' + result;
    }
    // Preserve absolute root on POSIX
    if (!isWin && normalizedBase.startsWith('/')) {
      const prefix = normalizedBase.match(/^\/+/)?.[0] || '/';
      if (!result.startsWith(prefix)) {
        result = prefix + result.replace(/^\/+/, '');
      }
    }

    return result;
  }

  getCurrentInput() {
    return this.currentInput || '';
  }

  async initialize(options = {}) {
    const logInit = () => {};
    if (options.initialSettings) {
      this.settings = normalizeTerminalSettings(options.initialSettings);
    }
    this.fontFamily = this.buildFontFamily();

    // xterm.js はHTMLでグローバルにロード済み
    const Terminal = window.Terminal;
    const FitAddon = window.FitAddon.FitAddon;
    const SearchAddon = window.SearchAddon?.SearchAddon;
    const SerializeAddon = window.SerializeAddon?.SerializeAddon;
    const WebglAddon = window.WebglAddon?.WebglAddon;
    logInit('start', { attachExisting: Boolean(options.attachExisting || options.attach) });

    // ターミナル作成
    this.terminal = new Terminal({
      cursorBlink: false,
      cursorStyle: 'block',
      fontSize: this.settings.fontSize,
      fontFamily: this.fontFamily,
      fontWeight: 'normal',
      fontWeightBold: 'normal',
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      letterSpacing: 0,
      lineHeight: 1,
      scrollback: this.settings.scrollback,
      smoothScrollDuration: 0,  // スムーススクロール無効（ちらつき軽減）
      allowProposedApi: true,
      linkHandler: {
        allowNonHttpProtocols: false,
        activate: (event, text) => {
          event?.preventDefault?.();
          if (!this.shouldOpenLink(event)) return;
          const url = typeof text === 'string' ? text.trim() : '';
          if (!/^https?:\/\//i.test(url)) return;
          window.shellAPI?.openExternal?.(url);
        },
        hover: (event) => {
          this.showLinkHintFromEvent(event);
        },
        leave: () => {
          this.hideLinkHint();
        },
      },
      theme: getActiveTerminalTheme(),
    });

    // Fitアドオン
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    // Serializeアドオン（出力範囲の取得に使用）
    if (SerializeAddon) {
      this.serializeAddon = new SerializeAddon();
      this.terminal.loadAddon(this.serializeAddon);
    }

    // 検索アドオン
    if (SearchAddon) {
      this.searchAddon = new SearchAddon();
      this.terminal.loadAddon(this.searchAddon);
    }

    // WebGLアドオンは設定に応じてロード（open後に適用）
    this.webglAddonClass = WebglAddon || null;
    this.deferOpen = Boolean(options.deferXtermOpen);
    if (!this.deferOpen) {
      this.openTerminal();
      logInit('xterm:open');
    }

    // 入力をメインプロセスに送信
    this.terminal.onData((data) => {
      this.lastInputAt = Date.now();
      window.terminalAPI.sendInput(this.tabId, data);

      // ユーザー入力を追跡（ESCシーケンスは除外）
      let i = 0;
      while (i < data.length) {
        const char = data[i];

        if (char === '\r' || char === '\n') {
          // Enter押下 → コマンド確定
          const command = this.currentInput.trim();
          if (this.onCommandSubmit && command) {
            this.onCommandSubmit(command);
          }
          this.currentInput = '';
          this.scheduleCwdRefresh();
          this.queueTuiCompositionClear();
          i += 1;
          continue;
        }

        if (char === '\x7f' || char === '\b') {
          this.currentInput = this.currentInput.slice(0, -1);
          i += 1;
          continue;
        }

        if (char === '\x03' || char === '\x15') {
          // Ctrl+C / Ctrl+U → 入力クリア
          this.currentInput = '';
          i += 1;
          continue;
        }

        if (char === '\x1b') {
          // ANSI escape sequences (arrows, function keys, etc.) should not be captured as command text.
          const next = data[i + 1];
          if (next === '[') {
            // Some terminals send ESC[[A for function keys (F1..).
            if (data[i + 2] === '[') {
              i += Math.min(4, data.length - i);
              continue;
            }

            // CSI: ESC [ ... <final>
            let j = i + 2;
            while (j < data.length) {
              const code = data.charCodeAt(j);
              if (code >= 0x40 && code <= 0x7e) {
                j += 1;
                break;
              }
              j += 1;
            }
            i = j;
            continue;
          }

          if (next === 'O') {
            // SS3: ESC O <final>
            i += Math.min(3, data.length - i);
            continue;
          }

          // Fallback: ESC + 1 char
          i += Math.min(2, data.length - i);
          continue;
        }

        const code = char.charCodeAt(0);
        if (code >= 32 && code !== 127) {
          this.currentInput += char;
        }

        i += 1;
      }

      this.clearStaleCompositionInputWhenHidden();
    });

    // メインプロセスからの出力を受信
    this.outputDisposer = window.terminalAPI.onOutput((data) => {
      if (data?.tabId !== this.tabId) return;
      this.hasOutput = true;
      this.lastOutputAt = Date.now();
      if (!this.isOpen && this.pendingPrefill && !this.prefillCommitted) {
        // PTY出力が先に来た場合はprefillを破棄してちらつきを防ぐ
        this.pendingPrefill = null;
      }
      this.terminal.write(data.data, () => {
        this.schedulePreviewCapture(200);
      });
      // Parse OSC sequences for CWD tracking
      this.parseOscForCwd(data.data);
      if (!this.currentCwd) {
        void this.refreshCwdFromMain();
      }
      if (this.onOutputData) {
        this.onOutputData(data.data);
      }
    });

    const prefill = typeof options.prefill === 'string' ? options.prefill : '';
    const prefillLabel = typeof options.prefillLabel === 'string' ? options.prefillLabel : '';
    if (prefill) {
      // 端末のテキスト復元では "\n" のみだとカーソル列が維持されて崩れるので、必ずCRLFに正規化する。
      let block = prefill.replace(/\r?\n/g, '\r\n');
      if (!block.endsWith('\r\n')) {
        block += '\r\n';
      }
      if (prefillLabel) {
        block += `${prefillLabel}\r\n`;
      }
      if (this.isOpen) {
        this.prefillCommitted = true;
        this.terminal.write(block, () => {
          this.schedulePreviewCapture(200);
        });
      } else {
        this.pendingPrefill = block;
      }
    }

    // PTY開始 / 既存セッションにアタッチ
    const { cols, rows } = this.terminal;
    const attachExisting = Boolean(options.attachExisting || options.attach);
    const startCwd = typeof options.startCwd === 'string' ? options.startCwd.trim() : '';
    const profileId = typeof options.profileId === 'string' ? options.profileId.trim() : '';
    this.profileId = profileId || null;
    const startOptions = {};
    if (startCwd) startOptions.cwd = startCwd;
    if (profileId) startOptions.profileId = profileId;
    const startPayload = Object.keys(startOptions).length ? startOptions : undefined;

    const loadingEl = options.loadingEl || null;
    const loadingClassTarget = options.loadingClassTarget || null;
    const loadingLabel = typeof options.loadingLabel === 'string' ? options.loadingLabel : '';
    const loadingDelayMs = Number.isFinite(options.loadingDelayMs) ? Math.max(0, options.loadingDelayMs) : 500;
    if (loadingEl) {
      const labelEl = loadingEl.querySelector?.('.terminal-loading-text');
      if (labelEl) {
        labelEl.textContent = loadingLabel || 'Loading...';
      } else {
        loadingEl.textContent = loadingLabel || 'Loading...';
      }
      loadingEl.classList.remove('show');
    }

    this.terminal.options.disableStdin = true;
    let loadingTimer = null;
    if (loadingEl && loadingDelayMs >= 0) {
      loadingTimer = setTimeout(() => {
        loadingEl.classList.add('show');
        if (loadingClassTarget?.classList) {
          loadingClassTarget.classList.add('terminal-loading-active');
        }
      }, loadingDelayMs);
    }

    const startPty = async () => {
      logInit('pty:start', { startPayload: startPayload || null });
      if (attachExisting && window.terminalAPI?.attach) {
        try {
          const result = await window.terminalAPI.attach(this.tabId, cols, rows);
          if (!result?.success) {
            await window.terminalAPI.start(this.tabId, cols, rows, startPayload);
          }
        } catch (_) {
          await window.terminalAPI.start(this.tabId, cols, rows, startPayload);
        }
      } else {
        await window.terminalAPI.start(this.tabId, cols, rows, startPayload);
      }
    };

    const finalizePtyStart = () => {
      if (loadingTimer) {
        clearTimeout(loadingTimer);
        loadingTimer = null;
      }
      if (loadingEl) {
        loadingEl.classList.remove('show');
      }
      if (loadingClassTarget?.classList) {
        loadingClassTarget.classList.remove('terminal-loading-active');
      }
      this.terminal.options.disableStdin = false;
      // OSCが無い環境（macOSなど）向けに、メインプロセスからCWDを補完
      this.scheduleCwdRefresh(50);
      this.terminal.focus();
      logInit('pty:started');
      logInit('done');
    };

    const startPromise = (async () => {
      await startPty();
      finalizePtyStart();
    })().catch((err) => {
      if (loadingTimer) {
        clearTimeout(loadingTimer);
        loadingTimer = null;
      }
      if (loadingEl) {
        loadingEl.classList.add('show');
        const labelEl = loadingEl.querySelector?.('.terminal-loading-text');
        const msg = 'Failed to start terminal';
        if (labelEl) {
          labelEl.textContent = msg;
        } else {
          loadingEl.textContent = msg;
        }
      }
      if (loadingClassTarget?.classList) {
        loadingClassTarget.classList.add('terminal-loading-active');
      }
      console.error('[TerminalManager] Failed to start PTY:', err);
    });

    if (!options.deferPtyStart) {
      await startPromise;
    }

    this.terminal.onTitleChange((title) => {
      if (this.onTitleChange) {
        this.onTitleChange(title);
      }
    });

    // settings are provided by the tab manager on initialization

    // 初期化後にスクロール位置をリセット
    setTimeout(() => {
      this.terminal.scrollToBottom();
    }, 50);
  }

  openTerminal() {
    if (this.isOpen || !this.terminal) return;
    this.terminal.open(this.container);
    this.isOpen = true;
    const hasSize = Boolean(this.container && this.container.offsetWidth > 0 && this.container.offsetHeight > 0);
    if (hasSize) {
      // サイズが有効なら即座にfit + resize
      this.handleResize();
    } else if (this.container && typeof ResizeObserver !== 'undefined') {
      if (this.openFitObserver) {
        try { this.openFitObserver.disconnect(); } catch (_) { /* noop */ }
      }
      this.openFitObserver = new ResizeObserver(() => {
        if (!this.container) return;
        if (this.container.offsetWidth > 0 && this.container.offsetHeight > 0) {
          try { this.openFitObserver.disconnect(); } catch (_) { /* noop */ }
          this.openFitObserver = null;
          this.handleResize();
        }
      });
      this.openFitObserver.observe(this.container);
    }
    // IME合成表示が右にはみ出して横スクロール/クリップされるのを防ぐ
    this.setupCompositionHandling();
    this.setupPasteHandling();
    this.setupExtendedEnterHandling();
    // WebGLアドオンは設定に応じてロード
    this.applyWebglSetting();
    // リンク関連は遅延初期化（起動を高速化）
    setTimeout(() => this.initializeLinkProviders(), 0);

    if (this.pendingPrefill && !this.hasOutput) {
      this.prefillCommitted = true;
      const block = this.pendingPrefill;
      this.pendingPrefill = null;
      this.terminal.write(block, () => {
        this.schedulePreviewCapture(200);
      });
    } else {
      this.pendingPrefill = null;
    }
  }

  ensureOpen() {
    if (this.isOpen) return;
    this.openTerminal();
  }

  initializeLinkProviders() {
    // リンクヒント（Ctrl/Cmd クリック案内）
    this.initializeLinkHint();
    this.trackMousePosition();

    const linkDetection = window.KawaiiLinkDetection;
    const buildLineTextWithCellMap = (bufferLine, { trimRight = true } = {}) => {
      const cols = this.terminal?.cols;
      if (linkDetection?.buildLineTextWithCellMap) {
        return linkDetection.buildLineTextWithCellMap(bufferLine, cols, { trimRight });
      }
      if (!bufferLine || !cols) {
        return { text: '', indexToX: [], indexToWidth: [] };
      }

      const indexToX = [];
      const indexToWidth = [];
      let text = '';

      const maxX = Math.min(cols, bufferLine.length || cols);
      for (let x = 0; x < maxX; x += 1) {
        const cell = bufferLine.getCell(x);
        if (!cell) break;
        const width = typeof cell.getWidth === 'function' ? cell.getWidth() : 1;
        if (width === 0) continue;
        let chars = typeof cell.getChars === 'function' ? cell.getChars() : '';
        if (chars === '') chars = ' ';
        text += chars;
        for (let i = 0; i < chars.length; i += 1) {
          indexToX.push(x + 1);
          indexToWidth.push(width);
        }
      }

      if (trimRight) {
        while (text.length > 0) {
          const last = text[text.length - 1];
          if (!/\s/.test(last)) break;
          text = text.slice(0, -1);
          indexToX.pop();
          indexToWidth.pop();
        }
      }

      return { text, indexToX, indexToWidth };
    };

    // Hyperと同じWebLinksAddonでURLを検出（無い場合はフォールバック）
    const WebLinksAddonCtor = window.WebLinksAddon?.WebLinksAddon || window.WebLinksAddon;
    if (WebLinksAddonCtor) {
      this.webLinksAddon?.dispose?.();
      this.webLinksAddon = new WebLinksAddonCtor((event, uri) => {
        event?.preventDefault?.();
        if (!this.shouldOpenLink(event)) return;
        if (window.shellAPI?.openExternal) {
          window.shellAPI.openExternal(uri);
        }
      }, {
        hover: (event) => {
          this.showLinkHintFromEvent(event);
        },
        leave: () => {
          this.hideLinkHint();
        },
      });
      this.terminal.loadAddon(this.webLinksAddon);
    } else {
      console.warn('[TerminalManager] WebLinksAddon is not available. Falling back to custom URL matcher.');
      // URLリンク（ツールチップ対応のためカスタム実装）
      // Common TLDs to recognize as URLs even without http(s)://
      const COMMON_TLDS = 'com|org|net|io|dev|app|co|me|ai|jp|edu|gov|info|biz|xyz|tech|cloud|online|site|page|link|live|pro|sh|gg|be|ly|gl|it|cc|to|tv|fm|ws|so|im|is|us|uk|de|fr|ru|cn|in|au|br|ca|nl|se|ch|at|es|nz|fi|no|dk|pt|ie|sg|hk|tw|kr|id|mx|ar|za';
      const urlRegex = new RegExp(
        `(https?:\\/\\/[^\\s<>"'()]+|(?:[a-zA-Z0-9][-a-zA-Z0-9]*\\.)+(?:${COMMON_TLDS})(?:\\/[^\\s<>"'()]*)?)(?![^\\s]*\\))`,
        'ig'
      );
      this.linkProviderDisposable = this.terminal.registerLinkProvider({
        provideLinks: (bufferLineNumber, callback) => {
          try {
            const buffer = this.terminal.buffer?.active;
            if (!buffer) return callback(undefined);
            const line = buffer.getLine(Math.max(0, bufferLineNumber - 1));
            if (!line) return callback(undefined);
            const { text, indexToX, indexToWidth } = buildLineTextWithCellMap(line);
            if (!text) return callback(undefined);

            const links = [];
            urlRegex.lastIndex = 0;
            let match;
            while ((match = urlRegex.exec(text)) !== null) {
              const url = match[0];
              const matchStart = match.index;
              const matchEnd = matchStart + url.length;
              const startX = indexToX[matchStart] ?? (matchStart + 1);
              const endIndex = matchEnd - 1;
              const endXBase = indexToX[endIndex] ?? (startX + url.length - 1);
              const endWidth = indexToWidth[endIndex] ?? 1;
              const endX = endXBase + Math.max(0, endWidth - 1);
              links.push({
                range: { start: { x: startX, y: bufferLineNumber }, end: { x: endX, y: bufferLineNumber } },
                text: url,
                activate: (event, linkText) => {
                  event?.preventDefault?.();
                  if (!this.shouldOpenLink(event)) return;
                  if (window.shellAPI?.openExternal) {
                    // Add https:// if no protocol specified
                    const urlToOpen = /^https?:\/\//i.test(linkText) ? linkText : `https://${linkText}`;
                    window.shellAPI.openExternal(urlToOpen);
                  }
                },
                hover: (event) => {
                  this.showLinkHintFromEvent(event);
                },
                leave: () => {
                  this.hideLinkHint();
                },
                decorations: { pointerCursor: true, underline: true },
              });
            }
            callback(links.length ? links : undefined);
          } catch (e) {
            console.error('Link provider error:', e);
            callback(undefined);
          }
        },
      });
    }

    // file:// リンク
    this.fileLinkProviderDisposable = this.terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        try {
          const buffer = this.terminal.buffer?.active;
          if (!buffer) return callback(undefined);
          const line = buffer.getLine(Math.max(0, bufferLineNumber - 1));
          if (!line) return callback(undefined);
          const { text, indexToX, indexToWidth } = buildLineTextWithCellMap(line);
          if (!text) return callback(undefined);

          const fileRegex = /(file:\/\/[^\s<>"'()]+)(?![^\s]*\))/ig;
          const links = [];
          let match;
          while ((match = fileRegex.exec(text)) !== null) {
            const url = match[0];
            const resolvedPath = this.resolveFileUrl(url);
            if (!resolvedPath) continue;
            if (this.isImagePath(resolvedPath)) continue;
            const matchStart = match.index;
            const matchEnd = matchStart + url.length;
            const startX = indexToX[matchStart] ?? (matchStart + 1);
            const endIndex = matchEnd - 1;
            const endXBase = indexToX[endIndex] ?? (startX + url.length - 1);
            const endWidth = indexToWidth[endIndex] ?? 1;
            const endX = endXBase + Math.max(0, endWidth - 1);
            const isMarkdown = MD_EXTENSIONS.test(resolvedPath);
            links.push({
              range: { start: { x: startX, y: bufferLineNumber }, end: { x: endX, y: bufferLineNumber } },
              text: url,
              activate: (event, _linkText) => {
                event?.preventDefault?.();
                if (!this.shouldOpenLink(event)) return;
                const cwd = this.getCwd();
                window.fileAPI?.openFile?.(resolvedPath, cwd || undefined);
              },
              hover: (event) => {
                this.showLinkHintFromEvent(event);
                if (isMarkdown) {
                  this.mdPreviewManager?.schedulePreview?.(resolvedPath);
                }
              },
              leave: () => {
                this.hideLinkHint();
                if (isMarkdown) {
                  this.mdPreviewManager?.cancelPreview?.();
                }
              },
              decorations: { pointerCursor: true, underline: true },
            });
          }
          callback(links.length ? links : undefined);
        } catch (e) {
          console.error('File link provider error:', e);
          callback(undefined);
        }
      },
    });

    // File path links (without file:// protocol)
    // Patterns:
    // - Windows absolute: C:\path\to\file.ext or C:/path/to/file.ext
    // - Unix absolute: /path/to/file.ext
    // - Relative with line number: path/to/file.ext:123 or file.ext:123:45
    // - Parenthesis format: file.ext(10,5)
    this.terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        try {
          const buffer = this.terminal.buffer?.active;
          if (!buffer) return callback(undefined);
          const bufferY = Math.max(0, bufferLineNumber - 1);
          const line = buffer.getLine(bufferY);
          if (!line) return callback(undefined);

          // Join wrapped lines into a single logical line.
          // - Explicit newline -> next line's isWrapped is false (do not join)
          // - Soft wrap -> next line's isWrapped is true (join)
          let startY = bufferY;
          while (startY > 0) {
            const cur = buffer.getLine(startY);
            if (!cur?.isWrapped) break;
            startY -= 1;
          }

          let endY = bufferY;
          while (endY + 1 < buffer.length) {
            const next = buffer.getLine(endY + 1);
            if (!next?.isWrapped) break;
            endY += 1;
          }

          const parts = [];
          let offset = 0;
          for (let y = startY; y <= endY; y += 1) {
            const l = buffer.getLine(y);
            const part = buildLineTextWithCellMap(l);
            parts.push({ y: y + 1, text: part.text, offset, indexToX: part.indexToX, indexToWidth: part.indexToWidth });
            offset += part.text.length;
          }

          const text = parts.map((p) => p.text).join('');
          if (!text) return callback(undefined);

          const partIndex = bufferY - startY;
          const currentPart = parts[partIndex] || null;
          if (!currentPart) return callback(undefined);
          const segmentStart = currentPart.offset;
          const segmentEnd = segmentStart + currentPart.text.length;

          const links = [];
          const isWin = window.windowAPI?.platform === 'win32';
          const linkDetection = window.KawaiiLinkDetection;
          const matches = linkDetection?.findFilePathMatches
            ? linkDetection.findFilePathMatches(text, { isWin, isImagePath: (p) => this.isImagePath(p) })
            : [];
          const getCellPositionForIndex = (index) => {
            if (!Number.isFinite(index)) return null;
            if (index < 0) return null;
            // Find the part containing the index.
            for (let i = parts.length - 1; i >= 0; i -= 1) {
              const part = parts[i];
              if (!part) continue;
              const start = part.offset;
              const end = start + part.text.length;
              if (index >= start && index < end) {
                const localIndex = index - start;
                const x = part.indexToX?.[localIndex] ?? (localIndex + 1);
                const width = part.indexToWidth?.[localIndex] ?? 1;
                return { x, y: part.y, width };
              }
            }
            return null;
          };
          for (const match of matches) {
            const fullMatch = match.text;
            const matchStart = match.startIndex;
            const matchEnd = match.endIndex;
            const pathOnly = match.path;
            const lineNum = match.line;
            const colNum = match.column;

            // If this match doesn't overlap the current buffer line fragment, don't return it here.
            if (matchEnd <= segmentStart || matchStart >= segmentEnd) {
              continue;
            }

            // Provide a multi-line range so xterm can underline across wrapped lines.
            const startPos = getCellPositionForIndex(matchStart);
            const endCell = getCellPositionForIndex(matchEnd - 1);
            if (!startPos || !endCell) {
              continue;
            }
            const endPos = { x: endCell.x + Math.max(0, (endCell.width || 1) - 1), y: endCell.y };

            // Capture for closure
            const capturedPath = pathOnly;
            const capturedLine = lineNum;
            const capturedCol = colNum;
            const isAbsolute = /^[A-Za-z]:[\\/]/.test(capturedPath) || capturedPath.startsWith('/');

            const isMarkdown = MD_EXTENSIONS.test(capturedPath);
            links.push({
              range: { start: startPos, end: endPos },
              text: fullMatch,
              activate: async (event) => {
                event?.preventDefault?.();
                if (!this.shouldOpenLink(event)) return;

                let resolvedPath = capturedPath;
                let cwd = this.getCwd();
                if (!cwd) {
                  cwd = await this.refreshCwdFromMain({ force: true });
                }

                // For relative paths, try to resolve with CWD (from OSC tracking)
                if (!isAbsolute) {
                  if (cwd) {
                    resolvedPath = this.resolvePath(cwd, capturedPath);
                  }
                }

                // Pass line number if available
                if (capturedLine && window.fileAPI?.openFileAtLine) {
                  window.fileAPI.openFileAtLine(resolvedPath, capturedLine, capturedCol);
                } else {
                  window.fileAPI?.openFile?.(resolvedPath, cwd || undefined);
                }
              },
              hover: (event) => {
                this.showLinkHintFromEvent(event);
                if (isMarkdown) {
                  this.mdPreviewManager?.schedulePreview?.(capturedPath);
                }
              },
              leave: () => {
                this.hideLinkHint();
                if (isMarkdown) {
                  this.mdPreviewManager?.cancelPreview?.();
                }
              },
              decorations: { pointerCursor: true, underline: true },
            });
          }

          callback(links.length ? links : undefined);
        } catch (e) {
          console.error('File path link provider error:', e);
          callback(undefined);
        }
      },
    });
  }

  setupCompositionHandling() {
    if (isMac()) return;
    if (!this.container) return;
    const textarea = this.container.querySelector('.xterm-helper-textarea');
    if (!textarea) return;

    this.compositionTextarea = textarea;
    this.compositionActive = false;

    // TUIモード + IME入力時に下部バーを表示
    textarea.addEventListener('compositionstart', () => {
      this.compositionActive = true;
      if (this.compositionFlushTimer) {
        clearTimeout(this.compositionFlushTimer);
        this.compositionFlushTimer = null;
      }
      if (this.isTuiMode()) {
        this.showTuiCompositionBar();
      }
    });

    textarea.addEventListener('compositionend', () => {
      this.compositionActive = false;
      this.hideTuiCompositionBar();
      this.schedulePendingCompositionFlush(60);
    });

    // フォーカスが外れた時もバーを非表示
    textarea.addEventListener('blur', () => {
      if (this.compositionActive) {
        this.hideTuiCompositionBar();
      }
    });
  }

  setupExtendedEnterHandling() {
    if (!this.terminal) return;
    this.terminal.attachCustomKeyEventHandler((event) => {
      if (!event || event.type !== 'keydown') return true;
      if (event.key !== 'Enter' && event.code !== 'NumpadEnter') return true;
      if (event.isComposing || this.compositionActive) return true;

      const isMacPlatform = isMac();
      const ctrlAllowed = !isMacPlatform;
      const wantsLineContinue = (event.shiftKey || (ctrlAllowed && event.ctrlKey))
        && !event.metaKey
        && !event.altKey;
      if (wantsLineContinue) {
        // Send backslash + Enter. Use CR only to avoid double newlines in some TUIs.
        window.terminalAPI?.sendInput?.(this.tabId, '\\\r');
        event.preventDefault();
        return false;
      }

      return true;
    });
  }

  getCompositionTextarea() {
    if (!this.container) return this.compositionTextarea;
    const textarea = this.container.querySelector('.xterm-helper-textarea');
    if (textarea && textarea !== this.compositionTextarea) {
      this.compositionTextarea = textarea;
    }
    return this.compositionTextarea;
  }

  /**
   * TUIモード用のIME入力バーを表示
   */
  showTuiCompositionBar() {
    const textarea = this.getCompositionTextarea();
    if (!textarea) return;

    // terminal-panelを基準に位置を計算
    const terminalPanel = this.container?.closest('.terminal-panel');
    if (terminalPanel) {
      const rect = terminalPanel.getBoundingClientRect();
      textarea.style.setProperty('--tui-bar-left', `${rect.left}px`);
      textarea.style.setProperty('--tui-bar-bottom', `${window.innerHeight - rect.bottom}px`);
      textarea.style.setProperty('--tui-bar-width', `${rect.width}px`);
    }

    const wasVisible = textarea.classList.contains('tui-composition-bar');
    textarea.classList.add('tui-composition-bar');
    if (!wasVisible) {
      window.kawaiiDebugLog('[IME] TUI composition bar shown');
    }
  }

  /**
   * TUIモード用のIME入力バーを非表示
   */
  hideTuiCompositionBar() {
    const textarea = this.getCompositionTextarea();
    if (!textarea) return;
    if (!textarea.classList.contains('tui-composition-bar')) return;

    // xterm.jsがテキストを処理する時間を十分に確保してから
    // バーを非表示にする（位置変更がIME処理に影響しないよう）
    setTimeout(() => {
      const current = this.getCompositionTextarea() || textarea;
      if (!current) return;
      current.classList.remove('tui-composition-bar');
      this.clearTuiCompositionInput();
      this.scheduleTuiCompositionClear(60);
      this.scheduleTuiCompositionClear(180);
      window.kawaiiDebugLog('[IME] TUI composition bar hidden');
    }, 50);
  }

  clearTuiCompositionInput() {
    const textarea = this.getCompositionTextarea();
    if (!textarea) return;
    if (!textarea.value) return;
    textarea.value = '';
  }

  clearStaleCompositionInputWhenHidden() {
    if (this.compositionActive) return;
    const textarea = this.getCompositionTextarea();
    if (!textarea) return;
    if (textarea.classList.contains('tui-composition-bar')) return;
    if (!textarea.value) return;
    textarea.value = '';
  }

  scheduleTuiCompositionClear(delayMs = 0) {
    setTimeout(() => {
      const textarea = this.getCompositionTextarea();
      if (!textarea) return;
      if (this.compositionActive) return;
      if (textarea.classList.contains('tui-composition-bar')) return;
      if (!textarea.value) return;
      textarea.value = '';
    }, delayMs);
  }

  schedulePendingCompositionFlush(delayMs = 0) {
    if (this.compositionFlushTimer) {
      clearTimeout(this.compositionFlushTimer);
    }
    this.compositionFlushTimer = setTimeout(() => {
      this.compositionFlushTimer = null;
      this.flushPendingCompositionClear();
    }, delayMs);
  }

  queueTuiCompositionClear() {
    this.pendingCompositionClear = true;
    this.flushPendingCompositionClear();
  }

  flushPendingCompositionClear() {
    if (!this.pendingCompositionClear) return;
    if (this.compositionActive) return;
    this.pendingCompositionClear = false;
    this.clearTuiCompositionInput();
    this.hideTuiCompositionBar();
  }

  /**
   * TUIモード（カーソルが右側 or alternate buffer）かどうか
   */
  isTuiMode() {
    const terminal = this.terminal;
    const buffer = terminal?.buffer?.active;
    if (!terminal || !buffer) return false;

    const cursorX = buffer.cursorX ?? 0;
    const cols = terminal.cols ?? 80;

    // カーソルが右90%にある、またはalternate bufferを使用中
    const isRightSide = cols > 0 && cursorX >= Math.floor(cols * 0.9);
    const isAlternate = buffer.type === 'alternate';

    return isRightSide || isAlternate;
  }

  isAlternateBufferActive() {
    try {
      // xterm.js v5+: buffer.active.type === 'alternate'
      const type = this.terminal?.buffer?.active?.type;
      if (type === 'alternate') return true;
      // フォールバック: normalと比較
      const buffer = this.terminal?.buffer;
      if (buffer?.active && buffer?.normal) {
        return buffer.active !== buffer.normal;
      }
      return false;
    } catch {
      return false;
    }
  }

  setupPasteHandling() {
    // ペースト処理はrenderer.jsで統一的に行う
    // ここでは右クリックメニューからのペースト用にpasteイベントをハンドル
    if (!this.container) return;
    const textarea = this.container.querySelector('.xterm-helper-textarea');
    if (!textarea) return;

    this.pasteHandler = async (e) => {
      // alternate buffer（TUI）の時のみrawPasteを使用
      if (!this.isAlternateBufferActive()) return;
      const text = e.clipboardData?.getData('text/plain') || '';
      if (!text) return;
      e.preventDefault();
      e.stopPropagation();
      await this.rawPaste(text);
    };

    textarea.addEventListener('paste', this.pasteHandler, true);
  }

  isTuiPasteMode() {
    if (this.isAlternateBufferActive()) return true;
    let modes = null;
    try {
      modes = this.terminal?.modes || null;
    } catch (_) {
      modes = null;
    }
    if (modes) {
      if (modes.mouseTrackingMode && modes.mouseTrackingMode !== 'none') return true;
      if (modes.applicationCursorKeysMode || modes.applicationKeypadMode) return true;
    }
    return false;
  }

  async rawPaste(text) {
    if (!text) return;
    for (let i = 0; i < text.length; i += RAW_PASTE_CHUNK_SIZE) {
      window.terminalAPI.sendInput(this.tabId, text.slice(i, i + RAW_PASTE_CHUNK_SIZE));
      if (RAW_PASTE_YIELD_MS >= 0) {
        await new Promise(resolve => setTimeout(resolve, RAW_PASTE_YIELD_MS));
      }
    }
  }

  shouldOpenLink(event) {
    if (!event) return false;
    return Boolean(event.ctrlKey || event.metaKey);
  }

  initializeLinkHint() {
    if (this.linkHintEl) return;
    this.linkHintEl = document.createElement('div');
    this.linkHintEl.className = 'terminal-link-hint';
    this.linkHintEl.textContent = this.getLinkHintText();
    document.body.appendChild(this.linkHintEl);
  }

  trackMousePosition() {
    document.addEventListener('mousemove', (event) => {
      this.lastMouseX = event.clientX;
      this.lastMouseY = event.clientY;
    }, { passive: true });
  }

  getLinkHintText() {
    const isMac = window.windowAPI?.platform === 'darwin';
    return isMac ? 'Cmd+Click to open' : 'Ctrl+Click to open';
  }

  showLinkHintFromEvent(event) {
    const x = typeof event?.clientX === 'number' ? event.clientX : this.lastMouseX;
    const y = typeof event?.clientY === 'number' ? event.clientY : this.lastMouseY;
    this.showLinkHint(x, y);
  }

  showLinkHint(x, y) {
    if (!this.linkHintEl) return;
    this.linkHintEl.textContent = this.getLinkHintText();

    const padding = 8;
    const offsetX = 10;
    const offsetY = 12;
    let left = x + offsetX;
    let top = y + offsetY;

    const rect = this.linkHintEl.getBoundingClientRect();
    const width = rect.width || 160;
    const height = rect.height || 28;

    if (left + width > window.innerWidth - padding) {
      left = x - width - padding;
    }
    if (top + height > window.innerHeight - padding) {
      top = y - height - padding;
    }

    left = Math.max(padding, left);
    top = Math.max(padding, top);

    this.linkHintEl.style.left = `${Math.round(left)}px`;
    this.linkHintEl.style.top = `${Math.round(top)}px`;
    this.linkHintEl.classList.add('show');
  }

  hideLinkHint() {
    if (!this.linkHintEl) return;
    this.linkHintEl.classList.remove('show');
  }

  isImagePath(filePath) {
    if (typeof filePath !== 'string') return false;
    return /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i.test(filePath);
  }

  resolveFileUrl(url) {
    if (typeof url !== 'string') return null;
    if (!/^file:\/\//i.test(url)) return null;

    let pathPart = url.replace(/^file:\/\//i, '');
    if (pathPart.startsWith('localhost/')) {
      pathPart = pathPart.slice('localhost/'.length);
    }

    // Decode percent-encoding if present
    try {
      pathPart = decodeURIComponent(pathPart);
    } catch (_) {
      // keep raw if decode fails
    }

    const isWin = window.windowAPI?.platform === 'win32';
    if (isWin) {
      if (/^\/[a-zA-Z]:\//.test(pathPart)) {
        pathPart = pathPart.slice(1);
      }
      const hasDrive = /^[a-zA-Z]:[\\/]/.test(pathPart);
      if (!hasDrive && !pathPart.startsWith('\\\\')) {
        pathPart = '\\\\' + pathPart.replace(/\//g, '\\');
      } else {
        pathPart = pathPart.replace(/\//g, '\\');
      }
    } else {
      if (!pathPart.startsWith('/')) {
        pathPart = '/' + pathPart;
      }
    }

    return pathPart;
  }

  handleResize() {
    if (!this.isOpen) return;
    if (this.fitAddon && this.terminal) {
      if (this.container && this.container.offsetWidth === 0 && this.container.offsetHeight === 0) {
        return;
      }
      try {
        this.fitAddon.fit();
        const { cols, rows } = this.terminal;
        window.terminalAPI.resize(this.tabId, cols, rows);
      } catch (e) {
        console.error('Resize error:', e);
      }
    }
  }

  focus() {
    this.terminal?.focus();
  }

  getTabId() {
    return this.tabId;
  }

  getHealthSnapshot() {
    return {
      tabId: this.tabId,
      isOpen: this.isOpen,
      disableStdin: Boolean(this.terminal?.options?.disableStdin),
      hasOutput: Boolean(this.hasOutput),
      lastInputAt: this.lastInputAt,
      lastOutputAt: this.lastOutputAt,
      deferOpen: Boolean(this.deferOpen),
    };
  }

  paste(text) {
    if (!text || !this.terminal) return;
    if (typeof this.terminal.paste === 'function') {
      this.terminal.paste(text);
    } else {
      window.terminalAPI.sendInput(this.tabId, text);
    }
  }

  clear() {
    this.terminal?.clear();
  }

  prefill(content) {
    if (!content || !this.terminal) return;
    this.terminal.write(content);
  }

  destroy() {
    // TUI IMEバーを非表示
    this.hideTuiCompositionBar();

    if (this.cwdRefreshTimer) {
      clearTimeout(this.cwdRefreshTimer);
      this.cwdRefreshTimer = null;
    }
    if (this.compositionFlushTimer) {
      clearTimeout(this.compositionFlushTimer);
      this.compositionFlushTimer = null;
    }

    if (this.pasteHandler) {
      try {
        const textarea = this.container?.querySelector?.('.xterm-helper-textarea');
        textarea?.removeEventListener?.('paste', this.pasteHandler, true);
      } catch (_) { /* noop */ }
      this.pasteHandler = null;
    }

    if (this.terminal) {
      this.terminal.dispose();
      this.terminal = null;
    }
    if (this.previewCacheTimer) {
      try { window.cancelAnimationFrame?.(this.previewCacheTimer); } catch (_) { /* noop */ }
      this.previewCacheTimer = null;
    }
    if (this.outputDisposer) {
      this.outputDisposer();
      this.outputDisposer = null;
    }
    if (this.openFitObserver) {
      try { this.openFitObserver.disconnect(); } catch (_) { /* noop */ }
      this.openFitObserver = null;
    }
    if (this.linkProviderDisposable) {
      try { this.linkProviderDisposable.dispose?.(); } catch (_) { /* noop */ }
      this.linkProviderDisposable = null;
    }
    if (this.fileLinkProviderDisposable) {
      try { this.fileLinkProviderDisposable.dispose?.(); } catch (_) { /* noop */ }
      this.fileLinkProviderDisposable = null;
    }
    if (this.webLinksAddon) {
      try { this.webLinksAddon.dispose?.(); } catch (_) { /* noop */ }
      this.webLinksAddon = null;
    }
    unregisterTerminalManager(this);
  }

  getSelection() {
    return this.terminal?.getSelection() || '';
  }

  hasSelection() {
    return this.terminal?.hasSelection() || false;
  }

  clearSelection() {
    this.terminal?.clearSelection();
  }

  findNext(term) {
    if (!this.searchAddon || !term) return false;
    return this.searchAddon.findNext(term, {
      caseSensitive: false,
      regex: false,
      wholeWord: false,
    });
  }

  findPrevious(term) {
    if (!this.searchAddon || !term) return false;
    return this.searchAddon.findPrevious(term, {
      caseSensitive: false,
      regex: false,
      wholeWord: false,
    });
  }

  setFontSize(value) {
    const fontSize = clampNumber(value, 10, 32, DEFAULT_TERMINAL_SETTINGS.fontSize);
    this.updateSettings({ fontSize });
  }

  adjustFontSize(delta) {
    this.setFontSize((this.settings?.fontSize || DEFAULT_TERMINAL_SETTINGS.fontSize) + delta);
  }

  resetFontSize() {
    this.setFontSize(DEFAULT_TERMINAL_SETTINGS.fontSize);
  }

  setScrollback(value) {
    const scrollback = clampNumber(value, 1000, 50000, DEFAULT_TERMINAL_SETTINGS.scrollback);
    this.updateSettings({ scrollback });
  }

  /**
   * Get the last N lines from the terminal buffer
   */
  getScreenContent(options = {}) {
    if (!this.terminal) return '';
    const buffer = this.terminal.buffer.active;
    if (!buffer) return '';

    const maxLines = Number.isFinite(options.maxLines) ? Math.max(1, options.maxLines) : SCREEN_CAPTURE_MAX_LINES;
    const maxChars = Number.isFinite(options.maxChars) ? Math.max(1, options.maxChars) : SCREEN_CAPTURE_MAX_CHARS;
    const startLine = Math.max(0, buffer.length - maxLines);

    const lines = [];
    for (let y = startLine; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    let content = lines.join('\r\n');
    if (maxChars && content.length > maxChars) {
      content = content.slice(-maxChars);
    }
    return content;
  }

  /**
   * Capture the terminal canvas as a data URL (PNG)
   */
  captureCanvas() {
    if (!this.terminal) return null;
    try {
      // xterm.js canvas structure varies - try multiple selectors
      let canvas = this.container?.querySelector('.xterm-screen canvas');
      if (!canvas) {
        canvas = this.container?.querySelector('canvas');
      }
      if (!canvas) {
        // Debug: log what we have
        console.warn('[TerminalManager] Canvas not found. Container:', this.container);
        console.warn('[TerminalManager] xterm element:', this.container?.querySelector('.xterm'));
        console.warn('[TerminalManager] All elements:', this.container?.innerHTML?.slice(0, 500));
        return null;
      }
      return canvas.toDataURL('image/png');
    } catch (e) {
      console.warn('[TerminalManager] Canvas capture failed:', e);
      return null;
    }
  }

  /**
   * Capture the last N lines from the buffer as HTML with inline ANSI colors.
   * This works even when WebGL/canvas is unavailable and is TUI-safe.
   */
  getBufferPreviewHtml(maxLines = 200) {
    if (!this.terminal) return null;
    const buffer = this.terminal.buffer?.active;
    if (!buffer) return null;
    const cols = this.terminal.cols || 0;
    if (cols <= 0 || buffer.length <= 0) return '';

    const reuseCell = buffer.getNullCell?.();
    let endLine = buffer.length - 1;
    while (endLine >= 0) {
      const line = buffer.getLine(endLine);
      if (lineHasVisuals(line, cols, reuseCell)) {
        break;
      }
      endLine -= 1;
    }
    if (endLine < 0) return '';
    const lineCount = Math.max(1, Math.floor(maxLines));
    const startLine = Math.max(0, endLine - lineCount + 1);
    let html = '';

    for (let y = startLine; y <= endLine; y += 1) {
      const line = buffer.getLine(y);
      if (!line) {
        if (y < endLine) html += '\n';
        continue;
      }

      let openStyle = '';
      let spanOpen = false;
      for (let x = 0; x < cols; x += 1) {
        const cell = line.getCell(x, reuseCell);
        if (!cell) continue;
        if (cell.getWidth?.() === 0) continue;
        let chars = cell.getChars?.() || '';
        if (!chars) chars = ' ';
        if (cell.isInvisible?.()) chars = ' ';

        const style = buildCellStyle(cell);
        if (style !== openStyle) {
          if (spanOpen) {
            html += '</span>';
            spanOpen = false;
          }
          openStyle = style;
          if (style) {
            html += `<span style="${style}">`;
            spanOpen = true;
          }
        }

        html += escapeHtml(chars);
      }

      if (spanOpen) {
        html += '</span>';
      }
      if (y < endLine) {
        html += '\n';
      }
    }

    return html;
  }

  getPreviewHtml(maxLines = 200) {
    const lines = Math.max(1, Math.floor(maxLines));
    if (this.previewCacheHtml !== null && this.previewCacheLines === lines) {
      return this.previewCacheHtml;
    }
    const html = this.getBufferPreviewHtml(lines);
    if (typeof html === 'string') {
      this.previewCacheHtml = html;
      this.previewCacheLines = lines;
    }
    return html;
  }

  schedulePreviewCapture(maxLines = 200) {
    const lines = Math.max(1, Math.floor(maxLines));
    if (this.previewCacheTimer) return;
    this.previewCacheTimer = window.requestAnimationFrame(() => {
      this.previewCacheTimer = null;
      const html = this.getBufferPreviewHtml(lines);
      if (typeof html === 'string') {
        this.previewCacheHtml = html;
        this.previewCacheLines = lines;
        if (this.onPreviewUpdated) {
          this.onPreviewUpdated(html);
        }
      }
    });
  }

  getScrollbackY() {
    const buffer = this.terminal?.buffer?.active;
    if (!buffer) return 0;
    return buffer.baseY || 0;
  }

  getViewportHash() {
    const terminal = this.terminal;
    const buffer = terminal?.buffer?.active;
    if (!terminal || !buffer) return 0;
    const rows = terminal.rows || 0;
    const start = Number.isFinite(buffer.viewportY) ? buffer.viewportY : (buffer.baseY || 0);
    const end = Math.min(buffer.length, start + rows);
    let hash = 2166136261;
    for (let y = start; y < end; y += 1) {
      const line = buffer.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = (hash * 16777619) >>> 0;
      }
      hash ^= 10; // '\n'
      hash = (hash * 16777619) >>> 0;
    }
    return hash >>> 0;
  }
}

// グローバルに公開
window.TerminalManager = TerminalManager;
