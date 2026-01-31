(function () {
  'use strict';

  const sharedNormalizeSessionSummary = window.HistoryNormalize?.normalizeSessionSummary || null;
  const INPUT_PREVIEW_CHARS = 200;
  const OUTPUT_PREVIEW_CHARS = 180;
  const SEARCH_PANE_INPUT_CHARS = 600;
  const SEARCH_PANE_OUTPUT_CHARS = 1200;
  const SESSION_LIST_LIMIT = 5000;
  const HISTORY_SOURCE = 'all';

  function clampText(text, max) {
    const value = String(text || '');
    if (value.length <= max) return value;
    return value.slice(0, max);
  }

  function stripAnsi(input) {
    const text = String(input || '').replace(/\r\n/g, '\n');
    if (!text) return '';

    // eslint-disable-next-line no-control-regex
    const oscPattern = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
    // eslint-disable-next-line no-control-regex
    const dcsPattern = /\x1bP[\s\S]*?\x1b\\/g;
    // eslint-disable-next-line no-control-regex
    const ansiPattern = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
    const cleaned = text
      .replace(oscPattern, '')
      .replace(dcsPattern, '')
      .replace(ansiPattern, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b/g, '');

    const lines = [];
    let line = '';
    for (let i = 0; i < cleaned.length; i += 1) {
      const ch = cleaned[i];
      if (ch === '\r') {
        line = '';
        continue;
      }
      if (ch === '\n') {
        lines.push(line);
        line = '';
        continue;
      }
      line += ch;
    }
    lines.push(line);
    return lines.join('\n');
  }

  function normalizeOutputText(raw) {
    const text = stripAnsi(raw);
    return text.trimEnd();
  }

  function normalizePreviewText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeInputList(value) {
    if (Array.isArray(value)) {
      return value.map((item) => String(item || '').trim()).filter(Boolean);
    }
    const text = String(value || '').trim();
    if (!text) return [];
    return text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }

  function formatTime(ts) {
    try {
      const date = new Date(ts);
      const day = date.toLocaleDateString([], { year: 'numeric', month: '2-digit', day: '2-digit' });
      const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `${day} ${time}`.trim();
    } catch {
      return '';
    }
  }

  function formatAgo(ts) {
    try {
      const now = Date.now();
      const time = new Date(ts).getTime();
      if (!Number.isFinite(time)) return '';
      let diff = Math.max(0, now - time);
      const seconds = Math.floor(diff / 1000);
      if (seconds < 60) return 'now';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) {
        const remMinutes = minutes % 60;
        if (hours < 2 && remMinutes > 0) return `${hours}h ${remMinutes}m`;
        return `${hours}h`;
      }
      const days = Math.floor(hours / 24);
      if (days < 7) {
        const remHours = hours % 24;
        if (remHours > 0) return `${days}d ${remHours}h`;
        const remMinutes = minutes % 60;
        if (remMinutes > 0) return `${days}d ${remMinutes}m`;
        return `${days}d`;
      }
      if (days < 30) return `${days}d`;
      const months = Math.floor(days / 30);
      if (months < 12) return `${months}mo`;
      const years = Math.floor(months / 12);
      return `${years}y`;
    } catch {
      return '';
    }
  }

  class HistoryStore {
    constructor(options = {}) {
      this.historySource = this.getSourceKey(options.historySource || HISTORY_SOURCE);
      this.sessionLoadLimit = Number.isFinite(options.sessionLoadLimit)
        ? Math.max(1, Math.floor(options.sessionLoadLimit))
        : SESSION_LIST_LIMIT;
      this.sessionCaches = new Map();
      this.sessions = [];
      this.sessionMap = new Map();
      this.hasMoreSessions = true;
      this.loadingSessions = false;
    }

    setHistorySource(source) {
      this.historySource = this.getSourceKey(source);
    }

    getSourceKey(source = this.historySource) {
      const key = String(source || '').trim().toLowerCase();
      return key || HISTORY_SOURCE;
    }

    getSessionCache(source = this.historySource) {
      const key = this.getSourceKey(source);
      let cache = this.sessionCaches.get(key);
      if (!cache) {
        cache = {
          sessions: [],
          sessionMap: new Map(),
          loadLimit: SESSION_LIST_LIMIT,
          hasMore: true,
          loading: false,
          pendingReload: false,
          pendingDeltas: [],
          snapshotReady: false,
          loadRequestId: 0,
          lastSignature: null,
          cursor: 0,
        };
        this.sessionCaches.set(key, cache);
      }
      return cache;
    }

    applySessionCache(source = this.historySource) {
      const key = this.getSourceKey(source);
      const cache = this.getSessionCache(key);
      this.sessions = cache.sessions;
      this.sessionMap = cache.sessionMap;
      this.sessionLoadLimit = cache.loadLimit;
      this.hasMoreSessions = cache.hasMore;
      this.loadingSessions = cache.loading;
      return cache;
    }

    syncSessionCacheMeta(source = this.historySource) {
      const cache = this.getSessionCache(source);
      cache.loadLimit = this.sessionLoadLimit;
      cache.hasMore = this.hasMoreSessions;
      cache.loading = this.loadingSessions;
      return cache;
    }

    buildSessionKey(block, fallbackSource = '') {
      if (!block) return '';
      const sessionId = String(block.session_id || '').trim();
      if (!sessionId) return '';
      const source = String(block.source || fallbackSource || this.historySource || '').trim().toLowerCase()
        || HISTORY_SOURCE;
      return `${source}:${sessionId}`;
    }

    normalizeSessionSummary(session, fallbackSource = '') {
      if (typeof sharedNormalizeSessionSummary !== 'function') return;
      sharedNormalizeSessionSummary(session, fallbackSource || HISTORY_SOURCE);
    }

    compareSessionSummaries(a, b) {
      const aLast = Number(a?.last_output_at || a?.created_at || 0) || 0;
      const bLast = Number(b?.last_output_at || b?.created_at || 0) || 0;
      if (aLast !== bLast) return bLast - aLast;
      const aCreated = Number(a?.created_at || 0) || 0;
      const bCreated = Number(b?.created_at || 0) || 0;
      if (aCreated !== bCreated) return bCreated - aCreated;
      const aId = String(a?.session_id || a?.id || '');
      const bId = String(b?.session_id || b?.id || '');
      if (aId === bId) return 0;
      return aId < bId ? -1 : 1;
    }

    sortSessionSummaries(list) {
      if (!Array.isArray(list) || list.length <= 1) return;
      list.sort((a, b) => this.compareSessionSummaries(a, b));
    }

    clampSessionCache(cache, limit) {
      if (!cache) return false;
      const max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : null;
      if (!max) return false;
      const sessions = Array.isArray(cache.sessions) ? cache.sessions : [];
      if (sessions.length <= max) return false;
      const trimmed = sessions.slice(0, max);
      cache.sessions = trimmed;
      cache.sessionMap = new Map();
      for (const session of trimmed) {
        const key = this.buildSessionKey(session);
        if (!key) continue;
        cache.sessionMap.set(key, session);
      }
      cache.hasMore = true;
      return true;
    }

    applySessionSnapshot(cache, snapshot, fallbackSource = '') {
      if (!cache || !snapshot) return false;
      const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
      cache.sessionMap = new Map();
      for (const session of sessions) {
        if (!session) continue;
        this.normalizeSessionSummary(session, fallbackSource);
        const key = this.buildSessionKey(session, fallbackSource);
        if (!key) continue;
        cache.sessionMap.set(key, session);
      }
      cache.sessions = Array.from(cache.sessionMap.values());
      this.sortSessionSummaries(cache.sessions);
      this.clampSessionCache(cache, cache.loadLimit || SESSION_LIST_LIMIT);
      const nextCursor = Number.isFinite(snapshot?.next_cursor)
        ? snapshot.next_cursor
        : Number.isFinite(snapshot?.cursor)
          ? snapshot.cursor
          : null;
      const hasMore = typeof snapshot?.has_more === 'boolean'
        ? snapshot.has_more
        : typeof snapshot?.maybe_more === 'boolean'
          ? snapshot.maybe_more
          : nextCursor !== null;
      cache.cursor = nextCursor;
      cache.hasMore = Boolean(hasMore);
      cache.snapshotReady = true;
      const snapshotAt = Number(snapshot?.generated_at) || 0;
      const pending = Array.isArray(cache.pendingDeltas) ? cache.pendingDeltas : [];
      cache.pendingDeltas = pending.filter((delta) => {
        const ts = Number(delta?.generated_at) || 0;
        return ts > snapshotAt;
      });
      if (snapshot?.meta?.signature) {
        cache.lastSignature = snapshot.meta.signature;
      }
      return true;
    }

    applySessionChanges(cache, changeSet, fallbackSource = '') {
      if (!cache || !changeSet) return false;
      const added = Array.isArray(changeSet.added) ? changeSet.added : [];
      const updated = Array.isArray(changeSet.updated) ? changeSet.updated : [];
      const removed = Array.isArray(changeSet.removed) ? changeSet.removed : [];
      let changed = false;

      for (const session of [...added, ...updated]) {
        if (!session) continue;
        this.normalizeSessionSummary(session, fallbackSource);
        const key = this.buildSessionKey(session, fallbackSource);
        if (!key) continue;
        cache.sessionMap.set(key, session);
        changed = true;
      }

      for (const removedItem of removed) {
        if (!removedItem) continue;
        const source = String(removedItem.source || '').trim().toLowerCase() || fallbackSource;
        const id = String(removedItem.id || '').trim();
        if (!source || !id) continue;
        const key = `${source}:${id}`;
        if (cache.sessionMap.delete(key)) {
          changed = true;
        }
      }

      if (changed) {
        cache.sessions = Array.from(cache.sessionMap.values());
        this.sortSessionSummaries(cache.sessions);
        this.clampSessionCache(cache, cache.loadLimit || SESSION_LIST_LIMIT);
      }

      return changed;
    }

    queueSessionChanges(cache, changeSet) {
      if (!cache || !changeSet) return;
      if (!Array.isArray(cache.pendingDeltas)) {
        cache.pendingDeltas = [];
      }
      cache.pendingDeltas.push(changeSet);
    }

    flushPendingSessionChanges({ sourceKey } = {}) {
      const key = this.getSourceKey(sourceKey || this.historySource);
      const cache = this.getSessionCache(key);
      const pending = Array.isArray(cache.pendingDeltas) ? cache.pendingDeltas : [];
      if (!pending.length) return false;
      cache.pendingDeltas = [];
      cache.pendingReload = false;
      let changed = false;
      for (const delta of pending) {
        if (this.applySessionChanges(cache, delta, key)) {
          changed = true;
        }
      }
      if (changed && !cache.snapshotReady) {
        cache.snapshotReady = true;
      }
      return changed;
    }

    formatTime(ts) {
      return formatTime(ts);
    }

    formatAgo(ts) {
      return formatAgo(ts);
    }

    formatSourceLabel(source) {
      const safeSource = String(source || '').trim().toLowerCase();
      if (!safeSource) return '';
      if (safeSource === 'claude') return 'Claude';
      if (safeSource === 'codex') return 'Codex';
      return safeSource;
    }

    getBlockInputs(block) {
      if (!block) return [];
      if (Array.isArray(block.inputs) && block.inputs.length > 0) {
        return normalizeInputList(block.inputs);
      }
      return normalizeInputList(block.input);
    }

    blockHasInput(block) {
      return this.getBlockInputs(block).length > 0;
    }

    setBlockInputs(block, inputs) {
      const normalized = normalizeInputList(inputs);
      if (block) {
        block.inputs = normalized;
        block.input = normalized.join('\n');
      }
      return normalized;
    }

    appendBlockInput(block, input) {
      if (!block) return;
      const text = String(input || '').trim();
      if (!text) return;
      const inputs = this.getBlockInputs(block);
      inputs.push(text);
      this.setBlockInputs(block, inputs);
    }

    formatInputsForCard(inputs) {
      const list = normalizeInputList(inputs);
      return clampText(list.join(` \u23ce `), INPUT_PREVIEW_CHARS);
    }

    formatInputsForDetail(inputs) {
      const list = normalizeInputList(inputs);
      if (list.length === 0) return '';
      return list.map((item) => `> ${item}`).join('\n');
    }

    formatInputsForSearchPreview(block) {
      const inputs = this.getBlockInputs(block);
      if (!inputs.length) return '';
      const lines = inputs.map((item) => `> ${item}`);
      return clampText(lines.join('\n'), SEARCH_PANE_INPUT_CHARS);
    }

    formatOutputForSearchPreview(block) {
      if (!block) return '';
      const raw = block.output_text ?? block.output_head ?? block.output_tail ?? '';
      const normalized = normalizeOutputText(raw);
      return clampText(normalized, SEARCH_PANE_OUTPUT_CHARS);
    }

    normalizeOutputText(raw) {
      return normalizeOutputText(raw);
    }

    normalizePreviewText(text) {
      return normalizePreviewText(text);
    }

    clampText(text, max) {
      return clampText(text, max);
    }

    getSessionInputPreview(block) {
      if (!block) return '';
      if (!block.input_preview) {
        const inputs = this.getBlockInputs(block);
        block.input_preview = inputs.length > 0 ? this.formatInputsForCard(inputs) : '';
      }
      return block.input_preview || '';
    }

    getSessionOutputPreview(block) {
      if (!block) return '';
      if (!block.output_preview) {
        const raw = block.output_head || block.output_text || '';
        const sample = String(raw || '').slice(0, OUTPUT_PREVIEW_CHARS * 4);
        const normalized = normalizePreviewText(sample);
        block.output_preview = clampText(normalized, OUTPUT_PREVIEW_CHARS);
      }
      return block.output_preview || '';
    }

    getSearchPaneInputPreview(block) {
      if (!block) return '';
      if (!block.search_input_preview) {
        block.search_input_preview = this.formatInputsForSearchPreview(block);
      }
      return block.search_input_preview || '';
    }

    getSearchPaneOutputPreview(block) {
      if (!block) return '';
      if (!block.search_output_preview) {
        block.search_output_preview = this.formatOutputForSearchPreview(block);
      }
      return block.search_output_preview || '';
    }

    getSearchPaneCandidateId(candidate) {
      if (!candidate) return '';
      const block = candidate?.block || candidate;
      const rawId = block?.id || candidate?.block_id || candidate?.id || '';
      return String(rawId || '');
    }

    getSearchPaneCandidateTimestamp(candidate, fallbackNow = null) {
      if (!candidate) {
        return Number.isFinite(fallbackNow) ? fallbackNow : Date.now();
      }
      const block = candidate?.block || candidate;
      const target = block && typeof block === 'object' ? block : candidate;
      const existing = target && Number.isFinite(target.search_pane_ts) ? target.search_pane_ts : null;
      if (Number.isFinite(existing)) return existing;

      const raw = block?.last_output_at ?? block?.created_at ?? block?.timestamp ?? candidate?.timestamp ?? null;
      let timestamp = 0;
      if (typeof raw === 'string') {
        const parsed = Date.parse(raw);
        timestamp = Number.isFinite(parsed) ? parsed : 0;
      } else {
        timestamp = Number(raw);
      }
      if (!Number.isFinite(timestamp) || timestamp <= 0) {
        timestamp = Number.isFinite(fallbackNow) ? fallbackNow : Date.now();
      }
      if (target && typeof target === 'object') {
        target.search_pane_ts = timestamp;
      }
      return timestamp;
    }

    sortSearchPaneResults(list) {
      if (!Array.isArray(list) || list.length <= 1) return;
      const fallbackNow = Date.now();
      list.sort((a, b) => {
        const aTs = this.getSearchPaneCandidateTimestamp(a, fallbackNow);
        const bTs = this.getSearchPaneCandidateTimestamp(b, fallbackNow);
        if (aTs !== bTs) return bTs - aTs;
        const aId = this.getSearchPaneCandidateId(a);
        const bId = this.getSearchPaneCandidateId(b);
        if (aId === bId) return 0;
        return aId < bId ? -1 : 1;
      });
    }

    buildFullTooltipData(block) {
      if (!block) return null;
      const inputs = this.getBlockInputs(block);
      const input = inputs.length > 0 ? inputs.join('\n') : '';
      const rawOutput = block.output_text ?? block.output ?? block.output_head ?? block.output_tail ?? '';
      const output = rawOutput ? normalizeOutputText(String(rawOutput)) : '';
      const cwd = String(block.cwd || '').trim();
      const timeText = formatTime(block.last_output_at || block.created_at || Date.now());
      return { input, output, cwd, timeText };
    }
  }

  window.HistoryStore = HistoryStore;
})();
