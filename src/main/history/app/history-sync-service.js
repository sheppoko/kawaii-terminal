const { EventEmitter } = require('events');
const {
  compareSessions,
  getSessionFingerprint,
  getSessionKey,
  normalizeSource,
} = require('../utils/utils');

function createEmptyMeta(source) {
  const normalized = String(source || '').trim().toLowerCase();
  return {
    source: normalized,
    file_count: 0,
    latest_mtime: 0,
    latest_size: 0,
    signature: '',
  };
}

function updateMetaFromFile(meta, file) {
  if (!meta) return;
  if (!file) return;
  const mtime = Number(file.mtime || file.mtimeMs || 0) || 0;
  const size = Number(file.size || 0) || 0;
  meta.file_count += 1;
  if (mtime > meta.latest_mtime) {
    meta.latest_mtime = mtime;
    meta.latest_size = size;
    return;
  }
  if (mtime === meta.latest_mtime && size > meta.latest_size) {
    meta.latest_size = size;
  }
}

class HistorySyncService extends EventEmitter {
  constructor({ historyService, codexStatusSource, intervalMs = 3000, sessionLimit = 400 } = {}) {
    super();
    this.historyService = historyService || null;
    this.codexStatusSource = codexStatusSource || null;
    this.intervalMs = Math.max(200, Number(intervalMs) || 3000);
    this.sessionLimit = Math.max(1, Number(sessionLimit) || 400);
    this.snapshotPrimeLimit = 1;
    this.bootstrapBatchSize = 5;
    this.timer = null;
    this.running = false;
    this.ticking = false;
    this.active = false;
    this.sources = [];
    this.metaBySource = new Map();
    this.sessionState = new Map();
    this.deltaQueues = new Map();
  }

  resolveSources() {
    const repo = this.historyService?.repository;
    const ids = repo?.getConnectorIds?.() || [];
    const normalized = ids.map(id => String(id || '').trim().toLowerCase()).filter(Boolean);
    const filtered = normalized.filter(id => id !== 'all');
    if (filtered.length > 0) return filtered;
    return ['claude', 'codex'];
  }

  getAdapter(source) {
    const key = normalizeSource(source);
    if (!key) return null;
    return this.historyService?.repository?.getConnector?.(key) || null;
  }

  getState(source) {
    const key = normalizeSource(source, 'all');
    let state = this.sessionState.get(key);
    if (!state) {
      state = {
        sessions: new Map(),
        hydrating: false,
        hydrated: false,
        refreshing: false,
        refreshPromise: null,
        refreshPending: null,
        seenFiles: new Set(),
      };
      this.sessionState.set(key, state);
    }
    return state;
  }

  getBuildConcurrency(adapter) {
    const hinted = adapter?.sessionIndexBuilder?.concurrency;
    if (Number.isFinite(hinted)) return Math.max(1, Math.floor(hinted));
    return 4;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.sources = this.resolveSources();
    this.schedule();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  schedule() {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.tick();
      this.schedule();
    }, this.intervalMs);
  }

  async tick() {
    if (this.ticking) return;
    if (!this.active) return;
    this.ticking = true;
    try {
      await this.refreshAllSources({ emitDelta: true });
    } finally {
      this.ticking = false;
    }
  }

  async refreshAllSources({ emitDelta = true } = {}) {
    const tasks = this.sources.map(source => this.refreshSourceIndex(source, { emitDelta }));
    await Promise.all(tasks);
  }

  async refreshSourceIndex(source, { emitDelta = true, maxSummaries, phase } = {}) {
    const safeSource = normalizeSource(source);
    if (!safeSource) return false;
    const adapter = this.getAdapter(safeSource);
    if (!adapter?.listSessionIndexEntries) return false;

    const state = this.getState(safeSource);
    if (state.refreshing) {
      const pending = state.refreshPending || { emitDelta, maxSummaries };
      pending.emitDelta = pending.emitDelta || emitDelta;
      if (!Number.isFinite(pending.maxSummaries) || !Number.isFinite(maxSummaries)) {
        pending.maxSummaries = undefined;
      } else {
        pending.maxSummaries = Math.max(pending.maxSummaries, maxSummaries);
      }
      if (phase === 'bootstrap') pending.phase = 'bootstrap';
      state.refreshPending = pending;
      return state.refreshPromise || false;
    }

    state.refreshing = true;
    state.refreshPromise = (async () => {
    let entries = [];
    try {
      entries = await adapter.listSessionIndexEntries();
    } catch (_) {
      entries = [];
    }

    if (!Array.isArray(entries)) entries = [];

    const meta = createEmptyMeta(safeSource);
    const buildQueue = [];
    for (const entry of entries) {
      const fileInfo = entry?.file || null;
      if (fileInfo) updateMetaFromFile(meta, fileInfo);
      const sessionId = String(entry?.sessionId || entry?.session_id || '').trim();
      const sessionKey = sessionId ? `${safeSource}:${sessionId}` : '';
      if (!sessionKey) continue;
      const filePath = fileInfo?.path || '';
      const fileMtime = Number(fileInfo?.mtime || fileInfo?.mtimeMs || 0) || 0;
      const fileSize = Number(fileInfo?.size || 0) || 0;
      const isNewFile = Boolean(filePath && !state.seenFiles.has(filePath));
      if (isNewFile) {
        state.seenFiles.add(filePath);
      }
      const prev = state.sessions.get(sessionKey);
      if (!prev) {
        buildQueue.push({ entry, filePath, fileMtime, fileSize, isNewFile });
        continue;
      }
      if (Number.isFinite(fileMtime) && Number.isFinite(prev.fileMtime) && fileMtime <= prev.fileMtime) {
        continue;
      }
      buildQueue.push({ entry, filePath, fileMtime, fileSize, isNewFile });
    }

    const allowIndexBind = Boolean(
      safeSource === 'codex'
        && this.codexStatusSource?.maybeBindFromIndexEntry
        && state.hydrated
        && !state.hydrating
        && phase !== 'bootstrap'
    );
    if (allowIndexBind) {
      for (const item of buildQueue) {
        if (!item.isNewFile) continue;
        try {
          this.codexStatusSource.maybeBindFromIndexEntry(item.entry, { activityAt: item.fileMtime });
        } catch (_) {
          // ignore binding failures
        }
      }
    }

    if (meta.file_count > 0) {
      meta.signature = `${meta.file_count}:${meta.latest_mtime}:${meta.latest_size}`;
    }
    this.metaBySource.set(safeSource, meta);

    if (entries.length === 0) return false;

    const target = Number.isFinite(maxSummaries) ? Math.max(1, Math.floor(maxSummaries)) : null;
    const targetTotal = target ? Math.min(target, entries.length) : entries.length;
    if (buildQueue.length === 0 && state.sessions.size >= targetTotal) {
      return false;
    }

    let changed = false;
    let processed = 0;
    const concurrency = this.getBuildConcurrency(adapter);
    for (let i = 0; i < buildQueue.length; i += concurrency) {
      if (target && processed >= target) break;
      const slice = buildQueue.slice(i, i + concurrency);
      const results = await Promise.all(slice.map(async (item) => {
        return this.buildSummaryFromEntry(adapter, item.entry, {
          path: item.filePath,
          mtime: item.fileMtime,
          size: item.fileSize,
        });
      }));
      for (let j = 0; j < slice.length; j += 1) {
        const summary = results[j];
        const item = slice[j];
        if (!summary || !item) continue;
        if (this.applySummary(safeSource, summary, {
          filePath: item.filePath,
          fileMtime: item.fileMtime,
          emitDelta,
          phase,
          isNewFile: item.isNewFile,
        })) {
          changed = true;
          processed += 1;
          if (target && processed >= target) break;
        }
      }
    }

    if (emitDelta && phase === 'bootstrap' && this.bootstrapBatchSize > 1) {
      this.flushDeltaQueue(safeSource, { forceAll: true });
      this.flushDeltaQueue('all', { forceAll: true });
    }

    return changed;
    })();

    try {
      return await state.refreshPromise;
    } finally {
      state.refreshing = false;
      state.refreshPromise = null;
      const pending = state.refreshPending;
      state.refreshPending = null;
      if (pending && this.running) {
        setImmediate(() => {
          void this.refreshSourceIndex(safeSource, pending);
        });
      }
    }
  }

  async buildSummaryFromEntry(adapter, entry, fileInfo) {
    if (!adapter) return null;
    if (adapter.buildSummaryBlock) {
      try {
        return await adapter.buildSummaryBlock(entry);
      } catch (_) {
        return null;
      }
    }
    if (adapter.buildSummaryFromFile && fileInfo?.path) {
      try {
        return await adapter.buildSummaryFromFile(fileInfo.path, {
          mtime: fileInfo?.mtime,
          size: fileInfo?.size,
          trustedPath: true,
        });
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  applySummary(source, summary, { filePath, fileMtime, emitDelta = true, phase, isNewFile } = {}) {
    const safeSource = normalizeSource(source);
    if (!safeSource || !summary) return false;
    if (!summary.source) summary.source = safeSource;
    const sessionKey = getSessionKey(summary, safeSource);
    if (!sessionKey) return false;
    const fingerprint = getSessionFingerprint(summary);

    const state = this.getState(safeSource);
    const prev = state.sessions.get(sessionKey);
    if (prev && prev.fingerprint === fingerprint) return false;
    if (prev && Number.isFinite(prev.fileMtime) && Number.isFinite(fileMtime)) {
      if (fileMtime < prev.fileMtime) return false;
    }

    state.sessions.set(sessionKey, {
      summary,
      fingerprint,
      filePath,
      fileMtime,
    });

    const added = prev ? [] : [summary];
    const updated = prev ? [summary] : [];

    if (emitDelta) {
      this.emitDelta({
        source: safeSource,
        added,
        updated,
        meta: this.getMetaForSource(safeSource),
        phase,
      });
    }

    if (safeSource === 'codex') {
      try {
        const allowBind = Boolean(isNewFile && state.hydrated && !state.hydrating && phase !== 'bootstrap');
        this.codexStatusSource?.applySessionSummary?.(summary, { allowBind });
      } catch (_) {
        // ignore
      }
    }

    if (safeSource !== 'all') {
      const allState = this.getState('all');
      const prevAll = allState.sessions.get(sessionKey);
      if (!prevAll || prevAll.fingerprint !== fingerprint) {
        allState.sessions.set(sessionKey, {
          summary,
          fingerprint,
          filePath,
          fileMtime,
        });
        if (emitDelta) {
          this.emitDelta({
            source: 'all',
            added: prevAll ? [] : [summary],
            updated: prevAll ? [summary] : [],
            meta: this.buildCombinedMeta(),
            phase,
          });
        }
      }
    }

    return true;
  }

  getDeltaQueue(source) {
    const key = String(source || '').trim().toLowerCase();
    if (!key) return null;
    let queue = this.deltaQueues.get(key);
    if (!queue) {
      queue = { items: [], meta: null };
      this.deltaQueues.set(key, queue);
    }
    return queue;
  }

  emitDeltaPayload({ source, added, updated, meta, phase } = {}) {
    const safeSource = String(source || '').trim().toLowerCase();
    const addList = Array.isArray(added) ? added : [];
    const updateList = Array.isArray(updated) ? updated : [];
    if (!addList.length && !updateList.length) return;
    const state = this.getState(safeSource);
    const hasMore = state.sessions.size > this.sessionLimit;
    this.emit('delta', {
      version: 1,
      generated_at: Date.now(),
      source: safeSource,
      added: addList,
      updated: updateList,
      meta: meta || createEmptyMeta(safeSource),
      has_more: Boolean(hasMore),
      next_cursor: null,
      phase,
    });
  }

  flushDeltaQueue(source, { forceAll = false } = {}) {
    const safeSource = String(source || '').trim().toLowerCase();
    const queue = this.getDeltaQueue(safeSource);
    if (!queue || queue.items.length === 0) return false;
    const batchSize = forceAll
      ? queue.items.length
      : Math.min(this.bootstrapBatchSize, queue.items.length);
    if (batchSize <= 0) return false;
    const added = [];
    const updated = [];
    for (let i = 0; i < batchSize; i += 1) {
      const item = queue.items.shift();
      if (!item) continue;
      if (item.kind === 'updated') {
        updated.push(item.summary);
      } else {
        added.push(item.summary);
      }
    }
    this.emitDeltaPayload({
      source: safeSource,
      added,
      updated,
      meta: queue.meta || createEmptyMeta(safeSource),
      phase: 'bootstrap',
    });
    return true;
  }

  emitDelta({ source, added, updated, meta, phase } = {}) {
    const safeSource = String(source || '').trim().toLowerCase();
    const addList = Array.isArray(added) ? added : [];
    const updateList = Array.isArray(updated) ? updated : [];
    if (!addList.length && !updateList.length) return;
    if (phase === 'bootstrap' && this.bootstrapBatchSize > 1) {
      const queue = this.getDeltaQueue(safeSource);
      if (!queue) return;
      for (const item of addList) {
        if (!item) continue;
        queue.items.push({ kind: 'added', summary: item });
      }
      for (const item of updateList) {
        if (!item) continue;
        queue.items.push({ kind: 'updated', summary: item });
      }
      if (meta) queue.meta = meta;
      if (queue.items.length >= this.bootstrapBatchSize) {
        this.flushDeltaQueue(safeSource, { forceAll: false });
      }
      return;
    }
    this.emitDeltaPayload({ source: safeSource, added: addList, updated: updateList, meta, phase });
  }
  getMetaForSource(source) {
    const safeSource = normalizeSource(source);
    return this.metaBySource.get(safeSource) || createEmptyMeta(safeSource);
  }

  buildCombinedMeta() {
    const metas = this.sources.map((source) => this.getMetaForSource(source));
    const combined = {
      source: 'all',
      file_count: 0,
      latest_mtime: 0,
      latest_size: 0,
      signature: '',
      sources: metas,
    };
    for (const meta of metas) {
      combined.file_count += Number(meta.file_count || 0);
      const mtime = Number(meta.latest_mtime || 0);
      const size = Number(meta.latest_size || 0);
      if (mtime > combined.latest_mtime) {
        combined.latest_mtime = mtime;
        combined.latest_size = size;
      } else if (mtime === combined.latest_mtime && size > combined.latest_size) {
        combined.latest_size = size;
      }
    }
    combined.signature = metas.map(meta => meta.signature || '').join('|');
    return combined;
  }

  queueBackgroundRefresh(source) {
    if (!this.running) return;
    if (!this.active) return;
    const safeSource = normalizeSource(source, 'all');
    if (safeSource === 'all') {
      setImmediate(() => {
        for (const src of this.sources) {
          void this.refreshSourceIndex(src, {
            emitDelta: true,
            phase: 'bootstrap',
          });
        }
      });
      return;
    }
    setImmediate(() => {
      void this.refreshSourceIndex(safeSource, {
        emitDelta: true,
        phase: 'bootstrap',
      });
    });
  }

  async getSnapshot({ source, limit } = {}) {
    const safeSource = normalizeSource(source, 'all');
    const targetLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : this.sessionLimit;
    const primeLimit = Math.min(targetLimit, this.snapshotPrimeLimit);
    const state = this.getState(safeSource);

    if (!state.hydrated && !state.hydrating) {
      state.hydrating = true;
      try {
        if (safeSource === 'all') {
          for (const src of this.sources) {
            await this.refreshSourceIndex(src, { emitDelta: false, maxSummaries: primeLimit });
          }
        } else {
          await this.refreshSourceIndex(safeSource, { emitDelta: false, maxSummaries: primeLimit });
        }
      } finally {
        state.hydrating = false;
        state.hydrated = true;
      }
      if (!this.active) this.active = true;
      this.queueBackgroundRefresh(safeSource);
    }

    const sessions = Array.from(state.sessions.values()).map(item => item.summary);
    sessions.sort(compareSessions);
    const sliced = sessions.slice(0, targetLimit);
    const meta = safeSource === 'all' ? this.buildCombinedMeta() : this.getMetaForSource(safeSource);
    const hasMore = sessions.length > targetLimit;
    return {
      version: 1,
      generated_at: Date.now(),
      source: safeSource,
      sessions: sliced,
      meta,
      has_more: Boolean(hasMore),
      next_cursor: null,
    };
  }
}

module.exports = { HistorySyncService };
