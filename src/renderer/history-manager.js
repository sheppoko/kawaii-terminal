(function () {
  'use strict';

  const HISTORY_SOURCE = 'all';
  const SESSION_LIST_LIMIT = 5000;
  const HISTORY_TOAST_DURATION_MS = 3000;

  function logHistoryDebug(payload) {
    if (window.debugAPI?.logHistory) {
      window.debugAPI.logHistory(payload);
    }
  }

  class HistoryManager {
    constructor(options = {}) {
      this.sessionId = options.sessionId || 'session';
      this.historySource = String(options.historySource || HISTORY_SOURCE).trim().toLowerCase() || HISTORY_SOURCE;
      this.deferInitialLoad = Boolean(options.deferInitialLoad);
      this.HISTORY_TOAST_DURATION_MS = HISTORY_TOAST_DURATION_MS;
      this.SESSION_LIST_LIMIT = SESSION_LIST_LIMIT;
      this.logHistoryDebug = logHistoryDebug;

      this.historyProvider = null;
      this.statusProvider = null;
      this.statusChangeListener = null;
      this.summaryProvider = null;
      this.sessionDeltaListener = null;

      this.timeMachineHandler = null;
      this.timeMachineBusy = false;
      this.forkHandler = null;
      this.resumeHandler = null;

      this.sidebarDirty = true;
      this.renderPending = false;
      this.renderQueued = false;
      this.historyReloadTimer = null;
      this.sessionTimeInterval = null;
      this.lastInteractionAt = 0;
      this.interactionHoldMs = 700;
      this.loadingSessions = false;
      this.hasMoreSessions = true;

      this.store = window.HistoryStore
        ? new window.HistoryStore({
          historySource: this.historySource,
          sessionLoadLimit: SESSION_LIST_LIMIT,
        })
        : null;

      this.tracker = window.HistorySessionTracker
        ? new window.HistorySessionTracker({
          sessionId: this.sessionId,
          historySource: this.historySource,
          store: this.store,
          onRender: () => {
            this.sidebarDirty = true;
            this.scheduleRender();
          },
          isPanelActive: () => this.isPanelActive(),
        })
        : null;

      this.sidebarUI = window.HistorySidebarUI
        ? new window.HistorySidebarUI({
          store: this.store,
          tracker: this.tracker,
          historySource: this.historySource,
          onResume: (payload) => this.executeResume(payload),
          onTimeMachine: (block) => this.triggerTimeMachine(block),
          listId: 'session-group-list',
          countId: 'session-sidebar-count',
          displayScope: 'history',
        })
        : null;

      this.activeSidebarUI = window.HistorySidebarUI
        ? new window.HistorySidebarUI({
          store: this.store,
          tracker: this.tracker,
          historySource: this.historySource,
          onResume: (payload) => this.executeResume(payload),
          onTimeMachine: (block) => this.triggerTimeMachine(block),
          listId: 'active-session-group-list',
          countId: 'active-session-sidebar-count',
          displayScope: 'active',
        })
        : null;

      this.searchUI = window.HistorySearchUI
        ? new window.HistorySearchUI({
          store: this.store,
          tracker: this.tracker,
          historySource: this.historySource,
          onTimeMachine: (block, options) => this.triggerTimeMachine(block, options),
        })
        : null;

      if (this.store) {
        this.store.applySessionCache(this.historySource);
        this.sessions = this.store.sessions;
        this.sessionMap = this.store.sessionMap;
        this.loadingSessions = this.store.loadingSessions;
        this.hasMoreSessions = this.store.hasMoreSessions;
      } else {
        this.sessions = [];
        this.sessionMap = new Map();
      }

      this.sidebarUI?.init?.();
      this.activeSidebarUI?.init?.();
      this.searchUI?.init?.();
      this.startSessionTimeTicker();

      logHistoryDebug({ enable: true });
      logHistoryDebug({ type: 'init', source: this.historySource });

      if (!this.deferInitialLoad) {
        this.loadSessionSummaries();
      }
    }

    isExternalHistory() {
      return this.historySource === 'all' || this.historySource === 'claude' || this.historySource === 'codex';
    }

    isPanelActive() {
      return !document.hidden;
    }

    setHistorySource(source) {
      if (!this.store || !this.tracker) return;
      const next = this.store.getSourceKey(source || HISTORY_SOURCE);
      if (next === this.historySource) return;
      this.historySource = next;
      this.store.setHistorySource(next);
      this.tracker.setHistorySource(next);
      this.sidebarUI?.setHistorySource?.(next);
      this.activeSidebarUI?.setHistorySource?.(next);
      this.searchUI?.setHistorySource?.(next);
      this.store.applySessionCache(next);
      this.sessions = this.store.sessions;
      this.sessionMap = this.store.sessionMap;
      this.loadingSessions = this.store.loadingSessions;
      this.hasMoreSessions = this.store.hasMoreSessions;
      this.sidebarDirty = true;
      this.scheduleRender();
      if (!this.deferInitialLoad) {
        this.loadSessionSummaries();
      }
    }

    setHistoryProvider(provider) {
      this.historyProvider = provider || null;
    }

    setStatusProvider(provider) {
      this.statusProvider = provider || null;
      this.tracker?.setStatusProvider?.(provider || null);
    }

    setSummaryProvider(provider) {
      this.summaryProvider = provider || null;
      this.sidebarUI?.setSummaryProvider?.(provider || null);
      this.activeSidebarUI?.setSummaryProvider?.(provider || null);
    }

    setSessionDeltaListener(listener) {
      this.sessionDeltaListener = typeof listener === 'function' ? listener : null;
    }

    setStatusChangeListener(listener) {
      this.statusChangeListener = typeof listener === 'function' ? listener : null;
      this.tracker?.setStatusChangeListener?.(this.statusChangeListener);
    }

    notifyStatusChange() {
      if (this.statusChangeListener) {
        this.statusChangeListener();
      }
    }

    setTimeMachineHandler(handler) {
      this.timeMachineHandler = typeof handler === 'function' ? handler : null;
      this.sidebarUI?.setHandlers?.({ onTimeMachine: (block) => this.triggerTimeMachine(block) });
      this.activeSidebarUI?.setHandlers?.({ onTimeMachine: (block) => this.triggerTimeMachine(block) });
      this.searchUI?.setHandlers?.({ onTimeMachine: (block, options) => this.triggerTimeMachine(block, options) });
    }

    setForkHandler(handler) {
      this.forkHandler = typeof handler === 'function' ? handler : null;
    }

    setResumeHandler(handler) {
      this.resumeHandler = typeof handler === 'function' ? handler : null;
      this.sidebarUI?.setHandlers?.({ onResume: (payload) => this.executeResume(payload) });
      this.activeSidebarUI?.setHandlers?.({ onResume: (payload) => this.executeResume(payload) });
    }

    getSessionStatus(payload) {
      return this.tracker?.getSessionStatus?.(payload) || null;
    }

    getPaneStatusByPaneId(paneId) {
      return this.tracker?.getPaneStatusByPaneId?.(paneId) || null;
    }

    getDebugSnapshot() {
      return this.tracker?.getDebugSnapshot?.() || null;
    }

    updateSidebarAgo() {
      window.HistoryManagerUI?.updateSidebarAgo?.(this);
    }

    startSessionTimeTicker() {
      window.HistoryManagerUI?.startSessionTimeTicker?.(this);
    }

    scheduleRender() {
      window.HistoryManagerUI?.scheduleRender?.(this);
    }

    renderSidebar() {
      window.HistoryManagerUI?.renderSidebar?.(this);
    }

    scheduleHistoryReload(delayMs = 800) {
      window.HistoryManagerSync?.scheduleHistoryReload?.(this, delayMs);
    }

    sendHistoryAck(source, pending) {
      window.HistoryManagerSync?.sendHistoryAck?.(this, source, pending);
    }

    applyHistoryDeltaPayload(payload, { forceImmediate = false } = {}) {
      window.HistoryManagerSync?.applyHistoryDeltaPayload?.(this, payload, { forceImmediate });
    }

    handleHistoryDelta(payload) {
      window.HistoryManagerSync?.handleHistoryDelta?.(this, payload);
    }

    handleHistoryInvalidate(payload) {
      window.HistoryManagerSync?.handleHistoryInvalidate?.(this, payload);
    }

    async loadSessionSummaries({ sourceKey, force = false } = {}) {
      return window.HistoryManagerSync?.loadSessionSummaries?.(this, { sourceKey, force });
    }

    refreshSearchPane() {
      this.searchUI?.refreshSearchPane?.();
    }

    focusSearchPane(options = {}) {
      this.searchUI?.focusSearchPane?.(options || {});
    }

    setActiveTab(tabId) {
      this.tracker?.setActiveTab?.(tabId);
    }

    setActiveTabLabel(label) {
      this.tracker?.setActiveTabLabel?.(label);
    }

    setActivePane(paneId, pane) {
      this.tracker?.setActivePane?.(paneId, pane);
      if (this.isExternalHistory()) {
        void this.loadSessionSummaries();
      }
      if (this.isPanelActive()) {
        this.sidebarDirty = true;
        this.scheduleRender();
      }
    }

    updatePaneLabel(paneId, label) {
      this.tracker?.updatePaneLabel?.(paneId, label);
      if (this.isPanelActive()) {
        this.sidebarDirty = true;
        this.scheduleRender();
      }
    }

    onCwdChange(paneId, cwd) {
      this.tracker?.onCwdChange?.(paneId, cwd);
    }

    onCommandSubmit(paneId, command, pane, terminalManager) {
      this.tracker?.onCommandSubmit?.(paneId, command, pane, terminalManager);
    }

    onCommandExecuted(paneId, command, meta, pane, terminalManager) {
      this.tracker?.onCommandExecuted?.(paneId, command, meta, pane, terminalManager);
    }

    onShellInfo(paneId, info, meta, pane, terminalManager) {
      this.tracker?.onShellInfo?.(paneId, info, meta, pane, terminalManager);
    }

    onProfileUpdate(paneId, profileId, pane, terminalManager) {
      this.tracker?.onProfileUpdate?.(paneId, profileId, pane, terminalManager);
    }

    onOsc(paneId, osc, pane, terminalManager) {
      this.tracker?.onOsc?.(paneId, osc, pane, terminalManager);
    }

    onOutput(paneId, data, terminal, terminalManager) {
      this.tracker?.onOutput?.(paneId, data, terminal, terminalManager);
    }

    handlePaneClose(paneId) {
      this.tracker?.handlePaneClose?.(paneId);
    }

    handleTabClose(tabId, paneIds) {
      this.tracker?.handleTabClose?.(tabId, paneIds);
    }

    getBlockById(blockId) {
      return this.tracker?.getBlockById?.(blockId) || null;
    }

    buildTimeMachineBlock(block) {
      if (!block || typeof block !== 'object') return null;
      return {
        source: block.source,
        session_id: block.session_id,
        source_id: block.source_id || block.uuid || block.block_id || block.id,
        input: block.input,
        inputs: Array.isArray(block.inputs) ? block.inputs.slice(0, 2) : undefined,
        created_at: block.created_at,
        pane_id: block.pane_id,
        cwd: block.cwd,
        wsl_distro: block.wsl_distro,
        source_path: block.source_path,
      };
    }

    async triggerTimeMachine(block, { buttonEl, fromEl } = {}) {
      if (this.timeMachineBusy) return;
      if (!block) {
        this.showHistoryToast('Time Machine unavailable', { tone: 'error' });
        return;
      }
      if (typeof this.timeMachineHandler !== 'function') {
        this.showHistoryToast('Time Machine unavailable', { tone: 'error' });
        return;
      }
      this.timeMachineBusy = true;
      if (buttonEl?.classList) {
        buttonEl.classList.add('loading');
      }
      try {
        const payload = this.buildTimeMachineBlock(block) || block;
        await this.timeMachineHandler(payload, { fromEl });
      } catch (e) {
        console.error('[HistoryManager] Time Machine failed:', e);
        this.showHistoryToast('Time Machine failed', { tone: 'error' });
      } finally {
        this.timeMachineBusy = false;
        if (buttonEl?.classList) {
          buttonEl.classList.remove('loading');
        }
      }
    }

    triggerSessionItemGlint(sessionId) {
      this.sidebarUI?.triggerSessionItemGlint?.(sessionId);
      this.activeSidebarUI?.triggerSessionItemGlint?.(sessionId);
    }

    async executeResume({ sessionId, source, cwd, wslDistro, fromEl }) {
      if (!sessionId || !source) return;
      if (typeof this.resumeHandler !== 'function') return;
      try {
        this.triggerSessionItemGlint(sessionId);
        await this.resumeHandler({ sessionId, source, cwd, wslDistro, fromEl });
      } catch (e) {
        console.error('[HistoryManager] Resume failed:', e);
      }
    }

    async executeFork({ sessionId, source, cwd, wslDistro, fromEl }) {
      if (!sessionId || !source) {
        this.showHistoryToast('Fork unavailable');
        return;
      }
      if (typeof this.forkHandler !== 'function') {
        this.showHistoryToast('Fork unavailable');
        return;
      }
      try {
        await this.forkHandler({ sessionId, source, cwd, wslDistro, fromEl });
      } catch (e) {
        console.error('[HistoryManager] Fork failed:', e);
        this.showHistoryToast('Fork failed');
      }
    }

    showHistoryToast(message, { tone } = {}) {
      window.HistoryManagerUI?.showHistoryToast?.(this, message, { tone });
    }
  }

  window.HistoryManager = HistoryManager;
})();
