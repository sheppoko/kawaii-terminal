(function () {
  'use strict';

  const IDLE_MS = 3000;
  const OUTPUT_IDLE_MS = 1000;
  const OUTPUT_HEAD_CHARS = 400;
  const OUTPUT_TAIL_CHARS = 400;
  const FALLBACK_CAPTURE_LINES = 200;
  const SESSION_STATUS_WORKING = 'working';
  const SESSION_STATUS_WAITING_USER = 'waiting_user';
  const SESSION_STATUS_COMPLETED = 'completed';

  function isAltBuffer(terminal) {
    const type = terminal?.buffer?.active?.type;
    return type === 'alternate';
  }

  function hasCursorEdit(data) {
    if (!data) return false;
    if (data.includes('\r')) return true;
    // eslint-disable-next-line no-control-regex
    const csiEdit = /\x1b\[[0-9;]*[A-DGKHJ]/;
    return csiEdit.test(data);
  }

  function classifyOutput(data, terminal, state) {
    const buffer = terminal?.buffer?.active;
    const baseY = Number(buffer?.baseY) || 0;
    const length = Number(buffer?.length) || 0;
    const scrollMoved = baseY > (state.lastBaseY || 0) || length > (state.lastLength || 0);
    state.lastBaseY = baseY;
    state.lastLength = length;

    const cursorEdit = hasCursorEdit(data);
    const hasNewline = data.includes('\n');
    const meaningful = hasNewline || scrollMoved;
    return { meaningful, cursorEdit };
  }

  function hasVisibleOutput(data) {
    if (!data || typeof data !== 'string') return false;
    // Convert C1 control codes (8-bit) to 7-bit ESC sequences
    let text = data
      .replace(/\x90/g, '\x1bP')   // DCS
      .replace(/\x98/g, '\x1bX')   // SOS
      .replace(/\x9b/g, '\x1b[')   // CSI
      .replace(/\x9d/g, '\x1b]')   // OSC
      .replace(/\x9e/g, '\x1b^')   // PM
      .replace(/\x9f/g, '\x1b_')   // APC
      .replace(/\x9c/g, '\x1b\\'); // ST
    text = text
      // OSC sequences: \x1b] ... (BEL or ST)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
      // DCS sequences: \x1bP ... ST
      // eslint-disable-next-line no-control-regex
      .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
      // SOS sequences: \x1bX ... ST
      // eslint-disable-next-line no-control-regex
      .replace(/\x1bX[\s\S]*?\x1b\\/g, '')
      // PM sequences: \x1b^ ... ST
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\^[\s\S]*?\x1b\\/g, '')
      // APC sequences: \x1b_ ... ST
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b_[\s\S]*?\x1b\\/g, '')
      // CSI sequences: \x1b[ params intermediate final
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      // Fe sequences (single-char after ESC)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[@-Z\\-_]/g, '')
      // Remaining control characters
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, '');
    return /[^\s]/u.test(text);
  }

  function shouldCountOutputForIdle(terminalManager, state, data) {
    if (!terminalManager || !state) return false;
    if (!hasVisibleOutput(data)) return false;
    const currentBaseY = terminalManager.getScrollbackY?.() ?? 0;
    const prevBaseY = terminalManager.lastScrollbackY ?? 0;
    const currentViewportHash = terminalManager.getViewportHash?.() ?? 0;
    const prevViewportHash = terminalManager.lastViewportHash ?? 0;
    terminalManager.lastScrollbackY = currentBaseY;
    terminalManager.lastViewportHash = currentViewportHash;
    const shouldCount = currentBaseY > prevBaseY || currentViewportHash !== prevViewportHash;
    if (shouldCount && (!state.outputRunning || !state.outputBaseline)) {
      state.outputBaseline = {
        baseY: prevBaseY,
        viewportHash: prevViewportHash,
        terminalManager,
      };
    }
    return shouldCount;
  }

  function hasNetOutputChange(baseline) {
    if (!baseline) return true;
    const terminal = baseline.terminalManager;
    if (!terminal) return true;
    const currentBaseY = terminal.getScrollbackY?.() ?? 0;
    const currentViewportHash = terminal.getViewportHash?.() ?? 0;
    return currentBaseY !== baseline.baseY || currentViewportHash !== baseline.viewportHash;
  }

  function captureOutputFromMarker(terminal, marker, endMarker = null, store = null) {
    const buffer = terminal?.buffer?.active;
    if (!buffer) return '';

    let startLine = -1;
    if (marker && !marker.isDisposed && marker.line >= 0) {
      startLine = marker.line + 1;
    }
    if (startLine < 0 || startLine >= buffer.length) {
      startLine = Math.max(0, buffer.length - FALLBACK_CAPTURE_LINES);
    }

    let endLine = buffer.length;
    if (endMarker && !endMarker.isDisposed && endMarker.line >= 0 && endMarker.line <= buffer.length) {
      endLine = Math.max(startLine, Math.min(endLine, endMarker.line));
    }

    const lines = [];
    for (let y = startLine; y < endLine; y += 1) {
      const line = buffer.getLine(y);
      if (!line) continue;

      const text = line.translateToString(true);
      lines.push(text);
    }

    const raw = lines.join('\n');
    return store?.normalizeOutputText ? store.normalizeOutputText(raw) : String(raw || '').trimEnd();
  }

  class HistorySessionTracker {
    constructor(options = {}) {
      this.sessionId = options.sessionId || 'session';
      this.historySource = String(options.historySource || 'all').trim().toLowerCase();
      this.store = options.store || null;
      this.onRender = typeof options.onRender === 'function' ? options.onRender : null;
      this.onStatusChange = typeof options.onStatusChange === 'function' ? options.onStatusChange : null;
      this.isPanelActive = typeof options.isPanelActive === 'function' ? options.isPanelActive : null;

      this.panes = new Map();
      this.blocks = [];
      this.blockMap = new Map();
      this.blockCounter = 0;
      this.debugInfo = {
        lastNotify: null,
        lastCommand: null,
        lastShell: null,
        lastProfile: null,
        oscCount: 0,
        oscKawaiiCount: 0,
        lastOsc: '',
        lastKawaiiOsc: '',
        cwdCount: 0,
        lastCwd: '',
      };
      this.statusProvider = null;
      this.statusChangeListener = null;
      this.activePaneId = null;
      this.activePane = null;
      this.activeTabId = null;
      this.activeTabLabel = '';
    }

    setHistorySource(source) {
      this.historySource = String(source || '').trim().toLowerCase() || 'all';
    }

    setOnRender(handler) {
      this.onRender = typeof handler === 'function' ? handler : null;
    }

    setOnStatusChange(handler) {
      this.onStatusChange = typeof handler === 'function' ? handler : null;
    }

    setStatusProvider(provider) {
      this.statusProvider = provider || null;
    }

    setStatusChangeListener(listener) {
      this.statusChangeListener = typeof listener === 'function' ? listener : null;
    }

    notifyStatusChange() {
      if (this.statusChangeListener) {
        this.statusChangeListener();
      }
      if (this.onStatusChange) {
        this.onStatusChange();
      }
    }

    isExternalHistory() {
      return this.historySource === 'all' || this.historySource === 'claude' || this.historySource === 'codex';
    }

    normalizeDisplayStatus(value) {
      const raw = String(value || '').trim().toLowerCase();
      if (raw === 'needs_permission') return SESSION_STATUS_WAITING_USER;
      if (
        raw === SESSION_STATUS_WORKING
        || raw === SESSION_STATUS_WAITING_USER
        || raw === SESSION_STATUS_COMPLETED
      ) {
        return raw;
      }
      return '';
    }

    computeEffectiveStatus(baseStatus, paneId, source) {
      const status = this.normalizeDisplayStatus(baseStatus);
      if (!status) return '';
      if (status !== SESSION_STATUS_WORKING) return status;
      if (String(source || '').trim().toLowerCase() !== 'codex') {
        return status;
      }
      const pid = String(paneId || '').trim();
      if (!pid) return status;
      const paneState = this.panes.get(pid);
      if (paneState?.outputIdle) {
        return SESSION_STATUS_WAITING_USER;
      }
      return status;
    }

    getSessionStatus({ sessionId, source } = {}) {
      const sid = String(sessionId || '').trim();
      const src = String(source || '').trim().toLowerCase();
      if (!sid || !src) return null;
      const entry = this.statusProvider?.getStatus?.({ sessionId: sid, source: src }) || null;
      if (!entry) return null;
      const paneId = String(entry.pane_id || '').trim();
      const status = this.computeEffectiveStatus(entry.status, paneId, entry.source);
      const hasBinding = Boolean(paneId);
      return { ...entry, pane_id: paneId, status, stalled: false, display: Boolean(status && hasBinding) };
    }

    getPaneStatusByPaneId(paneId) {
      const pid = String(paneId || '').trim();
      if (!pid) return null;
      const entries = this.statusProvider?.entries;
      if (!entries || typeof entries.forEach !== 'function') return null;
      let best = null;
      entries.forEach((entry) => {
        if (!entry || typeof entry !== 'object') return;
        const boundPane = String(entry.pane_id || '').trim();
        if (boundPane !== pid) return;
        if (!best) {
          best = entry;
          return;
        }
        const bestAt = Number(best.updated_at) || 0;
        const nextAt = Number(entry.updated_at) || 0;
        if (nextAt >= bestAt) {
          best = entry;
        }
      });
      if (!best) return null;
      const status = this.computeEffectiveStatus(best.status, pid, best.source);
      if (!status) return null;
      return { ...best, pane_id: pid, status, stalled: false, display: true };
    }

    getBoundSessionKeySet() {
      const bound = new Set();
      const entries = this.statusProvider?.entries;
      if (!entries || typeof entries.forEach !== 'function') return bound;
      entries.forEach((entry) => {
        if (!entry || typeof entry !== 'object') return;
        const key = String(entry.session_key || '').trim();
        const paneId = String(entry.pane_id || '').trim();
        if (key && paneId) {
          bound.add(key);
        }
      });
      return bound;
    }

    getDebugSnapshot() {
      let sessionCount = 0;
      let bindingCount = 0;
      let paneBindingCount = 0;
      const statusEntries = this.statusProvider?.entries;
      if (statusEntries && typeof statusEntries.forEach === 'function') {
        sessionCount = Number(statusEntries.size) || 0;
        const paneIds = new Set();
        statusEntries.forEach((entry) => {
          const paneId = String(entry?.pane_id || '').trim();
          if (!paneId) return;
          bindingCount += 1;
          paneIds.add(paneId);
        });
        paneBindingCount = paneIds.size;
      }
      return {
        active_pane_id: this.activePaneId || '',
        pane_count: this.panes.size,
        binding_count: bindingCount,
        pane_binding_count: paneBindingCount,
        session_count: sessionCount,
        pending_codex: 0,
        cwd_count: this.debugInfo.cwdCount,
        last_cwd: this.debugInfo.lastCwd,
        last_notify: this.debugInfo.lastNotify,
        last_command: this.debugInfo.lastCommand,
        last_shell: this.debugInfo.lastShell,
        last_profile: this.debugInfo.lastProfile,
        osc_count: this.debugInfo.oscCount,
        osc_kawaii_count: this.debugInfo.oscKawaiiCount,
        last_osc: this.debugInfo.lastOsc,
        last_kawaii_osc: this.debugInfo.lastKawaiiOsc,
      };
    }

    ensurePaneState(paneId) {
      if (!this.panes.has(paneId)) {
        this.panes.set(paneId, {
          pendingQueue: [],
          liveBlock: null,
          bufferedOutput: '',
          lastOutputAt: 0,
          lastActivityAt: 0,
          idleTimer: null,
          outputIdle: false,
          outputIdleTimer: null,
          outputRunning: false,
          outputBaseline: null,
          lastBaseY: 0,
          lastLength: 0,
          paneLabel: '',
          altBuffer: false,
          terminalManager: null,
          cursorEditCount: 0,
          meaningfulCount: 0,
          likelyTui: false,
          lastCommandText: '',
          lastCommandAt: 0,
          lastCodexCommand: '',
          lastCodexCommandAt: 0,
          cwdEventCount: 0,
          cwd: '',
          sessionTag: '',
          sessionLabel: '',
        });
      }
      return this.panes.get(paneId);
    }

    setActiveTab(tabId) {
      this.activeTabId = tabId;
    }

    setActiveTabLabel(label) {
      if (label) {
        this.activeTabLabel = label;
      }
    }

    setActivePane(paneId, pane) {
      this.activePaneId = paneId;
      this.activePane = pane || null;
      if (paneId) {
        const state = this.ensurePaneState(paneId);
        if (pane?.titleEl?.textContent) {
          state.paneLabel = pane.titleEl.textContent;
        }
        state.sessionTag = this.activeTabId || this.sessionId;
        state.sessionLabel = this.activeTabLabel || this.activeTabId || this.sessionId;
      }
    }

    updatePaneLabel(paneId, label) {
      if (!paneId || !label) return;
      const state = this.ensurePaneState(paneId);
      state.paneLabel = label;
      const block = state.liveBlock;
      if (block && !block.pane_label) {
        block.pane_label = label;
      }
    }

    onCwdChange(paneId, cwd) {
      if (!paneId) return;
      this.debugInfo.cwdCount += 1;
      if (typeof cwd === 'string' && cwd.trim()) {
        this.debugInfo.lastCwd = cwd.trim();
      }
      const next = typeof cwd === 'string' ? cwd.trim() : '';
      if (!next) return;
      const state = this.ensurePaneState(paneId);
      if (state.cwd === next) return;
      state.cwd = next;
      state.cwdEventCount = Number(state.cwdEventCount || 0) + 1;
      if (this.onRender) {
        this.onRender();
      }
    }

    getPaneCwd(paneId) {
      const pid = String(paneId || '').trim();
      if (!pid) return '';
      const state = this.panes.get(pid);
      return typeof state?.cwd === 'string' ? state.cwd : '';
    }

    getBoundSessionEntries() {
      const entries = this.statusProvider?.entries;
      if (!entries || typeof entries.forEach !== 'function') return [];
      const result = [];
      entries.forEach((entry) => {
        if (!entry || typeof entry !== 'object') return;
        const sessionKey = String(entry.session_key || '').trim();
        const paneId = String(entry.pane_id || '').trim();
        if (!sessionKey || !paneId) return;
        result.push(entry);
      });
      return result;
    }

    setPaneOutputIdle(paneId, idle) {
      if (!paneId) return;
      const state = this.ensurePaneState(paneId);
      const next = Boolean(idle);
      if (state.outputIdle === next) return;
      state.outputIdle = next;
      if (this.onRender) {
        this.onRender();
      }
      this.notifyStatusChange();
    }

    markPaneOutputActive(paneId, state) {
      if (!paneId || !state) return;
      state.outputRunning = true;
      if (state.outputIdle) {
        this.setPaneOutputIdle(paneId, false);
      }
      if (state.outputIdleTimer) {
        clearTimeout(state.outputIdleTimer);
        state.outputIdleTimer = null;
      }
      state.outputIdleTimer = setTimeout(() => {
        state.outputIdleTimer = null;
        state.outputRunning = false;
        const shouldIdle = hasNetOutputChange(state.outputBaseline);
        state.outputBaseline = null;
        if (shouldIdle) {
          this.setPaneOutputIdle(paneId, true);
        }
      }, OUTPUT_IDLE_MS);
    }

    resetIdleTimer(paneId) {
      const state = this.ensurePaneState(paneId);
      if (state.idleTimer) {
        clearTimeout(state.idleTimer);
      }
      state.idleTimer = setTimeout(() => {
        state.idleTimer = null;
        const now = Date.now();
        if (!state.liveBlock) return;
        if (now - state.lastOutputAt < IDLE_MS) return;
        this.snapshotLiveBlock(paneId);
      }, IDLE_MS);
    }

    createLiveBlock(paneId, input, now, isTui, paneLabel) {
      this.blockCounter += 1;
      return {
        id: `b-${paneId}-${now}-${this.blockCounter}`,
        session_id: this.panes.get(paneId)?.sessionTag || this.sessionId,
        session_label: this.panes.get(paneId)?.sessionLabel || this.activeTabLabel || this.sessionId,
        pane_id: paneId,
        pane_label: paneLabel || '',
        inputs: input ? [input] : [],
        input: input || '',
        output_raw: '',
        output_text: '',
        output_head: '',
        output_tail: '',
        created_at: now,
        last_output_at: now,
        has_output: false,
        is_tui: Boolean(isTui),
        marker: null,
      };
    }

    commitLiveBlock(paneId, options = {}) {
      const state = this.ensurePaneState(paneId);
      const block = state.liveBlock;
      state.liveBlock = null;

      if (!block || !block.has_output) {
        return;
      }

      let outputText = '';
      if (block.snapshot_text) {
        outputText = block.snapshot_text;
      } else if (state.terminalManager?.terminal) {
        outputText = captureOutputFromMarker(
          state.terminalManager.terminal,
          block.marker,
          options?.endMarker || null,
          this.store
        );
      }
      if (!String(outputText || '').trim() && state.terminalManager?.getScreenContent) {
        const snapshot = state.terminalManager.getScreenContent({ maxLines: 200, maxChars: 100000 });
        outputText = this.store?.normalizeOutputText ? this.store.normalizeOutputText(snapshot) : String(snapshot || '');
      }
      block.output_text = outputText;
      const clamp = this.store?.clampText;
      block.output_head = clamp ? clamp(outputText, OUTPUT_HEAD_CHARS) : String(outputText || '').slice(0, OUTPUT_HEAD_CHARS);
      block.output_tail = outputText.length > OUTPUT_TAIL_CHARS ? outputText.slice(-OUTPUT_TAIL_CHARS) : outputText;
      if (block.snapshot_text) {
        delete block.snapshot_text;
      }
      if (!block.pane_label) {
        block.pane_label = state.paneLabel || '';
      }

      this.blocks.unshift(block);
      this.blockMap.set(block.id, block);
      void this.persistBlock(block);
    }

    snapshotLiveBlock(paneId) {
      const state = this.ensurePaneState(paneId);
      const block = state.liveBlock;
      if (!block || block.snapshot_text) return;
      let outputText = '';
      if (state.terminalManager?.terminal) {
        outputText = captureOutputFromMarker(state.terminalManager.terminal, block.marker, null, this.store);
      }
      if (!String(outputText || '').trim() && state.terminalManager?.getScreenContent) {
        const snapshot = state.terminalManager.getScreenContent({ maxLines: 200, maxChars: 100000 });
        outputText = this.store?.normalizeOutputText ? this.store.normalizeOutputText(snapshot) : String(snapshot || '');
      }
      if (String(outputText || '').trim()) {
        block.snapshot_text = outputText;
      }
    }

    handlePaneClose(paneId) {
      if (!paneId) return;
      const state = this.panes.get(paneId);
      if (!state) return;
      if (state.idleTimer) {
        clearTimeout(state.idleTimer);
        state.idleTimer = null;
      }
      if (state.outputIdleTimer) {
        clearTimeout(state.outputIdleTimer);
        state.outputIdleTimer = null;
      }
      if (state.liveBlock && state.liveBlock.has_output) {
        this.commitLiveBlock(paneId);
      }
      this.panes.delete(paneId);
    }

    handleTabClose(tabId, paneIds) {
      if (Array.isArray(paneIds)) {
        for (const paneId of paneIds) {
          if (paneId && String(paneId).includes(tabId)) {
            this.handlePaneClose(paneId);
          }
        }
      }
      if (this.activeTabId === tabId) {
        this.activeTabId = null;
      }
    }

    async persistBlock(block) {
      if (!block || !window.historyAPI?.appendBlock) return;
      try {
        await window.historyAPI.appendBlock(block);
      } catch (_) {
        // ignore
      }
    }

    getBlockById(blockId) {
      if (!blockId) return null;
      return this.blockMap.get(blockId) || null;
    }

    onCommandSubmit(paneId, command, pane, terminalManager) {
      const input = String(command || '').trim();
      if (!input) return;
      this.debugInfo.lastCommand = {
        pane_id: String(paneId || '').trim(),
        command: input,
        timestamp: Date.now(),
        source: 'submit',
      };
      const state = this.ensurePaneState(paneId);
      const now = Date.now();
      if (terminalManager) {
        state.terminalManager = terminalManager;
      }
      const terminal = terminalManager?.terminal;
      if (terminal) {
        state.altBuffer = isAltBuffer(terminal);
      }

      if (pane?.titleEl?.textContent) {
        state.paneLabel = pane.titleEl.textContent;
      }
      state.sessionTag = this.activeTabId || this.sessionId;
      state.sessionLabel = this.activeTabLabel || this.activeTabId || this.sessionId;
      this.setPaneOutputIdle(paneId, false);
      if (state.outputIdleTimer) {
        clearTimeout(state.outputIdleTimer);
        state.outputIdleTimer = null;
      }
      state.outputRunning = false;
      state.outputBaseline = null;

      if (this.isExternalHistory()) {
        return;
      }

      const shouldCommitPrev = (() => {
        if (!state.liveBlock) return false;
        const lastActivityAt = state.lastActivityAt || state.lastOutputAt || 0;
        const idle = now - lastActivityAt >= IDLE_MS;
        return idle && !state.likelyTui;
      })();

      if (state.liveBlock) {
        if (!shouldCommitPrev) {
          // 追撃入力: 出力中(またはTUIと推定)の入力は同一ブロックにまとめる
          if (this.store?.appendBlockInput) {
            this.store.appendBlockInput(state.liveBlock, input);
          }
          if (this.isPanelActive?.()) {
            this.onRender?.();
          }
          return;
        }
      }

      let marker = null;
      const shouldRegisterMarker = state.pendingQueue.length === 0;
      if (shouldRegisterMarker && terminal?.registerMarker) {
        try {
          marker = terminal.registerMarker();
        } catch (_) {
          marker = null;
        }
      }
      if (shouldCommitPrev) {
        this.commitLiveBlock(paneId, { endMarker: marker });
      }
      state.pendingQueue.push({ input, ts: now, marker });

      if (this.isPanelActive?.()) {
        this.onRender?.();
      }
    }

    onCommandExecuted(paneId, command, meta, pane, terminalManager) {
      const input = String(command || '').trim();
      if (!input) return;
      const now = Date.now();
      const state = this.ensurePaneState(paneId);
      state.lastCommandText = input;
      state.lastCommandAt = now;
      if (terminalManager) {
        state.terminalManager = terminalManager;
      }
      if (pane?.titleEl?.textContent) {
        state.paneLabel = pane.titleEl.textContent;
      }
      this.debugInfo.lastCommand = {
        pane_id: String(paneId || '').trim(),
        command: input,
        timestamp: now,
        source: meta?.source || 'osc',
      };
    }

    onShellInfo(paneId, info, meta, pane, terminalManager) {
      const text = String(info || '').trim();
      if (!text) return;
      const now = Date.now();
      if (terminalManager) {
        const state = this.ensurePaneState(paneId);
        state.terminalManager = terminalManager;
      }
      if (pane?.titleEl?.textContent) {
        const state = this.ensurePaneState(paneId);
        state.paneLabel = pane.titleEl.textContent;
      }
      this.debugInfo.lastShell = {
        pane_id: String(paneId || '').trim(),
        info: text,
        timestamp: now,
        source: meta?.source || 'osc',
      };
    }

    onProfileUpdate(paneId, profileId, pane, terminalManager) {
      const pid = String(paneId || '').trim();
      const value = String(profileId || '').trim();
      if (!pid && !value) return;
      const now = Date.now();
      if (terminalManager) {
        const state = this.ensurePaneState(paneId);
        state.terminalManager = terminalManager;
      }
      if (pane?.titleEl?.textContent) {
        const state = this.ensurePaneState(paneId);
        state.paneLabel = pane.titleEl.textContent;
      }
      this.debugInfo.lastProfile = {
        pane_id: pid,
        profile_id: value,
        timestamp: now,
      };
    }

    onOsc(paneId, osc, pane, terminalManager) {
      const text = String(osc || '').trim();
      if (!text) return;
      if (terminalManager) {
        const state = this.ensurePaneState(paneId);
        state.terminalManager = terminalManager;
      }
      if (pane?.titleEl?.textContent) {
        const state = this.ensurePaneState(paneId);
        state.paneLabel = pane.titleEl.textContent;
      }
      this.debugInfo.oscCount += 1;
      if (text.startsWith('1337;Kawaii')) {
        this.debugInfo.oscKawaiiCount += 1;
        this.debugInfo.lastKawaiiOsc = text.slice(0, 200);
      }
      this.debugInfo.lastOsc = text.slice(0, 200);
    }

    onOutput(paneId, data, terminal, terminalManager) {
      if (!data) return;
      const state = this.ensurePaneState(paneId);
      const now = Date.now();
      state.altBuffer = isAltBuffer(terminal);
      if (terminalManager) {
        state.terminalManager = terminalManager;
      }
      const { meaningful, cursorEdit } = classifyOutput(data, terminal, state);
      const isUserTyping = Boolean(state.terminalManager?.currentInput);
      if (meaningful || (!isUserTyping && cursorEdit)) {
        state.lastActivityAt = now;
      }

      state.lastOutputAt = now;
      this.resetIdleTimer(paneId);
      const shouldCountIdle = shouldCountOutputForIdle(terminalManager, state, data);
      if (shouldCountIdle) {
        this.markPaneOutputActive(paneId, state);
      }

      if (this.isExternalHistory()) return;

      if (!state.liveBlock) {
        if (state.pendingQueue.length === 0) {
          state.bufferedOutput = '';
          return;
        }
        const pending = state.pendingQueue.shift();
        state.lastActivityAt = now;
        state.liveBlock = this.createLiveBlock(paneId, pending?.input || '', now, false, state.paneLabel);
        state.liveBlock.marker = pending?.marker || null;
        state.liveBlock.has_output = true;
        state.liveBlock.last_output_at = now;
        state.bufferedOutput = '';
        state.cursorEditCount = 0;
        state.meaningfulCount = 0;
        state.likelyTui = false;

        // 出力開始までに複数Enterが来ていた場合は、追撃入力として同一ブロックにまとめる
        while (state.pendingQueue.length > 0) {
          const extra = state.pendingQueue.shift();
          if (extra?.input && this.store?.appendBlockInput) {
            this.store.appendBlockInput(state.liveBlock, extra.input);
          }
        }
      } else {
        state.liveBlock.has_output = true;
        state.liveBlock.last_output_at = now;
      }

      if (state.altBuffer) {
        if (cursorEdit) state.cursorEditCount += 1;
        if (meaningful) state.meaningfulCount += 1;
        state.likelyTui = state.cursorEditCount >= 200 && state.meaningfulCount <= 1;
      } else {
        state.cursorEditCount = 0;
        state.meaningfulCount = 0;
        state.likelyTui = false;
      }

      if (state.liveBlock && state.likelyTui) {
        state.liveBlock.is_tui = true;
      }

      if (this.isPanelActive?.()) {
        this.onRender?.();
      }
    }
  }

  window.HistorySessionTracker = HistorySessionTracker;
})();
