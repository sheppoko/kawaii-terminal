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
      if (!this.store || document.hidden) return;
      const updateContainer = (root) => {
        if (!root) return;
        const items = root.querySelectorAll('.session-item');
        if (!items.length) return;
        items.forEach((item) => {
          const ts = Number(item.dataset.timestamp || '');
          if (!Number.isFinite(ts)) return;
          const agoEl = item.querySelector('.session-item-ago')
            || item.querySelector('.session-item-toggle-ago');
          if (!agoEl) return;
          const next = this.store.formatAgo(ts);
          if (agoEl.textContent !== next) {
            agoEl.textContent = next;
          }
        });
      };
      updateContainer(document.getElementById('session-group-list'));
      updateContainer(document.getElementById('active-session-group-list'));
      updateContainer(this.searchUI?.getListElement?.());
    }

    startSessionTimeTicker() {
      if (this.sessionTimeInterval) return;
      this.sessionTimeInterval = setInterval(() => {
        this.updateSidebarAgo();
      }, 60000);
    }

    scheduleRender() {
      if (this.renderPending) {
        this.renderQueued = true;
        return;
      }
      if (!this.sidebarDirty) return;
      this.renderPending = true;
      requestAnimationFrame(() => {
        this.renderPending = false;
        if (this.sidebarDirty) this.renderSidebar();
        if (this.renderQueued) {
          this.renderQueued = false;
          this.scheduleRender();
        }
      });
    }

    renderSidebar() {
      if (!this.sidebarUI && !this.activeSidebarUI) return;
      this.sidebarDirty = false;
      this.sidebarUI?.renderSidebar?.({ loadingSessions: this.loadingSessions });
      this.activeSidebarUI?.renderSidebar?.({ loadingSessions: this.loadingSessions });
    }

    scheduleHistoryReload(delayMs = 800) {
      if (!this.isExternalHistory() || !this.store) return;
      if (this.historyReloadTimer) {
        clearTimeout(this.historyReloadTimer);
      }
      this.historyReloadTimer = setTimeout(() => {
        this.historyReloadTimer = null;
        const key = this.store.getSourceKey(this.historySource);
        const cache = this.store.getSessionCache(key);
        const since = Date.now() - (this.lastInteractionAt || 0);
        if (since < this.interactionHoldMs) {
          this.scheduleHistoryReload(Math.max(200, Number(delayMs) || 800));
          return;
        }
        if (!Array.isArray(cache.pendingDeltas) || cache.pendingDeltas.length === 0) {
          return;
        }
        const changed = this.store.flushPendingSessionChanges({ sourceKey: key });
        if (!changed) return;
        this.store.applySessionCache(key);
        this.sessions = this.store.sessions;
        this.sessionMap = this.store.sessionMap;
        this.hasMoreSessions = cache.hasMore;
        this.sidebarDirty = true;
        this.scheduleRender();
      }, Math.max(50, Number(delayMs) || 800));
    }

    applyHistoryDeltaPayload(payload, { forceImmediate = false } = {}) {
      if (!payload || !this.store) return;
      const source = this.store.getSourceKey(payload?.source || this.historySource);
      const cache = this.store.getSessionCache(source);
      const generatedAt = Number(payload?.generated_at) || 0;
      const changeSet = {
        added: payload?.added || [],
        updated: payload?.updated || [],
        removed: payload?.removed || [],
        generated_at: generatedAt,
      };
      if (payload?.meta?.signature) {
        cache.lastSignature = payload.meta.signature;
      }
      if (typeof payload?.has_more === 'boolean') {
        cache.hasMore = payload.has_more;
      }
      if (Number.isFinite(payload?.next_cursor)) {
        cache.cursor = payload.next_cursor;
      }
      const hasChanges = Boolean(changeSet.added.length || changeSet.updated.length || changeSet.removed.length);
      if (!hasChanges) return;

      const isCurrent = source === this.store.getSourceKey(this.historySource);
      const shouldDefer = !forceImmediate
        && (!this.isPanelActive()
          || (this.isPanelActive() && (Date.now() - (this.lastInteractionAt || 0)) < this.interactionHoldMs));

      logHistoryDebug({
        type: 'delta',
        source,
        phase: payload?.phase || '',
        added: changeSet.added.length,
        updated: changeSet.updated.length,
        removed: changeSet.removed.length,
        forceImmediate,
        shouldDefer,
        isCurrent,
      });

      if (!cache.snapshotReady && !cache.loading) {
        void this.loadSessionSummaries({ sourceKey: source, force: true });
      }

      if (shouldDefer) {
        this.store.queueSessionChanges(cache, changeSet);
        if (isCurrent) {
          this.scheduleHistoryReload();
        }
        return;
      }

      const changed = this.store.applySessionChanges(cache, changeSet, source);
      if (!changed) return;
      if (!cache.snapshotReady) cache.snapshotReady = true;
      if (isCurrent) {
        this.store.applySessionCache(source);
        this.sessions = this.store.sessions;
        this.sessionMap = this.store.sessionMap;
        this.hasMoreSessions = cache.hasMore;
        this.sidebarDirty = true;
        this.scheduleRender();
      }
    }

    handleHistoryDelta(payload) {
      if (!payload) return;
      const isBootstrap = payload?.phase === 'bootstrap';
      this.applyHistoryDeltaPayload(payload, { forceImmediate: isBootstrap });
      if (this.sessionDeltaListener) {
        this.sessionDeltaListener(payload);
      }
    }

    handleHistoryInvalidate(payload) {
      if (!this.store) return;
      const source = this.store.getSourceKey(payload?.source || this.historySource);
      const cache = this.store.getSessionCache(source);
      cache.pendingDeltas = [];
      cache.snapshotReady = false;
      void this.loadSessionSummaries({ sourceKey: source, force: true });
      if (this.sessionDeltaListener) {
        this.sessionDeltaListener({ type: 'invalidate', payload });
      }
    }

    async loadSessionSummaries({ sourceKey, force = false } = {}) {
      if (!this.historyProvider?.getSnapshot || !this.store) return;
      const key = this.store.getSourceKey(sourceKey || this.historySource);
      const cache = this.store.getSessionCache(key);
      const isCurrent = key === this.store.getSourceKey(this.historySource);

      if (cache.loading) {
        cache.pendingReload = true;
        if (isCurrent) {
          this.loadingSessions = true;
          this.sidebarDirty = true;
          this.scheduleRender();
        }
        return;
      }

      if (!force && this.isPanelActive()) {
        const since = Date.now() - (this.lastInteractionAt || 0);
        if (since < this.interactionHoldMs) {
          cache.pendingReload = true;
          return;
        }
      }

      const requestId = ++cache.loadRequestId;
      cache.loading = true;
      cache.pendingReload = false;

      if (isCurrent) {
        this.loadingSessions = true;
        this.sidebarDirty = true;
        this.scheduleRender();
      }

      let snapshot = null;
      try {
        snapshot = await this.historyProvider.getSnapshot({
          source: key,
          limit: Math.max(1, cache.loadLimit || SESSION_LIST_LIMIT),
        });
      } catch (_) {
        snapshot = null;
      }

      if (requestId !== cache.loadRequestId) return;

      cache.loading = false;
      let deferPending = false;
      if (snapshot) {
        this.store.applySessionSnapshot(cache, snapshot, key);
        const hasPending = Array.isArray(cache.pendingDeltas) && cache.pendingDeltas.length > 0;
        const canApplyPending = this.isPanelActive()
          && (Date.now() - (this.lastInteractionAt || 0)) >= this.interactionHoldMs;
        if (hasPending && canApplyPending) {
          this.store.flushPendingSessionChanges({ sourceKey: key });
        } else if (hasPending) {
          deferPending = true;
        }
      }

      const reloadRequested = cache.pendingReload;
      cache.pendingReload = false;
      if (deferPending && isCurrent) {
        this.scheduleHistoryReload();
      }

      if (isCurrent) {
        this.store.applySessionCache(key);
        this.sessions = this.store.sessions;
        this.sessionMap = this.store.sessionMap;
        this.loadingSessions = cache.loading;
        this.hasMoreSessions = cache.hasMore;
        this.store.syncSessionCacheMeta(key);
        this.sidebarDirty = true;
        this.scheduleRender();
      }

      if (reloadRequested) {
        void this.loadSessionSummaries({ sourceKey: key });
      }
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
      if (this.sidebarUI?.showHistoryToast) {
        this.sidebarUI.showHistoryToast(message, { tone });
        return;
      }
      const toastEl = document.getElementById('terminal-preview-toast');
      if (!toastEl) return;
      toastEl.textContent = message;
      toastEl.classList.toggle('error', tone === 'error');
      toastEl.classList.add('show');
      setTimeout(() => {
        toastEl.classList.remove('show');
      }, HISTORY_TOAST_DURATION_MS);
    }
  }

  window.HistoryManager = HistoryManager;
})();
