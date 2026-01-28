(function () {
  'use strict';

  const PIN_STORAGE_KEY = 'kawaii-terminal-pins';
  const MAX_PINS = 100;
  const MAX_PIN_OUTPUT_CHARS = 100_000;
  const PIN_INLINE_LIMIT = 120_000;
  const FALLBACK_CAPTURE_LINES = 200;
  const PIN_DB_NAME = 'kawaii-terminal-pin-db';
  const PIN_DB_VERSION = 1;
  const PIN_DB_STORE = 'pinData';
  const PASTE_CHUNK_SIZE = 1000;
  const PASTE_YIELD_MS = 6;

  let pinDbPromise = null;

  const DEFAULT_PIN_SETTINGS = {
    ansiEnabled: true,
  };

  function getPinDb() {
    if (!('indexedDB' in window)) {
      return Promise.resolve(null);
    }
    if (!pinDbPromise) {
      pinDbPromise = new Promise((resolve) => {
        const request = indexedDB.open(PIN_DB_NAME, PIN_DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(PIN_DB_STORE)) {
            db.createObjectStore(PIN_DB_STORE);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      });
    }
    return pinDbPromise;
  }

  async function writePinData(id, raw) {
    const db = await getPinDb();
    if (!db || !id) return false;
    return new Promise((resolve) => {
      const tx = db.transaction(PIN_DB_STORE, 'readwrite');
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      const store = tx.objectStore(PIN_DB_STORE);
      store.put(String(raw || ''), id);
    });
  }

  async function readPinData(id) {
    const db = await getPinDb();
    if (!db || !id) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(PIN_DB_STORE, 'readonly');
      tx.onerror = () => resolve(null);
      const store = tx.objectStore(PIN_DB_STORE);
      const request = store.get(id);
      request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null);
      request.onerror = () => resolve(null);
    });
  }

  async function deletePinData(id) {
    const db = await getPinDb();
    if (!db || !id) return false;
    return new Promise((resolve) => {
      const tx = db.transaction(PIN_DB_STORE, 'readwrite');
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      const store = tx.objectStore(PIN_DB_STORE);
      store.delete(id);
    });
  }

  function quotePathForShell(filePath) {
    if (!filePath) return '';
    if (window.windowAPI?.platform === 'win32') {
      return `'${filePath.replace(/'/g, "''")}'`;
    }
    return `'${filePath.replace(/'/g, `'\\''`)}'`;
  }

  function stripAnsiSequences(text) {
    if (!text) return '';
    let result = '';
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\x1b') {
        const next = text[i + 1];
        if (next === '[') {
          // CSI
          i += 2;
          while (i < text.length && !/[A-Za-z]/.test(text[i])) {
            i += 1;
          }
          i += 1;
          continue;
        }
        if (next === ']') {
          // OSC
          i += 2;
          while (i < text.length) {
            if (text[i] === '\x07') {
              i += 1;
              break;
            }
            if (text[i] === '\x1b' && text[i + 1] === '\\') {
              i += 2;
              break;
            }
            i += 1;
          }
          continue;
        }
        // Other escape sequences
        i += 2;
        continue;
      }
      if (ch === '\r') {
        i += 1;
        continue;
      }
      result += ch;
      i += 1;
    }
    return result;
  }

  function normalizeSerializedLines(serialized) {
    // Keep ANSI sequences, only trim trailing whitespace
    return serialized
      .split('\n')
      .map(line => line.replace(/[ \t]+$/g, ''));
  }

  function isEmptyOrPrompt(line) {
    // Strip ANSI for prompt detection, but preserve original line
    const stripped = stripAnsiSequences(line);
    const trimmed = stripped.trim();
    if (!trimmed) return true;
    if (/^>+\s*$/.test(trimmed)) return true;
    if (/^PS\s+.*>\s*$/.test(trimmed)) return true;
    if (/^[^$%]*[$%]\s*$/.test(trimmed) && trimmed.length < 80) return true;
    if (/^.*[❯➜λ›▶→⟩]\s*$/.test(trimmed) && trimmed.length < 80) return true;
    if (/^(dquote|quote|heredoc|pipe|bquote|cmdsubst)>\s*$/i.test(trimmed)) return true;
    return false;
  }

  function formatTime(ts) {
    try {
      const date = new Date(ts);
      const day = date.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
      const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `${day} ${time}`;
    } catch {
      return '';
    }
  }

  function isMac() {
    return window.windowAPI?.platform === 'darwin';
  }

  function formatCwdLabel(cwd) {
    const raw = String(cwd || '').trim();
    if (!raw) return '';
    const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normalized) return raw;
    const parts = normalized.split('/');
    return parts[parts.length - 1] || raw;
  }

  class PinManager {
    constructor(options = {}) {
      this.pins = this.loadPins();
      this.settings = { ...DEFAULT_PIN_SETTINGS };
      this.historyManager = options.historyManager || null;
      this.paneSessions = new Map(); // paneId -> { terminal, terminalManager, marker, lastCommand, pane }
      this.activeTabId = null;
      this.activePaneId = null;
      this.activePane = null; // Reference to the active pane object (with UI elements)
      this.selectedPinId = null;
      this.selectedProjectKey = 'all';
      this.currentTab = 'pins';
      this.pinDataCache = new Map();
      this.renderSeq = 0;
      this.pinGroupOpenState = new Map();
      this.pinGroupOpenInitialized = false;
      this.pinDetailOpenState = new Map();

      // DOM elements (left pane)
      this.pinListEl = document.getElementById('pin-list');
      this.pinDetailEl = document.getElementById('pin-detail');
      this.pinProjectListEl = document.getElementById('pin-project-list');
      this.pinSidebarCountEl = document.getElementById('pin-sidebar-count');
      this.previewToastEl = document.getElementById('terminal-preview-toast');
      this.previewToastTimer = null;
      this.lastActivePaneId = null;
      this.lastActivePane = null;

      this.setupEventListeners();
      this.migrateLargePins();
    }

    setHistoryManager(historyManager) {
      this.historyManager = historyManager || null;
    }

    isPanelOpen() {
      const active = window.leftPaneAPI?.getActivePane?.();
      return active === 'pins';
    }

    openPanel() {
      this.rememberActivePaneForRestore();
      window.leftPaneAPI?.setActivePane?.('pins');
    }

    closePanel({ restoreFocus = false } = {}) {
      window.leftPaneAPI?.setActivePane?.('history');
      if (restoreFocus) {
        this.restoreFocusToTerminal();
      }
    }

    togglePanel() {
      const current = window.leftPaneAPI?.getActivePane?.() || 'history';
      window.leftPaneAPI?.setActivePane?.(current === 'pins' ? 'history' : 'pins');
    }

    openPanelWithTab(tab) {
      if (tab === 'pins' || tab === 'history') {
        this.currentTab = tab;
      }
      window.leftPaneAPI?.setActivePane?.(this.currentTab === 'history' ? 'history' : 'pins');
    }

    togglePanelWithTab(tab) {
      const isSameTab = this.currentTab === tab;
      if (tab === 'pins' || tab === 'history') {
        this.currentTab = tab;
      }
      const active = window.leftPaneAPI?.getActivePane?.() || 'history';
      if (isSameTab && active === tab) {
        this.closePanel({ restoreFocus: true });
        return;
      }
      window.leftPaneAPI?.setActivePane?.(this.currentTab === 'history' ? 'history' : 'pins');
    }

    rememberActivePaneForRestore() {
      this.lastActivePaneId = this.activePaneId || null;
      this.lastActivePane = this.activePane || null;
    }

    restoreFocusToTerminal() {
      const pane = this.lastActivePane || this.activePane || null;
      let terminalManager = pane?.terminalManager || null;
      if (!terminalManager && this.lastActivePaneId) {
        terminalManager = this.paneSessions.get(this.lastActivePaneId)?.terminalManager || null;
      }
      if (!terminalManager && this.activePaneId) {
        terminalManager = this.paneSessions.get(this.activePaneId)?.terminalManager || null;
      }
      terminalManager?.focus?.();
    }

    getSettings() {
      return { ...this.settings };
    }

    setAnsiEnabled(enabled) {
      const next = Boolean(enabled);
      if (this.settings.ansiEnabled === next) return;
      this.settings.ansiEnabled = next;
      this.renderPins();
    }

    loadPins() {
      try {
        const saved = localStorage.getItem(PIN_STORAGE_KEY);
        if (saved) {
          const pins = JSON.parse(saved);
          if (!Array.isArray(pins)) return [];
          return pins.map((pin) => {
            const raw = typeof pin.raw === 'string' ? pin.raw : null;
            const size = Number.isFinite(pin.size) ? pin.size : (raw ? raw.length : 0);
            const storage = pin.storage || (raw ? 'inline' : 'idb');
            return {
              ...pin,
              raw: raw || undefined,
              size,
              storage,
            };
          });
        }
      } catch (e) {
        console.error('Failed to load pins:', e);
      }
      return [];
    }

    serializePins() {
      return this.pins.map((pin) => {
        const { raw, ...rest } = pin;
        if (pin.storage === 'inline' || (!pin.storage && typeof raw === 'string' && raw.length <= PIN_INLINE_LIMIT)) {
          return {
            ...rest,
            raw: typeof raw === 'string' ? raw : '',
            storage: 'inline',
            size: Number.isFinite(pin.size) ? pin.size : (typeof raw === 'string' ? raw.length : 0),
          };
        }
        return {
          ...rest,
          storage: pin.storage || 'idb',
          size: Number.isFinite(pin.size) ? pin.size : (typeof raw === 'string' ? raw.length : 0),
        };
      });
    }

    savePins() {
      try {
        localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(this.serializePins()));
      } catch (e) {
        console.error('Failed to save pins:', e);
        // Fallback: try to offload all pin bodies to IndexedDB and save metadata only.
        this.migrateAllPinsToIdb();
      }
    }

    async cleanupPinFile(pin) {
      if (!pin?.filePath) return;
      if (window.fileAPI?.deleteFile) {
        try {
          await window.fileAPI.deleteFile(pin.filePath);
        } catch (_) {
          // ignore
        }
      }
      delete pin.filePath;
    }

    async migrateLargePins() {
      const candidates = this.pins.filter(p => typeof p.raw === 'string' && p.raw.length > PIN_INLINE_LIMIT);
      if (candidates.length === 0) return;
      for (const pin of candidates) {
        const raw = pin.raw;
        const ok = await writePinData(pin.id, raw);
        if (ok) {
          pin.storage = 'idb';
          pin.size = raw.length;
          this.pinDataCache.set(pin.id, raw);
          delete pin.raw;
        }
      }
      this.savePins();
    }

    async migrateAllPinsToIdb() {
      const candidates = this.pins.filter(p => typeof p.raw === 'string');
      if (candidates.length === 0) return;
      for (const pin of candidates) {
        const raw = pin.raw;
        const ok = await writePinData(pin.id, raw);
        if (ok) {
          pin.storage = 'idb';
          pin.size = raw.length;
          this.pinDataCache.set(pin.id, raw);
          delete pin.raw;
        }
      }
      try {
        localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(this.serializePins()));
      } catch (e) {
        console.error('Failed to save pin metadata after migration:', e);
      }
    }

    async getPinRaw(pin) {
      if (!pin) return '';
      if (typeof pin.raw === 'string') return pin.raw;
      const cached = this.pinDataCache.get(pin.id);
      if (typeof cached === 'string') return cached;
      if (pin.storage === 'idb') {
        const stored = await readPinData(pin.id);
        if (typeof stored === 'string') {
          this.pinDataCache.set(pin.id, stored);
          return stored;
        }
      }
      return '';
    }

    getPinFileNameHint(pin) {
      const candidate = pin?.command || pin?.label || 'pin';
      const text = String(candidate || '').trim();
      if (!text) return 'pin';
      const token = text.split(/\s+/)[0] || 'pin';
      return token.slice(0, 32);
    }

    async savePinToTempFile(pin, raw) {
      if (!window.fileAPI?.writeTempTextFile) return null;
      const nameHint = this.getPinFileNameHint(pin);
      const filePath = await window.fileAPI.writeTempTextFile(raw, nameHint);
      return typeof filePath === 'string' && filePath.length > 0 ? filePath : null;
    }

    async pasteSelectedPin() {
      const pin = this.pins.find(p => p.id === this.selectedPinId) || this.pins[0];
      if (!pin) return;
      const raw = await this.getPinRaw(pin);
      if (!raw) return;
      // Strip ANSI for terminal paste
      const text = stripAnsiSequences(raw);
      await this.pasteTextToTerminal(text);
      this.showPreviewToast('Pasted!');
    }

    async writeClipboardText(text) {
      try {
        if (window.clipboardAPI?.writeText) {
          window.clipboardAPI.writeText(typeof text === 'string' ? text : '');
          return true;
        }
      } catch (_) {
        // ignore
      }

      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(typeof text === 'string' ? text : '');
          return true;
        }
      } catch (_) {
        // ignore
      }
      return false;
    }

    showPreviewCopyFeedback() {
      if (!this.copyBtn) return;
      this.copyBtn.classList.add('copied');
      setTimeout(() => {
        this.copyBtn?.classList.remove('copied');
      }, 700);
    }

    async copySelectedPin() {
      const pin = this.pins.find(p => p.id === this.selectedPinId) || this.pins[0];
      if (!pin) return false;
      const raw = await this.getPinRaw(pin);
      if (!raw) return false;
      // Strip ANSI for clipboard
      const text = stripAnsiSequences(raw);
      const ok = await this.writeClipboardText(text);
      if (ok) this.showPreviewToast('Copied!');
      return ok;
    }

    showPreviewToast(message) {
      if (!this.previewToastEl) return;
      if (this.previewToastTimer) {
        clearTimeout(this.previewToastTimer);
      }
      this.previewToastEl.textContent = message;
      this.previewToastEl.classList.add('show');
      this.previewToastTimer = setTimeout(() => {
        this.previewToastEl.classList.remove('show');
        this.previewToastTimer = null;
      }, 1500);
    }

    async pasteSelectedPinAsFile() {
      const pin = this.pins.find(p => p.id === this.selectedPinId) || this.pins[0];
      if (!pin) return;
      const raw = await this.getPinRaw(pin);
      if (!raw) return;

      if (pin.filePath) {
        await this.cleanupPinFile(pin);
      }

      // Strip ANSI for file output
      const text = stripAnsiSequences(raw);
      const filePath = await this.savePinToTempFile(pin, text);
      if (!filePath) return;
      pin.filePath = filePath;
      this.savePins();

      const quoted = quotePathForShell(filePath);
      await this.pasteTextToTerminal(`${quoted} `);
      this.showPreviewToast('File path pasted!');
    }

    async pasteTextToTerminal(text) {
      if (!text) return;
      if (!this.activePaneId) return;
      const session = this.paneSessions.get(this.activePaneId);
      const terminal = session?.terminal;
      if (!terminal) return;

      const ptySessionId = session?.terminalManager?.tabId || null;

      // 先頭と末尾の空行・プロンプト行を削除
      const isEmptyOrPrompt = (line) => {
        const trimmed = line.trim();
        if (!trimmed) return true;
        if (/^>+\s*$/.test(trimmed)) return true;
        if (/^PS\s+.*>\s*$/.test(trimmed)) return true;
        if (/^[^$%]*[$%]\s*$/.test(trimmed) && trimmed.length < 80) return true;
        if (/^.*[❯➜λ›▶→⟩]\s*$/.test(trimmed) && trimmed.length < 80) return true;
        if (/^(dquote|quote|heredoc|pipe|bquote|cmdsubst)>\s*$/i.test(trimmed)) return true;
        return false;
      };

      const lines = text.split('\n');
      while (lines.length > 0 && isEmptyOrPrompt(lines[0])) {
        lines.shift();
      }
      while (lines.length > 0 && isEmptyOrPrompt(lines[lines.length - 1])) {
        lines.pop();
      }
      const cleanedText = lines.join('\n').replace(/[\r\n\s]+$/, '');
      if (!cleanedText) return;

      const sendChunk = (chunk) => {
        if (ptySessionId && window.terminalAPI?.sendInput) {
          window.terminalAPI.sendInput(ptySessionId, chunk);
        } else if (typeof terminal.paste === 'function') {
          // Fallback if IPC is unavailable
          terminal.paste(chunk);
        }
      };

      for (let i = 0; i < cleanedText.length; i += PASTE_CHUNK_SIZE) {
        sendChunk(cleanedText.slice(i, i + PASTE_CHUNK_SIZE));
        if (PASTE_YIELD_MS >= 0) {
          await new Promise(resolve => setTimeout(resolve, PASTE_YIELD_MS));
        }
      }
    }

    setupEventListeners() {
      // Pin/copy button clicks are now handled per-pane in renderer.js createPane()

      // Pin list interactions
      this.pinListEl?.addEventListener('click', (e) => {
        if (this.isTextSelectionInElement(e.currentTarget)) return;
        const toggleDetailForItem = (pinItem, { forceOpen = false } = {}) => {
          if (!pinItem) return false;
          const pinId = pinItem.dataset.pinId || '';
          if (!pinId) return false;
          const isOpen = pinItem.classList.contains('show-detail');
          if (isOpen) {
            if (forceOpen) return true;
            pinItem.classList.remove('show-detail');
            this.pinDetailOpenState.set(pinId, false);
            return true;
          }
          pinItem.classList.add('show-detail');
          this.pinDetailOpenState.set(pinId, true);
          this.selectedPinId = pinId;
          this.renderPinDetailIntoItem(pinId, pinItem);
          return true;
        };

        const header = e.target.closest('.session-group-header');
        if (header && this.pinListEl.contains(header)) {
          const groupEl = header.closest('.session-group');
          if (!groupEl) return;
          const key = String(groupEl.dataset.cwd || '');
          const nextOpen = !(groupEl.classList.contains('open'));
          this.pinGroupOpenState.set(key, nextOpen);
          groupEl.classList.toggle('open', nextOpen);
          return;
        }

        const toggleBtn = e.target.closest('.pin-item-toggle');
        if (toggleBtn) {
          e.stopPropagation();
          const pinItem = toggleBtn.closest('.pin-item');
          if (!pinItem) return;
          toggleDetailForItem(pinItem, { forceOpen: false });
          return;
        }

        if (e.target.closest('.pin-item-detail')) {
          return;
        }

        const card = e.target.closest('.pin-item');
        if (!card) return;
        const pinId = card.dataset.pinId;
        if (pinId) {
          this.selectedPinId = pinId;
          this.highlightSelectedPin();
          toggleDetailForItem(card, { forceOpen: false });
        }
      });

      // Project filter click
      this.pinProjectListEl?.addEventListener('click', (e) => {
        if (this.isTextSelectionInElement(e.currentTarget)) return;
        const item = e.target.closest('.pin-project-item');
        if (!item) return;
        const key = String(item.dataset.projectKey || 'all');
        if (this.selectedProjectKey === key) return;
        this.selectedProjectKey = key;
        this.renderPins();
      });

      // Context menu pin action
      document.addEventListener('click', (e) => {
        const item = e.target.closest('[data-action="pin"]');
        if (item) {
          void this.pinLastOutput();
        }
      });
      this.currentTab = this.currentTab || window.leftPaneAPI?.getActivePane?.() || 'pins';
      this.updateHeader();
    }

    isTextSelectionInElement(element) {
      if (!element) return false;
      const selection = window.getSelection?.();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
      const { anchorNode, focusNode } = selection;
      const anchorEl = anchorNode?.nodeType === 1 ? anchorNode : anchorNode?.parentElement;
      const focusEl = focusNode?.nodeType === 1 ? focusNode : focusNode?.parentElement;
      if (!anchorEl && !focusEl) return false;
      return element.contains(anchorEl) || element.contains(focusEl);
    }

    // Update tooltips on a specific pane's buttons
    updatePaneTooltips(pane) {
      if (!pane) return;
      const mac = isMac();

      if (pane.pinBtn) {
        const pinShortcut = mac ? '⌘⇧P' : 'Ctrl+Shift+P';
        const pinTip = `Pin Last Output (${pinShortcut})`;
        pane.pinBtn.setAttribute('data-tooltip', pinTip);
        pane.pinBtn.removeAttribute('title');
      }

      if (pane.copyOutputBtn) {
        const copyShortcut = mac ? '⌘⇧Y' : 'Ctrl+Shift+Y';
        const copyTip = `Copy Last Output (${copyShortcut})`;
        pane.copyOutputBtn.setAttribute('data-tooltip', copyTip);
        pane.copyOutputBtn.removeAttribute('title');
      }
    }

    ensurePaneSession(paneId) {
      if (!this.paneSessions.has(paneId)) {
        this.paneSessions.set(paneId, {
          terminal: null,
          terminalManager: null,
          marker: null,
          lastCommand: null,
          pane: null,
        });
      }
      return this.paneSessions.get(paneId);
    }

    setActiveTab(tabId) {
      this.activeTabId = tabId;
    }

    setActivePane(paneId, pane) {
      this.activePaneId = paneId;
      this.activePane = pane || null;
      if (paneId) {
        this.ensurePaneSession(paneId);
        const session = this.paneSessions.get(paneId);
        if (session && pane) {
          session.pane = pane;
        }
      }
    }

    removeTab(tabId) {
      // When a tab is removed, remove all pane sessions belonging to that tab
      const toRemove = [];
      for (const [paneId] of this.paneSessions) {
        if (paneId.includes(tabId)) {
          toRemove.push(paneId);
        }
      }
      for (const paneId of toRemove) {
        this.removePane(paneId);
      }
      if (this.activeTabId === tabId) {
        this.activeTabId = null;
      }
    }

    removePane(paneId) {
      const session = this.paneSessions.get(paneId);
      try { session?.marker?.dispose?.(); } catch (_) { /* noop */ }
      this.paneSessions.delete(paneId);
      if (this.activePaneId === paneId) {
        this.activePaneId = null;
        this.activePane = null;
      }
    }

    attachTerminal(paneId, terminal, terminalManager, pane) {
      const session = this.ensurePaneSession(paneId);
      session.terminal = terminal || null;
      if (terminalManager) {
        session.terminalManager = terminalManager;
      }
      if (pane) {
        session.pane = pane;
      }
    }

    onCommandSubmit(paneId, command, terminal, terminalManager) {
      const session = this.ensurePaneSession(paneId);
      session.lastCommand = String(command || '').trim() || null;
      if (terminal) {
        session.terminal = terminal;
      }
      if (terminalManager) {
        session.terminalManager = terminalManager;
      }

      try { session.marker?.dispose?.(); } catch (_) { /* noop */ }
      session.marker = null;

      if (session.terminal?.registerMarker) {
        try {
          // Mark the line where the user submitted the command. We will capture from the next line.
          session.marker = session.terminal.registerMarker();
        } catch (e) {
          console.warn('[PinManager] Failed to register marker:', e);
          session.marker = null;
        }
      }
    }

    onOutput(paneId, _data, terminal) {
      // Keep this hook for compatibility; pin capture uses xterm serialize range when available.
      if (terminal) {
        this.attachTerminal(paneId, terminal);
      }
    }

    getOutputLinesFromSerialize(session, startLine) {
      const terminal = session?.terminal;
      const buffer = terminal?.buffer?.active;
      const serializeAddon = session?.terminalManager?.serializeAddon;
      if (!terminal || !buffer || !serializeAddon?.serialize) return null;

      const endLine = Math.max(0, buffer.length - 1);
      const hasRange = Number.isFinite(startLine) && startLine >= 0 && startLine <= endLine;
      const options = hasRange
        ? { range: { start: startLine, end: endLine }, excludeModes: true }
        : { scrollback: FALLBACK_CAPTURE_LINES, excludeModes: true };

      try {
        const serialized = serializeAddon.serialize(options);
        return normalizeSerializedLines(serialized);
      } catch (e) {
        console.warn('[PinManager] SerializeAddon failed:', e);
        return null;
      }
    }

    getOutputLinesFromBuffer(buffer, startLine) {
      const start = Math.max(0, startLine);
      const lines = [];
      for (let y = start; y < buffer.length; y++) {
        const line = buffer.getLine(y);
        if (!line) continue;
        lines.push(line.translateToString(true));
      }
      return lines;
    }

    trimOutputLines(lines) {
      const trimmed = Array.isArray(lines) ? [...lines] : [];
      while (trimmed.length > 0 && isEmptyOrPrompt(trimmed[0])) {
        trimmed.shift();
      }
      while (trimmed.length > 0 && isEmptyOrPrompt(trimmed[trimmed.length - 1])) {
        trimmed.pop();
      }
      return trimmed;
    }

    getSessionLastOutput(session) {
      const terminal = session?.terminal;
      const buffer = terminal?.buffer?.active;
      if (!session || !terminal || !buffer) return null;

      let startLine = -1;
      if (session.marker && !session.marker.isDisposed && session.marker.line >= 0) {
        startLine = session.marker.line + 1;
      }

      let lines = this.getOutputLinesFromSerialize(session, startLine);
      if (!lines) {
        const fallbackStart = startLine < 0 || startLine >= buffer.length
          ? Math.max(0, buffer.length - FALLBACK_CAPTURE_LINES)
          : startLine;
        lines = this.getOutputLinesFromBuffer(buffer, fallbackStart);
      }

      lines = this.trimOutputLines(lines);

      if (lines.length === 0) {
        let fallbackLines = this.getOutputLinesFromSerialize(session, -1);
        if (!fallbackLines) {
          const fallbackStart = Math.max(0, buffer.length - FALLBACK_CAPTURE_LINES);
          fallbackLines = this.getOutputLinesFromBuffer(buffer, fallbackStart);
        }
        lines = this.trimOutputLines(fallbackLines);
      }

      let text = lines.join('\n');

      let truncated = false;
      if (text.length > MAX_PIN_OUTPUT_CHARS) {
        text = text.slice(-MAX_PIN_OUTPUT_CHARS);
        truncated = true;
      }

      if (!text.trim()) return null;

      return {
        raw: text,
        command: session.lastCommand,
        truncated,
      };
    }

    // Get last output from the active pane
    getLastOutput() {
      if (!this.activePaneId) return null;

      return this.getSessionLastOutput(this.paneSessions.get(this.activePaneId));
    }

    getPaneCwd(paneId) {
      if (!paneId) return null;
      const session = this.paneSessions.get(paneId);
      const pane = session?.pane;
      const candidate = pane?.lastCwd || session?.terminalManager?.getCwd?.();
      const cwd = typeof candidate === 'string' ? candidate.trim() : '';
      return cwd || null;
    }

    getActiveCwd() {
      return this.getPaneCwd(this.activePaneId);
    }

    showNoOutputToast(pane) {
      const message = 'No output to pin';
      if (pane?.toastEl) {
        this.showPaneToast(pane, message);
        return;
      }
      this.showPreviewToast(message);
    }

    async pinLastOutput() {
      const output = this.getLastOutput();

      if (!output || !output.raw.trim()) {
        this.showNoOutputToast(this.activePane);
        return false;
      }

      const pin = {
        id: `pin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        raw: output.raw,
        command: output.command,
        cwd: this.getActiveCwd(),
        pinnedAt: Date.now(),
        label: output.command || `Output ${formatTime(Date.now())}`,
        storage: output.raw.length > PIN_INLINE_LIMIT ? 'idb' : 'inline',
        size: output.raw.length,
        truncated: output.truncated,
      };

      if (pin.storage === 'idb') {
        const ok = await writePinData(pin.id, pin.raw);
        if (ok) {
          this.pinDataCache.set(pin.id, pin.raw);
          delete pin.raw;
        } else {
          pin.storage = 'inline';
        }
      }

      this.pins.unshift(pin);

      // Limit pins
      while (this.pins.length > MAX_PINS) {
        const removed = this.pins.pop();
        if (removed?.storage === 'idb') {
          this.pinDataCache.delete(removed.id);
          void deletePinData(removed.id);
        }
        if (removed?.filePath) {
          void this.cleanupPinFile(removed);
        }
      }

      this.savePins();
      this.showPinFeedback(this.activePane);

      // Update pins panel only if it's currently displayed
      if (this.pinListEl) {
        this.selectedPinId = pin.id;
        this.renderPins();
      }

      return true;
    }

    // Pin output from a specific pane (called by button click)
    async pinPaneOutput(paneId, pane) {
      const session = this.paneSessions.get(paneId);
      if (!session) return false;

      const output = this.getPaneLastOutput(paneId);
      if (!output || !output.raw.trim()) {
        this.showNoOutputToast(pane);
        return false;
      }

      const pin = {
        id: `pin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        raw: output.raw,
        command: output.command,
        cwd: this.getPaneCwd(paneId),
        pinnedAt: Date.now(),
        label: output.command || `Output ${formatTime(Date.now())}`,
        storage: output.raw.length > PIN_INLINE_LIMIT ? 'idb' : 'inline',
        size: output.raw.length,
        truncated: output.truncated,
      };

      if (pin.storage === 'idb') {
        const ok = await writePinData(pin.id, pin.raw);
        if (ok) {
          this.pinDataCache.set(pin.id, pin.raw);
          delete pin.raw;
        } else {
          pin.storage = 'inline';
        }
      }

      this.pins.unshift(pin);

      while (this.pins.length > MAX_PINS) {
        const removed = this.pins.pop();
        if (removed?.storage === 'idb') {
          this.pinDataCache.delete(removed.id);
          void deletePinData(removed.id);
        }
        if (removed?.filePath) {
          void this.cleanupPinFile(removed);
        }
      }

      this.savePins();
      this.showPinFeedback(pane);

      // Update pins panel only if it's currently displayed
      if (this.pinListEl) {
        this.selectedPinId = pin.id;
        this.renderPins();
      }

      return true;
    }

    // Copy output from a specific pane (called by button click)
    async copyPaneOutput(paneId, pane) {
      const output = this.getPaneLastOutput(paneId);
      if (!output || !output.raw.trim()) {
        return false;
      }

      try {
        if (window.clipboardAPI?.writeText) {
          window.clipboardAPI.writeText(output.raw);
        } else {
          await navigator.clipboard.writeText(output.raw);
        }
        this.showCopyFeedback(pane);
        return true;
      } catch (e) {
        console.error('[PinManager] Failed to copy:', e);
        return false;
      }
    }

    // Get output from a specific pane
    getPaneLastOutput(paneId) {
      return this.getSessionLastOutput(this.paneSessions.get(paneId));
    }

    showPinFeedback(pane) {
      const targetPane = pane || this.activePane;
      if (!targetPane?.pinBtn) return;

      targetPane.pinBtn.classList.add('pinned');
      this.showPaneToast(targetPane, 'Pinned');
      setTimeout(() => {
        targetPane.pinBtn?.classList.remove('pinned');
      }, 800);
    }

    showCopyFeedback(pane) {
      const targetPane = pane || this.activePane;
      if (!targetPane?.copyOutputBtn) return;

      targetPane.copyOutputBtn.classList.add('copied');
      this.showPaneToast(targetPane, 'Copied');
      setTimeout(() => {
        targetPane.copyOutputBtn?.classList.remove('copied');
      }, 800);
    }

    showPaneToast(pane, message) {
      if (!pane?.toastEl) return;

      // Clear any existing timer for this pane
      if (pane.toastTimer) {
        clearTimeout(pane.toastTimer);
      }

      pane.toastEl.textContent = message;
      pane.toastEl.classList.add('show');

      pane.toastTimer = setTimeout(() => {
        pane.toastEl?.classList.remove('show');
        pane.toastTimer = null;
      }, 1500);
    }

    async copyLastOutput() {
      const output = this.getLastOutput();

      if (!output || !output.raw.trim()) {
        return false;
      }

      try {
        // Electron's clipboard API (via preload)
        if (window.clipboardAPI?.writeText) {
          window.clipboardAPI.writeText(output.raw);
        } else {
          await navigator.clipboard.writeText(output.raw);
        }
        this.showCopyFeedback(this.activePane);
        return true;
      } catch (e) {
        console.error('[PinManager] Failed to copy:', e);
        return false;
      }
    }

    unpin(pinId) {
      const idx = this.pins.findIndex(p => p.id === pinId);
      if (idx === -1) return;

      const [removed] = this.pins.splice(idx, 1);
      if (removed?.storage === 'idb') {
        this.pinDataCache.delete(removed.id);
        void deletePinData(removed.id);
      }
      if (removed?.filePath) {
        void this.cleanupPinFile(removed);
      }
      this.savePins();

      // Select next pin or none
      if (this.selectedPinId === pinId) {
        const pins = this.getFilteredPins();
        this.selectedPinId = pins[0]?.id || null;
      }
      this.pinDetailOpenState.delete(pinId);

      this.renderPins();
    }

    selectPin(pinId) {
      this.selectedPinId = pinId;
      this.highlightSelectedPin();
    }

    switchTab(tab) {
      if (tab !== 'pins' && tab !== 'history') return;
      this.currentTab = tab;
      window.leftPaneAPI?.setActivePane?.(tab);
    }

    updateHeader() {
      // No-op (right-side preview panel removed)
    }

    getFilteredPins() {
      if (this.selectedProjectKey === 'all') return this.pins;
      const key = String(this.selectedProjectKey || '').trim();
      if (!key) return this.pins;
      return this.pins.filter((pin) => {
        const cwd = typeof pin.cwd === 'string' ? pin.cwd.trim() : '';
        return cwd === key;
      });
    }

    getProjectStats() {
      const stats = new Map();
      for (const pin of this.pins) {
        const cwd = typeof pin.cwd === 'string' ? pin.cwd.trim() : '';
        if (!cwd) continue;
        const existing = stats.get(cwd) || {
          cwd,
          label: formatCwdLabel(cwd) || cwd,
          count: 0,
          latest: 0,
        };
        existing.count += 1;
        existing.latest = Math.max(existing.latest, Number(pin.pinnedAt) || 0);
        stats.set(cwd, existing);
      }
      return Array.from(stats.values()).sort((a, b) => {
        const byTime = Number(b.latest) - Number(a.latest);
        if (byTime !== 0) return byTime;
        return String(a.label || '').localeCompare(String(b.label || ''));
      });
    }

    renderProjectList() {
      if (!this.pinProjectListEl) return;
      const projects = this.getProjectStats();
      if (this.selectedProjectKey !== 'all' && !projects.find(p => p.cwd === this.selectedProjectKey)) {
        this.selectedProjectKey = 'all';
      }

      this.pinProjectListEl.innerHTML = '';
      const fragment = document.createDocumentFragment();

      const buildItem = ({ key, label, count, title }) => {
        const item = document.createElement('button');
        item.className = 'pin-project-item';
        item.type = 'button';
        item.dataset.projectKey = key;
        if (title) item.title = title;
        if (this.selectedProjectKey === key) {
          item.classList.add('active');
        }

        const labelEl = document.createElement('span');
        labelEl.className = 'pin-project-label';
        labelEl.textContent = label;
        item.appendChild(labelEl);

        const countEl = document.createElement('span');
        countEl.className = 'pin-project-count';
        countEl.textContent = String(count || 0);
        item.appendChild(countEl);

        return item;
      };

      fragment.appendChild(buildItem({
        key: 'all',
        label: 'ALL',
        count: this.pins.length,
        title: 'All projects',
      }));

      for (const project of projects) {
        fragment.appendChild(buildItem({
          key: project.cwd,
          label: project.label,
          count: project.count,
          title: project.cwd,
        }));
      }

      this.pinProjectListEl.appendChild(fragment);
    }

    renderPins() {
      this.renderProjectList();
      this.renderPinList();
      if (this.pinSidebarCountEl) {
        this.pinSidebarCountEl.textContent = String(this.pins.length);
      }
    }

    renderPinList() {
      if (!this.pinListEl) return;

      this.pinListEl.innerHTML = '';

      const pins = this.getFilteredPins();

      if (pins.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'pin-empty';
        if (this.selectedProjectKey === 'all') {
          empty.innerHTML = `
            <svg viewBox="0 0 24 24"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5v6l1 1 1-1v-6h5v-2l-2-2z" fill="currentColor"/></svg>
            <div>No pinned outputs yet</div>
            <div style="font-size: 11px; opacity: 0.7; margin-top: 4px;">Press ${isMac() ? '⌘' : 'Ctrl'}+Shift+P to pin</div>
          `;
        } else {
          empty.innerHTML = `
            <svg viewBox="0 0 24 24"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5v6l1 1 1-1v-6h5v-2l-2-2z" fill="currentColor"/></svg>
            <div>No pins in this project</div>
          `;
        }
        this.pinListEl.appendChild(empty);
        return;
      }

      // Ensure selection
      if (!this.selectedPinId || !pins.find(p => p.id === this.selectedPinId)) {
        this.selectedPinId = pins[0]?.id || null;
      }
      const fragment = document.createDocumentFragment();
      const groups = this.groupPinsByCwd(pins);
      if (!this.pinGroupOpenInitialized) {
        for (const group of groups) {
          if (!this.pinGroupOpenState.has(group.key)) {
            this.pinGroupOpenState.set(group.key, true);
          }
        }
        this.pinGroupOpenInitialized = true;
      }
      for (const group of groups) {
        fragment.appendChild(this.renderPinGroup(group));
      }
      this.pinListEl.appendChild(fragment);
      this.highlightSelectedPin();
    }

    groupPinsByCwd(pins) {
      const groupMap = new Map();
      for (const pin of pins) {
        const rawCwd = typeof pin.cwd === 'string' ? pin.cwd.trim() : '';
        const key = rawCwd || '(unknown)';
        const label = rawCwd ? (formatCwdLabel(rawCwd) || rawCwd) : '(unknown)';
        const timestamp = Number(pin.pinnedAt || 0) || 0;

        if (!groupMap.has(key)) {
          groupMap.set(key, {
            key,
            cwd: rawCwd || '(unknown)',
            label,
            pins: [],
            latest: timestamp,
          });
        }
        const group = groupMap.get(key);
        group.pins.push(pin);
        if (timestamp > group.latest) group.latest = timestamp;
      }

      const groups = Array.from(groupMap.values());
      groups.sort((a, b) => {
        if (b.latest !== a.latest) return b.latest - a.latest;
        return String(a.label || '').localeCompare(String(b.label || ''));
      });
      return groups;
    }

    renderPinGroup(group) {
      const groupEl = document.createElement('div');
      groupEl.className = 'session-group pin-group';
      groupEl.dataset.cwd = group.key;

      const isOpen = this.pinGroupOpenState.get(group.key) !== false;
      if (isOpen) groupEl.classList.add('open');

      const header = document.createElement('div');
      header.className = 'session-group-header';
      header.dataset.cwd = group.key;

      const icon = document.createElement('div');
      icon.className = 'session-group-icon';
      icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      header.appendChild(icon);

      const cwdLabel = document.createElement('span');
      cwdLabel.className = 'session-group-cwd';
      cwdLabel.textContent = group.label;
      cwdLabel.title = group.cwd;
      header.appendChild(cwdLabel);

      const badge = document.createElement('span');
      badge.className = 'session-group-badge';
      badge.textContent = String(group.pins.length);
      header.appendChild(badge);

      groupEl.appendChild(header);

      const body = document.createElement('div');
      body.className = 'session-group-body';
      for (const pin of group.pins) {
        body.appendChild(this.renderPinItem(pin));
      }
      groupEl.appendChild(body);

      return groupEl;
    }

    renderPinItem(pin) {
      const card = document.createElement('div');
      card.className = 'session-item pin-item';
      card.dataset.pinId = pin.id;
      const isOpen = this.pinDetailOpenState.get(pin.id) === true;
      if (isOpen) {
        card.classList.add('show-detail');
      }

      const header = document.createElement('div');
      header.className = 'session-item-header';

      const input = document.createElement('div');
      input.className = 'session-item-input';
      input.textContent = pin.command ? `> ${pin.command}` : pin.label || '(no label)';
      header.appendChild(input);

      const meta = document.createElement('div');
      meta.className = 'session-item-meta';

      const time = document.createElement('span');
      time.className = 'session-item-time';
      time.textContent = formatTime(pin.pinnedAt);
      meta.appendChild(time);

      const chip = document.createElement('span');
      chip.className = 'terminal-session-badge pin-item-chip session-item-source';
      chip.textContent = 'PIN';
      meta.appendChild(chip);
      header.appendChild(meta);

      const output = document.createElement('div');
      output.className = 'session-item-output';
      const rawPreview = typeof pin.raw === 'string' ? pin.raw : '';
      const previewText = rawPreview.slice(0, 200).split('\n').slice(0, 3).join('\n');
      const previewPlain = stripAnsiSequences(previewText);
      output.textContent = previewPlain || '(loading...)';
      header.appendChild(output);

      const unpinBtn = document.createElement('button');
      unpinBtn.className = 'pin-item-action pin-item-unpin';
      unpinBtn.title = 'Unpin';
      unpinBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.12 1.87c-1.36-1.36-3.64-1.1-4.66.53l-2.7 4.33 1.44 1.45c.04-.05.08-.1.11-.16l2.85-4.56c.34-.55 1.1-.63 1.55-.18l4.93 4.93c.45.45.37 1.21-.11 1.55l-4.56 2.85c-.06.03-.11.07-.16.11l1.44 1.44 4.33-2.7c1.64-1.02 1.9-3.3.54-4.66l-4.93-4.93z"/><path d="M3.57 8.85c.03-.59.28-1.17.76-1.58l1.45 1.45-.06.02c-.07.03-.1.06-.11.08a.35.35 0 0 0-.04.15c-.01.18.07.43.27.63l8.49 8.49c.2.2.45.28.63.27.08 0 .13-.03.15-.04.02-.01.05-.04.08-.11l.02-.06 1.45 1.45c-.41.48-.99.73-1.58.76-.78.05-1.59-.27-2.17-.85l-3.54-3.54-6.68 6.68a1 1 0 0 1-1.41-1.41l6.68-6.68-3.54-3.54c-.58-.58-.9-1.38-.85-2.17z"/><path d="M2.01 2.01a1 1 0 0 1 1.41 0l18.58 18.58a1 1 0 0 1-1.41 1.41L2.01 3.42a1 1 0 0 1 0-1.41z"/></svg>';
      unpinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.unpin(pin.id);
      });
      header.appendChild(unpinBtn);

      const footer = document.createElement('div');
      footer.className = 'session-item-footer';

      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'session-item-toggle pin-item-toggle';
      toggleBtn.title = 'Toggle Details';
      toggleBtn.innerHTML = [
        '<span class="session-item-toggle-label">Details</span>',
        '<span class="session-item-toggle-icon">',
        '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        '</span>',
      ].join('');
      footer.appendChild(toggleBtn);
      header.appendChild(footer);

      card.appendChild(header);

      const detail = document.createElement('div');
      detail.className = 'pin-item-detail';
      detail.dataset.pinId = pin.id;
      if (isOpen) {
        void this.renderPinDetailInto(pin, detail);
      }
      card.appendChild(detail);

      // Load preview asynchronously if needed
      if (!rawPreview && pin.storage === 'idb') {
        void this.loadPinPreview(pin, output);
      }

      return card;
    }

    async loadPinPreview(pin, previewEl) {
      const raw = await this.getPinRaw(pin);
      if (!raw || !previewEl.isConnected) return;
      const previewText = raw.slice(0, 200).split('\n').slice(0, 3).join('\n');
      const previewPlain = stripAnsiSequences(previewText);
      previewEl.textContent = previewPlain || '(empty)';
    }

    renderPinDetailIntoItem(pinId, pinItem) {
      if (!pinId || !pinItem) return;
      const detail = pinItem.querySelector('.pin-item-detail');
      if (!detail) return;
      const pin = this.pins.find(p => p.id === pinId);
      if (!pin) return;
      void this.renderPinDetailInto(pin, detail);
    }

    async renderPinDetailInto(pin, container) {
      if (!pin || !container) return;
      const renderId = ++this.renderSeq;
      container.dataset.renderSeq = String(renderId);
      container.replaceChildren();

      const loading = document.createElement('div');
      loading.className = 'pin-detail-loading';
      loading.textContent = 'Loading...';
      container.appendChild(loading);

      const raw = await this.getPinRaw(pin);
      if (!container.isConnected) return;
      if (container.dataset.renderSeq !== String(renderId)) return;

      container.replaceChildren();

      if (!raw) {
        const empty = document.createElement('div');
        empty.className = 'pin-detail-empty';
        empty.textContent = 'No data available';
        container.appendChild(empty);
        return;
      }

      this.selectedPinId = pin.id;
      this.highlightSelectedPin();

      const card = document.createElement('div');
      card.className = 'pin-detail';
      container.appendChild(card);

      const header = document.createElement('div');
      header.className = 'pin-detail-header';

      const meta = document.createElement('div');
      meta.className = 'pin-detail-meta';
      meta.textContent = formatTime(pin.pinnedAt);
      header.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'pin-detail-actions';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'pin-detail-btn icon';
      copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
      copyBtn.title = 'Copy to clipboard';
      copyBtn.addEventListener('click', () => {
        this.selectedPinId = pin.id;
        this.copySelectedPin();
      });
      actions.appendChild(copyBtn);

      const pasteBtn = document.createElement('button');
      pasteBtn.className = 'pin-detail-btn icon';
      pasteBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="8" y="2" width="8" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
      pasteBtn.title = 'Paste to terminal';
      pasteBtn.addEventListener('click', () => {
        this.selectedPinId = pin.id;
        this.pasteSelectedPin();
      });
      actions.appendChild(pasteBtn);

      const pasteFileBtn = document.createElement('button');
      pasteFileBtn.className = 'pin-detail-btn icon';
      pasteFileBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="none" stroke="currentColor" stroke-width="2"/><polyline points="14 2 14 8 20 8" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
      pasteFileBtn.title = 'Paste as file';
      pasteFileBtn.addEventListener('click', () => {
        this.selectedPinId = pin.id;
        this.pasteSelectedPinAsFile();
      });
      actions.appendChild(pasteFileBtn);

      header.appendChild(actions);
      card.appendChild(header);

      if (pin.command || pin.label) {
        const labelEl = document.createElement('div');
        labelEl.className = 'pin-detail-label';
        labelEl.textContent = pin.command ? `> ${pin.command}` : pin.label;
        card.appendChild(labelEl);
      }

      if (pin.truncated) {
        const truncatedEl = document.createElement('div');
        truncatedEl.className = 'pin-detail-truncated';
        truncatedEl.textContent = `Truncated: showing last ${MAX_PIN_OUTPUT_CHARS.toLocaleString()} chars`;
        card.appendChild(truncatedEl);
      }

      const contentEl = document.createElement('pre');
      contentEl.className = 'pin-detail-content terminal-pin-content';
      if (this.settings.ansiEnabled && window.ansiAPI?.toHtml) {
        contentEl.innerHTML = window.ansiAPI.toHtml(raw);
      } else {
        contentEl.textContent = stripAnsiSequences(raw);
      }
      card.appendChild(contentEl);
    }

    highlightSelectedPin() {
      if (!this.pinListEl) return;
      const cards = this.pinListEl.querySelectorAll('.pin-item');
      cards.forEach((card) => {
        const id = card.dataset.pinId;
        card.classList.toggle('active', id === this.selectedPinId);
      });
    }

    async renderPinDetail() {
      if (!this.pinDetailEl) return;

      const pins = this.getFilteredPins();
      const pin = pins.find(p => p.id === this.selectedPinId) || pins[0];

      if (!pin) {
        this.pinDetailEl.innerHTML = `
          <div class="pin-detail-empty">
            <svg viewBox="0 0 24 24"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5v6l1 1 1-1v-6h5v-2l-2-2z" fill="currentColor"/></svg>
            <div>Select a pin to view</div>
          </div>
        `;
        this.updateHeader();
        return;
      }

      this.selectedPinId = pin.id;
      await this.renderPinDetailInto(pin, this.pinDetailEl);
      this.updateHeader();
    }

  }

  window.PinManager = PinManager;
})();
