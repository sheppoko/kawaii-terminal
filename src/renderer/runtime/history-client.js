(function () {
  'use strict';

  function buildEmptySnapshot(source) {
    const safeSource = String(source || '').trim().toLowerCase() || 'all';
    return {
      version: 1,
      generated_at: Date.now(),
      source: safeSource,
      sessions: [],
      meta: {
        source: safeSource,
        file_count: 0,
        latest_mtime: 0,
        latest_size: 0,
        signature: '',
      },
      has_more: false,
      next_cursor: null,
    };
  }

  class HistoryClient {
    constructor() {
      this.onUpdate = null;
      this.unsubscribers = [];
    }

    setUpdateListener(listener) {
      this.onUpdate = typeof listener === 'function' ? listener : null;
    }

    async getSnapshot({ source, limit } = {}) {
      if (!window.historyAPI?.getSnapshot) {
        return buildEmptySnapshot(source);
      }
      try {
        return await window.historyAPI.getSnapshot({ source, limit });
      } catch (_) {
        return buildEmptySnapshot(source);
      }
    }

    async loadMore(options = {}) {
      if (!window.historyAPI?.listSessions) {
        return { sessions: [], maybe_more: false, next_cursor: null };
      }
      return window.historyAPI.listSessions(options || {});
    }

    init() {
      this.unsubscribers.forEach((unsubscribe) => {
        try {
          unsubscribe();
        } catch (_) {
          // ignore
        }
      });
      this.unsubscribers = [];

      if (window.historyAPI?.onDelta) {
        const off = window.historyAPI.onDelta((payload) => {
          if (this.onUpdate) {
            this.onUpdate({ type: 'delta', payload });
          }
        });
        if (typeof off === 'function') this.unsubscribers.push(off);
      }

      if (window.historyAPI?.onInvalidate) {
        const off = window.historyAPI.onInvalidate((payload) => {
          if (this.onUpdate) {
            this.onUpdate({ type: 'invalidate', payload });
          }
        });
        if (typeof off === 'function') this.unsubscribers.push(off);
      }
    }

    dispose() {
      this.unsubscribers.forEach((unsubscribe) => {
        try {
          unsubscribe();
        } catch (_) {
          // ignore
        }
      });
      this.unsubscribers = [];
      this.onUpdate = null;
    }
  }

  window.HistoryClient = HistoryClient;
})();
