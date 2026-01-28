(function () {
  'use strict';

  class StatusClient {
    constructor() {
      this.entries = new Map();
      this.ready = false;
      this.onUpdate = null;
    }

    setUpdateListener(listener) {
      this.onUpdate = typeof listener === 'function' ? listener : null;
    }

    applySnapshot(snapshot) {
      const list = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
      this.entries = new Map();
      list.forEach((entry) => {
        if (!entry || !entry.session_key) return;
        this.entries.set(entry.session_key, entry);
      });
      this.ready = true;
    }

    applyUpdate(payload) {
      const entries = Array.isArray(payload?.entries) ? payload.entries : [];
      const removed = Array.isArray(payload?.removed) ? payload.removed : [];
      entries.forEach((entry) => {
        if (!entry || !entry.session_key) return;
        this.entries.set(entry.session_key, entry);
      });
      removed.forEach((key) => {
        if (key) this.entries.delete(key);
      });
      if (this.onUpdate) {
        this.onUpdate(payload);
      }
    }

    getStatus({ sessionId, source } = {}) {
      const sid = String(sessionId || '').trim();
      const src = String(source || '').trim().toLowerCase();
      if (!sid || !src) return null;
      const key = `${src}:${sid}`;
      return this.entries.get(key) || null;
    }

    async init() {
      if (!window.statusAPI?.getSnapshot) return;
      try {
        const snapshot = await window.statusAPI.getSnapshot();
        this.applySnapshot(snapshot);
      } catch (_) {
        this.applySnapshot({ entries: [] });
      }
      if (window.statusAPI?.onUpdate) {
        window.statusAPI.onUpdate((payload) => this.applyUpdate(payload));
      }
    }
  }

  window.StatusClient = StatusClient;
})();
