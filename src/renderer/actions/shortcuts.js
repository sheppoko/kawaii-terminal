(function () {
  'use strict';

  const SHORTCUTS_VERSION = 1;
  const SHORTCUT_MODIFIERS = ['Cmd', 'Ctrl', 'Alt', 'Shift'];
  const SHORTCUT_CATEGORIES = {
    TABS: 'Tabs / タブ',
    TERMINAL: 'Terminal / 端末',
    SIDEBAR: 'Sidebar / サイドバー',
    TOOLS: 'Tools / ツール',
    DEBUG: 'Debug / デバッグ',
  };

  const SHORTCUT_COMMANDS = [
    {
      id: 'window:new',
      title: 'New Window',
      description: '新しいウィンドウを開く',
      category: SHORTCUT_CATEGORIES.TABS,
      allowInEditable: false,
      defaults: { mac: ['Cmd+N'], win: ['Ctrl+N'] },
    },
    {
      id: 'tab:new',
      title: 'New Tab',
      description: '新しいタブを開く',
      category: SHORTCUT_CATEGORIES.TABS,
      allowInEditable: false,
      defaults: { mac: ['Cmd+T'], win: ['Ctrl+Shift+T'] },
    },
    {
      id: 'tab:close',
      title: 'Close Tab',
      description: '現在のタブを閉じる',
      category: SHORTCUT_CATEGORIES.TABS,
      allowInEditable: false,
      defaults: { mac: ['Cmd+Shift+W'], win: ['Ctrl+F4'] },
    },
    {
      id: 'pane:split-right',
      title: 'Split Right',
      description: '右に分割',
      category: SHORTCUT_CATEGORIES.TABS,
      allowInEditable: false,
      defaults: { mac: ['Cmd+D'], win: ['Alt+Plus'] },
    },
    {
      id: 'pane:split-down',
      title: 'Split Down',
      description: '下に分割',
      category: SHORTCUT_CATEGORIES.TABS,
      allowInEditable: false,
      defaults: { mac: ['Cmd+Shift+D'], win: ['Alt+Minus'] },
    },
    {
      id: 'pane:close',
      title: 'Close Pane',
      description: 'ペインを閉じる',
      category: SHORTCUT_CATEGORIES.TABS,
      allowInEditable: false,
      defaults: { mac: ['Cmd+W'], win: ['Ctrl+Shift+W'] },
    },
    {
      id: 'pane:focus-left',
      title: 'Focus Pane Left',
      description: '左のペインへ移動',
      category: SHORTCUT_CATEGORIES.TABS,
      allowInEditable: false,
      defaults: { mac: ['Cmd+Alt+ArrowLeft'], win: ['Alt+ArrowLeft'] },
    },
    {
      id: 'pane:focus-right',
      title: 'Focus Pane Right',
      description: '右のペインへ移動',
      category: SHORTCUT_CATEGORIES.TABS,
      allowInEditable: false,
      defaults: { mac: ['Cmd+Alt+ArrowRight'], win: ['Alt+ArrowRight'] },
    },
    {
      id: 'pane:focus-up',
      title: 'Focus Pane Up',
      description: '上のペインへ移動',
      category: SHORTCUT_CATEGORIES.TABS,
      allowInEditable: false,
      defaults: { mac: ['Cmd+Alt+ArrowUp'], win: ['Alt+ArrowUp'] },
    },
    {
      id: 'pane:focus-down',
      title: 'Focus Pane Down',
      description: '下のペインへ移動',
      category: SHORTCUT_CATEGORIES.TABS,
      allowInEditable: false,
      defaults: { mac: ['Cmd+Alt+ArrowDown'], win: ['Alt+ArrowDown'] },
    },
    {
      id: 'tab:activate-1',
      title: 'Activate Tab 1',
      description: '1番目のタブに移動',
      category: SHORTCUT_CATEGORIES.TABS,
      allowInEditable: false,
      defaults: { mac: ['Cmd+1'], win: ['Ctrl+1'] },
    },
    {
      id: 'tab:activate-2',
      title: 'Activate Tab 2',
      description: '2番目のタブに移動',
      category: SHORTCUT_CATEGORIES.TABS,
      allowInEditable: false,
      defaults: { mac: ['Cmd+2'], win: ['Ctrl+2'] },
    },
    {
      id: 'tab:activate-3',
      title: 'Activate Tab 3',
      description: '3番目のタブに移動',
      category: SHORTCUT_CATEGORIES.TABS,
      allowInEditable: false,
      defaults: { mac: ['Cmd+3'], win: ['Ctrl+3'] },
    },
    {
      id: 'tab:activate-4',
      title: 'Activate Tab 4',
      description: '4番目のタブに移動',
      category: SHORTCUT_CATEGORIES.TABS,
      allowInEditable: false,
      defaults: { mac: ['Cmd+4'], win: ['Ctrl+4'] },
    },
    {
      id: 'tab:activate-5',
      title: 'Activate Tab 5',
      description: '5番目のタブに移動',
      category: SHORTCUT_CATEGORIES.TABS,
      allowInEditable: false,
      defaults: { mac: ['Cmd+5'], win: ['Ctrl+5'] },
    },
    {
      id: 'tab:activate-6',
      title: 'Activate Tab 6',
      description: '6番目のタブに移動',
      category: SHORTCUT_CATEGORIES.TABS,
      allowInEditable: false,
      defaults: { mac: ['Cmd+6'], win: ['Ctrl+6'] },
    },
    {
      id: 'tab:activate-7',
      title: 'Activate Tab 7',
      description: '7番目のタブに移動',
      category: SHORTCUT_CATEGORIES.TABS,
      allowInEditable: false,
      defaults: { mac: ['Cmd+7'], win: ['Ctrl+7'] },
    },
    {
      id: 'tab:activate-8',
      title: 'Activate Tab 8',
      description: '8番目のタブに移動',
      category: SHORTCUT_CATEGORIES.TABS,
      allowInEditable: false,
      defaults: { mac: ['Cmd+8'], win: ['Ctrl+8'] },
    },
    {
      id: 'tab:activate-9',
      title: 'Activate Tab 9',
      description: '9番目のタブに移動',
      category: SHORTCUT_CATEGORIES.TABS,
      allowInEditable: false,
      defaults: { mac: ['Cmd+9'], win: ['Ctrl+9'] },
    },
    {
      id: 'tab:activate-10',
      title: 'Activate Tab 10',
      description: '10番目のタブに移動',
      category: SHORTCUT_CATEGORIES.TABS,
      allowInEditable: false,
      defaults: { mac: ['Cmd+0'], win: ['Ctrl+0'] },
    },
    {
      id: 'tab:switcher-next',
      title: 'Next Tab',
      description: '次のタブに切り替え',
      category: SHORTCUT_CATEGORIES.TABS,
      allowInEditable: false,
      defaults: { mac: ['Ctrl+Tab'], win: ['Ctrl+Tab'] },
    },
    {
      id: 'tab:switcher-prev',
      title: 'Previous Tab',
      description: '前のタブに切り替え',
      category: SHORTCUT_CATEGORIES.TABS,
      allowInEditable: false,
      defaults: { mac: ['Ctrl+Shift+Tab'], win: ['Ctrl+Shift+Tab'] },
    },
    {
      id: 'tab:notified',
      title: 'Notified Tab',
      description: '通知中のタブへ移動',
      category: SHORTCUT_CATEGORIES.TABS,
      allowInEditable: false,
      defaults: { mac: ['Alt+Tab'], win: ['Alt+Tab'] },
    },
    {
      id: 'terminal:find',
      title: 'Find',
      description: 'ターミナル内検索',
      category: SHORTCUT_CATEGORIES.TERMINAL,
      allowInEditable: true,
      defaults: { mac: ['Cmd+F'], win: ['Ctrl+F'] },
    },
    {
      id: 'terminal:clear',
      title: 'Clear',
      description: 'ターミナルをクリア',
      category: SHORTCUT_CATEGORIES.TERMINAL,
      allowInEditable: true,
      defaults: { mac: ['Cmd+K'], win: ['Ctrl+K'] },
    },
    {
      id: 'terminal:copy',
      title: 'Copy',
      description: 'ターミナルの選択をコピー',
      category: SHORTCUT_CATEGORIES.TERMINAL,
      allowInEditable: true,
      locked: true,
      defaults: { mac: ['Cmd+C'], win: ['Ctrl+C'] },
    },
    {
      id: 'terminal:paste',
      title: 'Paste',
      description: 'ターミナルに貼り付け',
      category: SHORTCUT_CATEGORIES.TERMINAL,
      allowInEditable: true,
      locked: true,
      defaults: { mac: ['Cmd+V'], win: ['Ctrl+V'] },
    },
    {
      id: 'terminal:cut',
      title: 'Cut',
      description: '入力の選択を切り取り',
      category: SHORTCUT_CATEGORIES.TERMINAL,
      allowInEditable: true,
      locked: true,
      defaults: { mac: ['Cmd+X'], win: ['Ctrl+X'] },
    },
    {
      id: 'terminal:select-all',
      title: 'Select All',
      description: 'ターミナルの選択を全て',
      category: SHORTCUT_CATEGORIES.TERMINAL,
      allowInEditable: true,
      defaults: { mac: ['Cmd+A'], win: ['Ctrl+A'] },
    },
    {
      id: 'terminal:font-increase',
      title: 'Increase Font Size',
      description: 'フォントサイズを上げる',
      category: SHORTCUT_CATEGORIES.TERMINAL,
      allowInEditable: true,
      defaults: { mac: ['Cmd+Plus'], win: ['Ctrl+Plus'] },
    },
    {
      id: 'terminal:font-decrease',
      title: 'Decrease Font Size',
      description: 'フォントサイズを下げる',
      category: SHORTCUT_CATEGORIES.TERMINAL,
      allowInEditable: true,
      defaults: { mac: ['Cmd+Minus'], win: ['Ctrl+Minus'] },
    },
    {
      id: 'terminal:font-reset',
      title: 'Reset Font Size',
      description: 'フォントサイズを戻す',
      category: SHORTCUT_CATEGORIES.TERMINAL,
      allowInEditable: true,
      defaults: { mac: ['Cmd+Equal'], win: ['Ctrl+Equal'] },
    },
    {
      id: 'view:toggle-sidebar',
      title: 'Toggle Sidebar',
      description: 'サイドバーを切り替え',
      category: SHORTCUT_CATEGORIES.SIDEBAR,
      allowInEditable: true,
      defaults: { mac: ['Cmd+Shift+L'], win: ['Ctrl+Shift+L'] },
    },
    {
      id: 'view:search',
      title: 'Left Pane Search',
      description: '左ペインの検索にフォーカス',
      category: SHORTCUT_CATEGORIES.SIDEBAR,
      allowInEditable: true,
      defaults: { mac: ['Cmd+Shift+F'], win: ['Ctrl+Shift+F'] },
    },
    {
      id: 'view:history',
      title: 'Left Pane History',
      description: '左ペインの履歴を開く',
      category: SHORTCUT_CATEGORIES.SIDEBAR,
      allowInEditable: true,
      defaults: { mac: ['Cmd+Shift+H'], win: ['Ctrl+Shift+H'] },
    },
    {
      id: 'view:active',
      title: 'Left Pane Active Agents',
      description: '左ペインのアクティブを開く',
      category: SHORTCUT_CATEGORIES.SIDEBAR,
      allowInEditable: true,
      defaults: { mac: ['Cmd+Shift+A'], win: ['Ctrl+Shift+A'] },
    },
    {
      id: 'view:pins',
      title: 'Left Pane Pins',
      description: '左ペインのピンを開く',
      category: SHORTCUT_CATEGORIES.SIDEBAR,
      allowInEditable: true,
      defaults: { mac: ['Cmd+Shift+O'], win: ['Ctrl+Shift+O'] },
    },
    {
      id: 'view:pin',
      title: 'Pin Last Output',
      description: '最後の出力をピン留め',
      category: SHORTCUT_CATEGORIES.TOOLS,
      allowInEditable: true,
      defaults: { mac: ['Cmd+Shift+P'], win: ['Ctrl+Shift+P'] },
    },
    {
      id: 'pin:copy-last',
      title: 'Copy Last Output',
      description: '最後の出力をコピー',
      category: SHORTCUT_CATEGORIES.TOOLS,
      allowInEditable: true,
      defaults: { mac: ['Cmd+Shift+Y'], win: ['Ctrl+Shift+Y'] },
    },
    {
      id: 'view:shortcuts',
      title: 'Keyboard Shortcuts',
      description: 'ショートカット一覧を表示',
      category: SHORTCUT_CATEGORIES.TOOLS,
      allowInEditable: true,
      defaults: { mac: ['Cmd+Shift+Slash'], win: ['Ctrl+Shift+Slash'] },
    },
    {
      id: 'window:toggle-devtools',
      title: 'Developer Tools',
      description: 'DevToolsを切り替え',
      category: SHORTCUT_CATEGORIES.DEBUG,
      allowInEditable: true,
      defaults: { mac: ['Alt+Cmd+I'], win: ['Ctrl+Shift+I'] },
    },
    {
      id: 'debug:menu',
      title: 'Debug Menu',
      description: 'デバッグメニュー',
      category: SHORTCUT_CATEGORIES.DEBUG,
      allowInEditable: true,
      defaults: { mac: ['Cmd+Shift+K'], win: ['Ctrl+Shift+K'] },
    },
  ];

  const LOCKED_SHORTCUT_COMMAND_IDS = new Set(
    SHORTCUT_COMMANDS.filter(cmd => cmd.locked).map(cmd => cmd.id),
  );

  const KEY_NAME_ALIASES = new Map([
    ['ESC', 'Escape'],
    ['ESCAPE', 'Escape'],
    ['SLASH', 'Slash'],
    ['/', 'Slash'],
    ['?', 'Slash'],
    ['PLUS', 'Plus'],
    ['+', 'Plus'],
    ['MINUS', 'Minus'],
    ['-', 'Minus'],
    ['PERIOD', 'Period'],
    ['.', 'Period'],
    ['COMMA', 'Comma'],
    [',', 'Comma'],
  ]);

  const KEY_DISPLAY_NAMES = {
    Escape: 'Esc',
    Tab: 'Tab',
    Space: 'Space',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Slash: '/',
    Plus: '+',
    Minus: '-',
    Period: '.',
    Comma: ',',
    Equal: '=',
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
  };

  const SHIFTED_KEY_DISPLAY = {
    '1': '!',
    '2': '@',
    '3': '#',
    '4': '$',
    '5': '%',
    '6': '^',
    '7': '&',
    '8': '*',
    '9': '(',
    '0': ')',
    Minus: '_',
    Equal: '+',
    BracketLeft: '{',
    BracketRight: '}',
    Backslash: '|',
    Semicolon: ':',
    Quote: '"',
    Comma: '<',
    Period: '>',
    Slash: '?',
  };

  const MOD_DISPLAY_MAC = { Cmd: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };
  const MOD_DISPLAY_WIN = { Cmd: 'Win', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };

  const isMac = () => window.windowAPI?.platform === 'darwin';

  function normalizeShortcutKeyName(raw) {
    const value = String(raw || '').trim();
    if (!value) return '';
    const upper = value.toUpperCase();
    if (KEY_NAME_ALIASES.has(upper)) return KEY_NAME_ALIASES.get(upper);
    if (/^[A-Z]$/.test(upper)) return upper;
    if (/^\d$/.test(value)) return value;
    return value;
  }

  function eventToShortcutKeyName(event) {
    const code = String(event.code || '');
    const key = String(event.key || '');
    if (code.startsWith('Key')) return code.slice(3).toUpperCase();
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) {
      if (code === 'NumpadAdd') return 'Plus';
      if (code === 'NumpadSubtract') return 'Minus';
      if (code === 'NumpadDivide') return 'Slash';
      if (code === 'NumpadDecimal') return 'Period';
      if (/^Numpad\d$/.test(code)) return code.slice(6);
    }
    if (code === 'Slash' || code === 'IntlRo' || code === 'IntlYen') return 'Slash';
    if (code === 'Period') return 'Period';
    if (code === 'Comma') return 'Comma';
    if (code === 'Minus') return 'Minus';
    if (code === 'Equal') return event.shiftKey ? 'Plus' : 'Equal';
    if (code === 'Semicolon' && event.shiftKey) return 'Plus';
    if (code === 'Tab') return 'Tab';
    if (code === 'Escape') return 'Escape';
    if (code === 'Space') return 'Space';
    if (code === 'Enter') return 'Enter';
    if (code === 'Backspace') return 'Backspace';
    if (code) return normalizeShortcutKeyName(code);
    if (key.length === 1) {
      return normalizeShortcutKeyName(key);
    }
    return normalizeShortcutKeyName(key);
  }

  function parseShortcutString(binding) {
    const raw = String(binding || '').trim();
    if (!raw) return null;
    const parts = raw.split('+').map(part => part.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    const keyPart = parts.pop();
    const key = normalizeShortcutKeyName(keyPart);
    if (!key) return null;
    const mods = { Cmd: false, Ctrl: false, Alt: false, Shift: false };
    parts.forEach((part) => {
      const token = part.trim();
      if (!token) return;
      const upper = token.toUpperCase();
      if (upper === 'CMD' || upper === 'COMMAND' || upper === 'META') mods.Cmd = true;
      if (upper === 'CTRL' || upper === 'CONTROL') mods.Ctrl = true;
      if (upper === 'ALT' || upper === 'OPTION') mods.Alt = true;
      if (upper === 'SHIFT') mods.Shift = true;
    });
    return { key, mods };
  }

  function serializeShortcut(mods, key) {
    const normalizedKey = normalizeShortcutKeyName(key);
    if (!normalizedKey) return '';
    const order = SHORTCUT_MODIFIERS.filter(mod => mods[mod]);
    return [...order, normalizedKey].join('+');
  }

  function formatShortcutParts(binding, platformKey) {
    const parsed = parseShortcutString(binding);
    if (!parsed) return [];
    const display = platformKey === 'mac' ? MOD_DISPLAY_MAC : MOD_DISPLAY_WIN;
    const parts = [];
    SHORTCUT_MODIFIERS.forEach((mod) => {
      if (parsed.mods[mod]) {
        parts.push(display[mod] || mod);
      }
    });
    const keyLabel = (parsed.mods.Shift && SHIFTED_KEY_DISPLAY[parsed.key])
      ? SHIFTED_KEY_DISPLAY[parsed.key]
      : (KEY_DISPLAY_NAMES[parsed.key] || parsed.key);
    parts.push(keyLabel);
    return parts;
  }

  function formatShortcutLabel(binding, platformKey, compact = false) {
    const parts = formatShortcutParts(binding, platformKey);
    if (parts.length === 0) return '';
    if (platformKey === 'mac' && compact) return parts.join('');
    return parts.join('+');
  }

  function isModifierOnlyEvent(event) {
    const key = String(event.key || '');
    return key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta';
  }

  function eventToShortcutBinding(event) {
    if (isModifierOnlyEvent(event)) return '';
    const key = eventToShortcutKeyName(event);
    if (!key) return '';
    const mods = {
      Cmd: Boolean(event.metaKey),
      Ctrl: Boolean(event.ctrlKey),
      Alt: Boolean(event.altKey),
      Shift: Boolean(event.shiftKey),
    };
    if (key === 'Plus') {
      mods.Shift = false;
    }
    const hasPrimary = mods.Cmd || mods.Ctrl || mods.Alt;
    if (!hasPrimary) return '';
    return serializeShortcut(mods, key);
  }

  window.eventToShortcutBinding = eventToShortcutBinding;

  function eventToShortcutParts(event) {
    const key = eventToShortcutKeyName(event);
    const mods = {
      Cmd: Boolean(event.metaKey),
      Ctrl: Boolean(event.ctrlKey),
      Alt: Boolean(event.altKey),
      Shift: Boolean(event.shiftKey),
    };
    if (key === 'Plus') {
      mods.Shift = false;
    }
    return {
      key: isModifierOnlyEvent(event) ? '' : key,
      mods,
    };
  }

  function buildDefaultShortcutMap() {
    const mac = {};
    const win = {};
    SHORTCUT_COMMANDS.forEach((cmd) => {
      mac[cmd.id] = Array.isArray(cmd.defaults?.mac) ? cmd.defaults.mac.slice() : [];
      win[cmd.id] = Array.isArray(cmd.defaults?.win) ? cmd.defaults.win.slice() : [];
    });
    return { mac, win };
  }

  function normalizeShortcutState(input) {
    const raw = input && typeof input === 'object' ? input : {};
    return {
      version: Number.isFinite(raw.version) ? raw.version : SHORTCUTS_VERSION,
      mac: raw.mac && typeof raw.mac === 'object' ? { ...raw.mac } : {},
      win: raw.win && typeof raw.win === 'object' ? { ...raw.win } : {},
    };
  }

  function normalizeBindingList(bindings) {
    if (!Array.isArray(bindings)) return [];
    const seen = new Set();
    const normalized = [];
    bindings.forEach((binding) => {
      const parsed = parseShortcutString(binding);
      if (!parsed) return;
      const norm = serializeShortcut(parsed.mods, parsed.key);
      if (!norm || seen.has(norm)) return;
      seen.add(norm);
      normalized.push(norm);
    });
    return normalized;
  }

  function createShortcutManager(options = {}) {
    const defaults = buildDefaultShortcutMap();
    const listeners = new Set();
    const bindingCache = new Map();
    const platformKey = isMac() ? 'mac' : 'win';
    const isLockedCommand = (commandId) => LOCKED_SHORTCUT_COMMAND_IDS.has(commandId);
    let capturing = false;

    let state = normalizeShortcutState(options?.initialState || options?.settings?.shortcuts);

    const saveState = () => {
      if (window.settingsAPI?.update) {
        window.settingsAPI.update({ shortcuts: { ...state } });
      }
    };

    const purgeLockedOverrides = () => {
      let changed = false;
      ['mac', 'win'].forEach((key) => {
        const map = state[key];
        if (!map || typeof map !== 'object') return;
        LOCKED_SHORTCUT_COMMAND_IDS.forEach((commandId) => {
          if (Object.prototype.hasOwnProperty.call(map, commandId)) {
            delete map[commandId];
            changed = true;
          }
        });
      });
      if (changed) saveState();
    };

    purgeLockedOverrides();

    const notify = () => {
      listeners.forEach((cb) => {
        try { cb(); } catch (_) { /* noop */ }
      });
    };

    const syncFromSettings = (settings) => {
      const next = normalizeShortcutState(settings?.shortcuts);
      const prev = JSON.stringify(state);
      const nextStr = JSON.stringify(next);
      if (prev === nextStr) return;
      state = next;
      purgeLockedOverrides();
      bindingCache.clear();
      notify();
    };

    if (window.settingsAPI?.onChange) {
      window.settingsAPI.onChange((payload) => {
        if (payload?.settings?.shortcuts) {
          syncFromSettings(payload.settings);
        }
      });
    }

    const getPlatformMap = () => state[platformKey] || {};

    const getBindings = (commandId) => {
      if (isLockedCommand(commandId)) {
        return normalizeBindingList(defaults[platformKey][commandId] || []);
      }
      const platformMap = getPlatformMap();
      if (Object.prototype.hasOwnProperty.call(platformMap, commandId)) {
        return normalizeBindingList(platformMap[commandId]);
      }
      return normalizeBindingList(defaults[platformKey][commandId] || []);
    };

    const setBindings = (commandId, bindings) => {
      if (isLockedCommand(commandId)) return;
      const platformMap = getPlatformMap();
      platformMap[commandId] = normalizeBindingList(bindings);
      state[platformKey] = platformMap;
      saveState();
      bindingCache.clear();
      notify();
    };

    const resetCommand = (commandId) => {
      if (isLockedCommand(commandId)) return;
      const platformMap = getPlatformMap();
      if (Object.prototype.hasOwnProperty.call(platformMap, commandId)) {
        delete platformMap[commandId];
        state[platformKey] = platformMap;
        saveState();
        bindingCache.clear();
        notify();
      }
    };

    const resetAll = () => {
      state[platformKey] = {};
      saveState();
      bindingCache.clear();
      notify();
    };

    const addBinding = (commandId, binding) => {
      if (isLockedCommand(commandId)) return;
      if (!binding) return;
      const current = getBindings(commandId);
      const normalized = normalizeBindingList([...current, binding]);
      setBindings(commandId, normalized);
    };

    const replaceBinding = (commandId, index, binding) => {
      if (isLockedCommand(commandId)) return;
      if (!binding) return;
      const current = getBindings(commandId);
      if (index < 0 || index >= current.length) return;
      const next = current.slice();
      next[index] = binding;
      setBindings(commandId, normalizeBindingList(next));
    };

    const removeBinding = (commandId, index) => {
      if (isLockedCommand(commandId)) return;
      const current = getBindings(commandId);
      if (index < 0 || index >= current.length) return;
      const next = current.slice();
      next.splice(index, 1);
      setBindings(commandId, next);
    };

    const getConflicts = () => {
      const occurrences = new Map();
      SHORTCUT_COMMANDS.forEach((cmd) => {
        const bindings = getBindings(cmd.id);
        bindings.forEach((binding) => {
          if (!binding) return;
          const list = occurrences.get(binding) || [];
          list.push(cmd.id);
          occurrences.set(binding, list);
        });
      });
      const conflicts = new Map();
      occurrences.forEach((list, binding) => {
        if (list.length > 1) {
          conflicts.set(binding, list);
        }
      });
      return conflicts;
    };

    const parseBindingCached = (binding) => {
      if (!binding) return null;
      if (bindingCache.has(binding)) return bindingCache.get(binding);
      const parsed = parseShortcutString(binding);
      bindingCache.set(binding, parsed);
      return parsed;
    };

    const matchEvent = (event) => {
      if (capturing) return null;
      if (!event || event.type !== 'keydown') return null;
      if (event.isComposing) return null;
      const key = eventToShortcutKeyName(event);
      if (!key) return null;
      const mods = {
        Cmd: Boolean(event.metaKey),
        Ctrl: Boolean(event.ctrlKey),
        Alt: Boolean(event.altKey),
        Shift: Boolean(event.shiftKey),
      };
      let bestMatch = null;
      let bestScore = -1;
      let bestOrder = -1;
      let orderIndex = 0;

      for (const cmd of SHORTCUT_COMMANDS) {
        const bindings = getBindings(cmd.id);
        for (const binding of bindings) {
          const parsed = parseBindingCached(binding);
          if (!parsed) { orderIndex += 1; continue; }
          if (parsed.key !== key) { orderIndex += 1; continue; }
          const implicitShift = parsed.key === 'Plus';
          const allowExtraShift = Boolean(cmd.allowExtraShift);
          const modMatch = SHORTCUT_MODIFIERS.every((mod) => {
            if (mod === 'Shift' && !parsed.mods.Shift && (implicitShift || allowExtraShift)) {
              return true;
            }
            return Boolean(parsed.mods[mod]) === Boolean(mods[mod]);
          });
          if (modMatch) {
            const modCount = SHORTCUT_MODIFIERS.reduce((sum, mod) => sum + (parsed.mods[mod] ? 1 : 0), 0);
            const score = modCount;
            if (score > bestScore || (score === bestScore && orderIndex > bestOrder)) {
              bestScore = score;
              bestOrder = orderIndex;
              bestMatch = { commandId: cmd.id, binding };
            }
          }
          orderIndex += 1;
        }
      }
      return bestMatch;
    };

    return {
      platformKey,
      commands: SHORTCUT_COMMANDS,
      getBindings,
      setBindings,
      addBinding,
      replaceBinding,
      removeBinding,
      resetCommand,
      resetAll,
      getConflicts,
      matchEvent,
      formatParts: (binding) => formatShortcutParts(binding, platformKey),
      formatLabel: (binding, compact = false) => formatShortcutLabel(binding, platformKey, compact),
      onChange: (cb) => {
        if (typeof cb !== 'function') return () => {};
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      setCapturing: (value) => { capturing = Boolean(value); },
      isCapturing: () => capturing,
    };
  }

  window.Shortcuts = {
    createShortcutManager,
    parseShortcutString,
    formatShortcutParts,
    formatShortcutLabel,
    eventToShortcutBinding,
    eventToShortcutParts,
  };
})();
