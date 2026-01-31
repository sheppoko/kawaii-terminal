(function () {
  'use strict';

  function sendHistoryAck(manager, source, pending) {
    if (!manager || !window.historyAPI?.ack) return;
    const safeSource = String(source || '').trim().toLowerCase() || manager.historySource;
    window.historyAPI.ack({
      version: 1,
      source: safeSource,
      applied: true,
      pending: Number.isFinite(pending) ? pending : 0,
      timestamp: Date.now(),
    });
  }

  function scheduleHistoryReload(manager, delayMs = 800) {
    if (!manager?.isExternalHistory?.() || !manager.store) return;
    if (manager.historyReloadTimer) {
      clearTimeout(manager.historyReloadTimer);
    }
    manager.historyReloadTimer = setTimeout(() => {
      manager.historyReloadTimer = null;
      const key = manager.store.getSourceKey(manager.historySource);
      const cache = manager.store.getSessionCache(key);
      const since = Date.now() - (manager.lastInteractionAt || 0);
      if (since < manager.interactionHoldMs) {
        scheduleHistoryReload(manager, Math.max(200, Number(delayMs) || 800));
        return;
      }
      if (!Array.isArray(cache.pendingDeltas) || cache.pendingDeltas.length === 0) {
        return;
      }
      const changed = manager.store.flushPendingSessionChanges({ sourceKey: key });
      if (!changed) return;
      manager.store.applySessionCache(key);
      manager.sessions = manager.store.sessions;
      manager.sessionMap = manager.store.sessionMap;
      manager.hasMoreSessions = cache.hasMore;
      sendHistoryAck(manager, key, cache.pendingDeltas?.length || 0);
      manager.sidebarDirty = true;
      manager.scheduleRender();
    }, Math.max(50, Number(delayMs) || 800));
  }

  function applyHistoryDeltaPayload(manager, payload, { forceImmediate = false } = {}) {
    if (!payload || !manager?.store) return;
    const source = manager.store.getSourceKey(payload?.source || manager.historySource);
    const cache = manager.store.getSessionCache(source);
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

    const isCurrent = source === manager.store.getSourceKey(manager.historySource);
    const shouldDefer = !forceImmediate
      && (!manager.isPanelActive()
        || (manager.isPanelActive() && (Date.now() - (manager.lastInteractionAt || 0)) < manager.interactionHoldMs));

    if (typeof manager.logHistoryDebug === 'function') {
      manager.logHistoryDebug({
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
    }

    if (!cache.snapshotReady && !cache.loading) {
      void loadSessionSummaries(manager, { sourceKey: source, force: true });
    }

    if (shouldDefer) {
      manager.store.queueSessionChanges(cache, changeSet);
      if (isCurrent) {
        scheduleHistoryReload(manager);
      }
      return;
    }

    const changed = manager.store.applySessionChanges(cache, changeSet, source);
    if (!changed) return;
    if (!cache.snapshotReady) cache.snapshotReady = true;
    sendHistoryAck(manager, source, cache.pendingDeltas?.length || 0);
    if (isCurrent) {
      manager.store.applySessionCache(source);
      manager.sessions = manager.store.sessions;
      manager.sessionMap = manager.store.sessionMap;
      manager.hasMoreSessions = cache.hasMore;
      manager.sidebarDirty = true;
      manager.scheduleRender();
    }
  }

  function handleHistoryDelta(manager, payload) {
    if (!payload) return;
    const isBootstrap = payload?.phase === 'bootstrap';
    applyHistoryDeltaPayload(manager, payload, { forceImmediate: isBootstrap });
    if (manager.sessionDeltaListener) {
      manager.sessionDeltaListener(payload);
    }
  }

  function handleHistoryInvalidate(manager, payload) {
    if (!manager?.store) return;
    const source = manager.store.getSourceKey(payload?.source || manager.historySource);
    const cache = manager.store.getSessionCache(source);
    cache.pendingDeltas = [];
    cache.snapshotReady = false;
    void loadSessionSummaries(manager, { sourceKey: source, force: true });
    if (manager.sessionDeltaListener) {
      manager.sessionDeltaListener({ type: 'invalidate', payload });
    }
  }

  async function loadSessionSummaries(manager, { sourceKey, force = false } = {}) {
    if (!manager?.historyProvider?.getSnapshot || !manager.store) return;
    const key = manager.store.getSourceKey(sourceKey || manager.historySource);
    const cache = manager.store.getSessionCache(key);
    const isCurrent = key === manager.store.getSourceKey(manager.historySource);

    if (cache.loading) {
      cache.pendingReload = true;
      if (isCurrent) {
        manager.loadingSessions = true;
        manager.sidebarDirty = true;
        manager.scheduleRender();
      }
      return;
    }

    if (!force && manager.isPanelActive()) {
      const since = Date.now() - (manager.lastInteractionAt || 0);
      if (since < manager.interactionHoldMs) {
        cache.pendingReload = true;
        return;
      }
    }

    const requestId = ++cache.loadRequestId;
    cache.loading = true;
    cache.pendingReload = false;

    if (isCurrent) {
      manager.loadingSessions = true;
      manager.sidebarDirty = true;
      manager.scheduleRender();
    }

    let snapshot = null;
    try {
      snapshot = await manager.historyProvider.getSnapshot({
        source: key,
        limit: Math.max(1, cache.loadLimit || manager.SESSION_LIST_LIMIT || 5000),
      });
    } catch (_) {
      snapshot = null;
    }

    if (requestId !== cache.loadRequestId) return;

    cache.loading = false;
    let deferPending = false;
    if (snapshot) {
      manager.store.applySessionSnapshot(cache, snapshot, key);
      const hasPending = Array.isArray(cache.pendingDeltas) && cache.pendingDeltas.length > 0;
      const canApplyPending = manager.isPanelActive()
        && (Date.now() - (manager.lastInteractionAt || 0)) >= manager.interactionHoldMs;
      if (hasPending && canApplyPending) {
        manager.store.flushPendingSessionChanges({ sourceKey: key });
      } else if (hasPending) {
        deferPending = true;
      }
    }

    const reloadRequested = cache.pendingReload;
    cache.pendingReload = false;
    if (deferPending && isCurrent) {
      scheduleHistoryReload(manager);
    }

    if (isCurrent) {
      manager.store.applySessionCache(key);
      manager.sessions = manager.store.sessions;
      manager.sessionMap = manager.store.sessionMap;
      manager.loadingSessions = cache.loading;
      manager.hasMoreSessions = cache.hasMore;
      manager.store.syncSessionCacheMeta(key);
      manager.sidebarDirty = true;
      manager.scheduleRender();
    }

    if (reloadRequested) {
      void loadSessionSummaries(manager, { sourceKey: key });
    }
  }

  window.HistoryManagerSync = {
    sendHistoryAck,
    scheduleHistoryReload,
    applyHistoryDeltaPayload,
    handleHistoryDelta,
    handleHistoryInvalidate,
    loadSessionSummaries,
  };
})();
