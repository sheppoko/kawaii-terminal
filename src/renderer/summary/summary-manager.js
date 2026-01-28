(function () {
  'use strict';

  const REQUEST_MIN_INTERVAL_MS = 1000;

  function safeSessionKey(source, sessionId) {
    const src = String(source || '').trim().toLowerCase();
    const sid = String(sessionId || '').trim();
    if (!src || !sid) return '';
    return `${src}:${sid}`;
  }

  class SummaryManager {
    constructor({ historyManager, statusClient } = {}) {
      this.historyManager = historyManager || null;
      this.statusClient = statusClient || null;
      this.summaryBySessionKey = new Map();
      this.paneToSessionKey = new Map();
      this.pending = new Set();
      this.lastRequestAt = new Map();
      this.available = null;
      this.enabled = true;
      this.showInPane = true;
    }

    async refreshAvailability() {
      const checkAvailability = window.aiProviderAPI?.check
        ? () => window.aiProviderAPI.check({ feature: 'summary' })
        : window.summaryAPI?.check
          ? () => window.summaryAPI.check()
          : null;
      if (!checkAvailability) return;
      try {
        const result = await checkAvailability();
        this.available = Boolean(result?.available);
        this.enabled = result?.enabled !== false;
        if (!this.enabled) {
          this.clearAllSummaries();
        }
      } catch (_) {
        this.available = false;
      }
    }

    init() {
      this.refreshAvailability();
      this.refreshDisplaySettings();
      this.syncBindings();
      this.requestAllBound();
      if (window.settingsAPI?.onChange) {
        window.settingsAPI.onChange((payload) => {
          if (payload?.settings) {
            this.applyDisplaySettings(payload.settings);
          }
          this.available = null;
          this.refreshAvailability();
          this.requestAllBound();
        });
      }
    }

    getSummaryForSession(sessionKey) {
      const key = String(sessionKey || '').trim();
      if (!key) return '';
      return this.summaryBySessionKey.get(key)?.text || '';
    }

    syncBindings() {
      const entries = this.statusClient?.entries;
      if (!entries || typeof entries.forEach !== 'function') return;

      const nextPaneToSessionKey = new Map();
      entries.forEach((entry) => {
        if (!entry || typeof entry !== 'object') return;
        const paneId = String(entry.pane_id || '').trim();
        const sessionKey = String(entry.session_key || '').trim();
        if (!paneId || !sessionKey) return;
        nextPaneToSessionKey.set(paneId, sessionKey);
      });

      for (const [paneId] of this.paneToSessionKey) {
        if (!nextPaneToSessionKey.has(paneId)) {
          this.updatePaneSummary(paneId, '');
        }
      }
      for (const [paneId, nextKey] of nextPaneToSessionKey) {
        const prevKey = this.paneToSessionKey.get(paneId);
        if (prevKey && prevKey !== nextKey) {
          this.updatePaneSummary(paneId, '');
        }
      }

      this.paneToSessionKey = nextPaneToSessionKey;
      this.updateAllPaneSummaries();
    }

    updateAllPaneSummaries() {
      if (!this.showInPane) return;
      for (const [paneId, sessionKey] of this.paneToSessionKey) {
        const summary = this.getSummaryForSession(sessionKey);
        if (summary) {
          this.updatePaneSummary(paneId, summary);
        }
      }
    }

    getSessionCwd(sessionKey) {
      const key = String(sessionKey || '').trim();
      if (!key) return '';
      const session = this.historyManager?.store?.sessionMap?.get?.(key);
      if (!session || typeof session !== 'object') return '';
      const cwd = session.cwd
        || session.project_dir
        || session.project_path
        || session.pane_id
        || '';
      return String(cwd || '').trim();
    }

    clearAllSummaries() {
      this.summaryBySessionKey.clear();
      for (const [paneId] of this.paneToSessionKey) {
        this.updatePaneSummary(paneId, '', { force: true });
      }
      if (this.historyManager) {
        this.historyManager.sidebarDirty = true;
        this.historyManager.scheduleRender();
      }
    }

    updatePaneSummary(paneId, text, { force = false } = {}) {
      if (!this.showInPane && !force) return;
      const pid = String(paneId || '').trim();
      if (!pid) return;
      const escaped = typeof CSS?.escape === 'function' ? CSS.escape(pid) : pid;
      const paneEl = document.querySelector(`.terminal-pane[data-pane-id="${escaped}"]`);
      if (!paneEl) return;
      const summaryEl = paneEl.querySelector('.terminal-pane-summary');
      if (!summaryEl) return;
      const summaryText = String(text || '').trim();
      summaryEl.replaceChildren();
      if (!summaryText) {
        summaryEl.classList.add('is-empty');
        return;
      }

      summaryEl.classList.remove('is-empty');
      const sessionKey = this.paneToSessionKey.get(pid) || '';
      const cwd = this.getSessionCwd(sessionKey);
      if (cwd) {
        const cwdEl = document.createElement('div');
        cwdEl.className = 'terminal-pane-summary-cwd';
        cwdEl.textContent = cwd;
        summaryEl.appendChild(cwdEl);
      }
      const textEl = document.createElement('div');
      textEl.className = 'terminal-pane-summary-text';
      textEl.textContent = summaryText;
        summaryEl.appendChild(textEl);
    }

    applyDisplaySettings(settings) {
      const showInPane = typeof settings?.summaries?.showInPane === 'boolean'
        ? settings.summaries.showInPane
        : true;
      if (showInPane === this.showInPane) return;
      this.showInPane = showInPane;
      if (!showInPane) {
        for (const [paneId] of this.paneToSessionKey) {
          this.updatePaneSummary(paneId, '', { force: true });
        }
        return;
      }
      this.updateAllPaneSummaries();
    }

    async refreshDisplaySettings() {
      if (!window.settingsAPI?.get) return;
      try {
        const settings = await window.settingsAPI.get();
        if (settings) {
          this.applyDisplaySettings(settings);
        }
      } catch (_) {
        // ignore
      }
    }

    shouldRequest(sessionKey) {
      const now = Date.now();
      const lastReq = this.lastRequestAt.get(sessionKey) || 0;
      if (now - lastReq < REQUEST_MIN_INTERVAL_MS) return false;
      return true;
    }

    async requestSummary({ source, sessionId, sessionKey }) {
      if (!window.summaryAPI?.generate) return;
      if (this.available === false || this.enabled === false) return;
      if (!sessionKey) return;
      if (!this.shouldRequest(sessionKey)) return;
      if (this.pending.has(sessionKey)) return;

      this.pending.add(sessionKey);
      this.lastRequestAt.set(sessionKey, Date.now());

      try {
        const result = await window.summaryAPI.generate({
          source,
          session_id: sessionId,
        });

        if (result?.unavailable) {
          this.available = false;
          return;
        }
        if (!result?.ok || !result?.summary) return;

        const summary = String(result.summary || '').trim();
        if (!summary) return;

        this.summaryBySessionKey.set(sessionKey, {
          text: summary,
          createdAt: Date.now(),
        });

        for (const [paneId, key] of this.paneToSessionKey) {
          if (key === sessionKey) {
            this.updatePaneSummary(paneId, summary);
          }
        }
        if (this.historyManager) {
          this.historyManager.sidebarDirty = true;
          this.historyManager.scheduleRender();
        }
      } finally {
        this.pending.delete(sessionKey);
      }
    }

    requestAllBound() {
      for (const sessionKey of this.paneToSessionKey.values()) {
        const [source, sessionId] = sessionKey.split(':');
        if (!source || !sessionId) continue;
        if (source !== 'codex' && source !== 'claude') continue;
        this.requestSummary({ source, sessionId, sessionKey });
      }
    }

    handleStatusUpdate(payload) {
      this.syncBindings();
      const entries = Array.isArray(payload?.entries) ? payload.entries : [];
      entries.forEach((entry) => {
        const source = String(entry?.source || '').trim().toLowerCase();
        const sessionId = String(entry?.session_id || '').trim();
        const sessionKey = String(entry?.session_key || '').trim()
          || safeSessionKey(source, sessionId);
        const paneId = String(entry?.pane_id || '').trim();
        if (!paneId || !sessionKey) return;
        if (source !== 'codex' && source !== 'claude') return;
        this.requestSummary({ source, sessionId, sessionKey });
      });
    }

    handleHistoryDelta(payload) {
      if (!payload) return;
      if (payload.type === 'invalidate') {
        this.syncBindings();
        for (const [, sessionKey] of this.paneToSessionKey) {
          const [source, sessionId] = sessionKey.split(':');
          this.requestSummary({ source, sessionId, sessionKey });
        }
        return;
      }
      const changed = [];
      if (Array.isArray(payload.added)) changed.push(...payload.added);
      if (Array.isArray(payload.updated)) changed.push(...payload.updated);
      for (const session of changed) {
        const source = String(session?.source || payload?.source || '').trim().toLowerCase();
        const sessionId = String(session?.session_id || session?.sessionId || '').trim();
        const sessionKey = safeSessionKey(source, sessionId);
        if (!sessionKey) continue;
        if (source !== 'codex' && source !== 'claude') continue;
        for (const boundKey of this.paneToSessionKey.values()) {
          if (boundKey === sessionKey) {
            this.requestSummary({ source, sessionId, sessionKey });
            break;
          }
        }
      }
    }
  }

  window.SummaryManager = SummaryManager;
})();
