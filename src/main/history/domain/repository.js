const {
  normalizeSource,
  getSessionKey,
  getSessionSource,
  compareSessions,
} = require('../utils/utils');
const { blockHasInput } = require('./builders/session-index-builder');
const { normalizeSearchTerms } = require('../utils/keyword-search');
const { normalizeSessionSummary } = require('../../../shared/history/normalize');

const DEFAULT_PAGE_LIMIT = 200;
const MAX_PAGES = 1000;

function normalizeSessionList(list, fallbackSource = '') {
  if (!Array.isArray(list)) return [];
  for (const session of list) {
    normalizeSessionSummary(session, fallbackSource);
  }
  return list;
}

function mergeSessionLists(existing, incoming, fallbackSource = '', limit) {
  const map = new Map();
  const add = (session) => {
    if (!session) return;
    normalizeSessionSummary(session, fallbackSource);
    const key = getSessionKey(session, fallbackSource);
    if (!key) return;
    map.set(key, session);
  };
  for (const session of existing || []) add(session);
  for (const session of incoming || []) add(session);
  const merged = Array.from(map.values());
  merged.sort(compareSessions);
  if (Number.isFinite(limit)) {
    const max = Math.max(1, Math.floor(limit));
    if (merged.length > max) return merged.slice(0, max);
  }
  return merged;
}

class HistoryRepository {
  constructor({ connectors, cacheTtlMs = 30_000, useMetaForCache = false, logger } = {}) {
    this.connectors = connectors || new Map();
    this.cacheTtlMs = Number(cacheTtlMs) || 30_000;
    this.useMetaForCache = useMetaForCache !== false;
    this.logger = typeof logger === 'function' ? logger : null;
    this.sourceCache = new Map();
    this.allCache = null;
  }

  resetCaches() {
    this.sourceCache.clear();
    this.allCache = null;
  }

  getConnectorIds({ includeAll = false } = {}) {
    const ids = Array.from(this.connectors.keys()).sort();
    if (includeAll) return ids;
    return ids.filter(id => id !== 'all');
  }

  getConnector(source) {
    const normalized = normalizeSource(source);
    if (!normalized) return null;
    return this.connectors.get(normalized) || null;
  }

  async getMeta({ source } = {}) {
    const normalized = normalizeSource(source, 'all');
    if (normalized === 'all') {
      const allConnector = this.getConnector('all');
      if (allConnector?.capabilities?.meta && typeof allConnector.getMeta === 'function') {
        return allConnector.getMeta();
      }
      return this.getAllMeta();
    }
    const connector = this.getConnector(normalized);
    if (!connector) {
      return { source: normalized, signature: '', file_count: 0, latest_mtime: 0, latest_size: 0 };
    }
    if (!connector.capabilities?.meta || typeof connector.getMeta !== 'function') {
      return { source: normalized, signature: '', file_count: 0, latest_mtime: 0, latest_size: 0 };
    }
    return connector.getMeta();
  }

  async getAllMeta() {
    const ids = this.getConnectorIds();
    const metaList = await Promise.all(ids.map(async (id) => {
      const connector = this.connectors.get(id);
      if (!connector || !connector.capabilities?.meta || typeof connector.getMeta !== 'function') {
        return { source: id, signature: '', file_count: 0, latest_mtime: 0, latest_size: 0, metaAvailable: false };
      }
      const meta = await connector.getMeta();
      return {
        source: id,
        signature: meta?.signature || '',
        file_count: Number(meta?.file_count || 0),
        latest_mtime: Number(meta?.latest_mtime || 0),
        latest_size: Number(meta?.latest_size || 0),
        metaAvailable: true,
      };
    }));

    const combined = {
      source: 'all',
      file_count: 0,
      latest_mtime: 0,
      latest_size: 0,
      signature: '',
      incomplete: false,
      sources: metaList,
    };

    for (const meta of metaList) {
      combined.file_count += Number(meta.file_count || 0);
      if (meta.latest_mtime > combined.latest_mtime) {
        combined.latest_mtime = meta.latest_mtime;
        combined.latest_size = meta.latest_size || 0;
      }
      if (!meta.metaAvailable || !meta.signature) {
        combined.incomplete = true;
      }
    }

    combined.signature = metaList.map(meta => meta.signature || '').join('|');
    return combined;
  }

  async listSessions({ source, limit, cursor, chunk_size } = {}) {
    const normalized = normalizeSource(source, 'all');
    if (normalized === 'all') {
      const allConnector = this.getConnector('all');
      if (allConnector && typeof allConnector.listSessions === 'function') {
        return this.listSessionsBySource('all', { limit, cursor, chunk_size });
      }
      return this.listSessionsAll({ limit, cursor, chunk_size });
    }
    return this.listSessionsBySource(normalized, { limit, cursor, chunk_size });
  }

  async keywordSearch({
    source,
    query,
    terms,
    limit,
    cursor,
    chunk_size,
    project_path,
    project_dir,
    project_scope,
  } = {}) {
    const rawQuery = String(query || '').trim();
    if (!rawQuery) {
      return { mode: 'keyword', query: '', summary: 'Missing query', candidates: [] };
    }
    const normalized = normalizeSource(source, 'all');
    const normalizedTerms = Array.isArray(terms) && terms.length > 0
      ? terms
      : normalizeSearchTerms(rawQuery);
    const max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 400;

    if (normalized === 'all') {
      return this.keywordSearchAll({
        query: rawQuery,
        terms: normalizedTerms,
        limit: max,
        cursor,
        chunk_size,
        project_path,
        project_dir,
        project_scope,
      });
    }

    const connector = this.getConnector(normalized);
    if (!connector) {
      return { mode: 'keyword', query: rawQuery, summary: 'Unsupported source.', candidates: [] };
    }
    if (typeof connector.keywordSearch !== 'function') {
      const label = normalized ? `${normalized[0].toUpperCase()}${normalized.slice(1)}` : 'Source';
      return { mode: 'keyword', query: rawQuery, summary: `${label} search unavailable.`, candidates: [] };
    }
    return connector.keywordSearch({
      query: rawQuery,
      terms: normalizedTerms,
      limit: max,
      cursor,
      chunk_size,
      project_path,
      project_dir,
      project_scope,
    });
  }

  async keywordSearchAll({ query, terms, limit, cursor, chunk_size, project_path, project_dir, project_scope } = {}) {
    const hits = [];
    const seen = new Set();
    const max = Math.max(1, Number(limit) || 1);
    const cursorProvided = Number.isFinite(cursor);
    const start = cursorProvided ? Math.max(0, Math.floor(cursor)) : 0;
    const chunkProvided = Number.isFinite(chunk_size);
    const chunkSize = chunkProvided ? Math.max(1, Math.floor(chunk_size)) : 0;
    const targetFiles = chunkSize > 0 ? chunkSize : Number.POSITIVE_INFINITY;
    const scope = typeof project_scope === 'string' && project_scope.trim()
      ? project_scope
      : 'all';

    const sources = Array.from(this.connectors?.entries() || [])
      .filter(([id, connector]) => id !== 'all'
        && typeof connector?.listSearchEntries === 'function'
        && typeof connector?.scanSearchEntry === 'function');
    const listResults = await Promise.all(sources.map(async ([id, connector]) => {
      try {
        const result = await connector.listSearchEntries({
          cursor,
          chunk_size,
          project_scope: scope,
          project_path,
          project_dir,
        });
        const entries = Array.isArray(result?.entries) ? result.entries : [];
        for (const entry of entries) {
          if (entry && !entry.source) entry.source = connector?.id || id;
        }
        return entries;
      } catch (_) {
        return [];
      }
    }));
    const files = listResults.flat();
    files.sort((a, b) => {
      const aMtime = a?.mtime ?? a?.file?.mtime ?? 0;
      const bMtime = b?.mtime ?? b?.file?.mtime ?? 0;
      if (aMtime !== bMtime) return bMtime - aMtime;
      const aSource = String(a?.source || '');
      const bSource = String(b?.source || '');
      if (aSource !== bSource) return aSource.localeCompare(bSource);
      const aPath = String(a?.file?.path || '');
      const bPath = String(b?.file?.path || '');
      return aPath.localeCompare(bPath);
    });

    let index = start;
    let processed = 0;
    while (index < files.length && processed < targetFiles) {
      const entry = files[index];
      index += 1;
      processed += 1;
      const sourceImpl = entry?.source ? this.connectors?.get(entry.source) : null;
      if (!sourceImpl || typeof sourceImpl.scanSearchEntry !== 'function') continue;
      await sourceImpl.scanSearchEntry(entry, { terms, hits, seen, maxHits: max });
      if (hits.length >= max) break;
    }

    const maybeMore = index < files.length;
    const includeCursor = cursorProvided || chunkProvided;
    const total = hits.length;
    const summary = total === 0 ? 'No results.' : `${total} hits`;
    return {
      mode: 'keyword',
      query,
      summary,
      candidates: hits,
      next_cursor: includeCursor ? (maybeMore ? index : null) : undefined,
    };
  }

  async loadRecent({ source, limit, project_path, project_dir, project_scope } = {}) {
    const normalized = normalizeSource(source, 'all');
    if (normalized === 'all') {
      return this.loadRecentAll({ limit, project_path, project_dir });
    }
    const connector = this.getConnector(normalized);
    if (!connector || typeof connector.loadRecent !== 'function') {
      return { blocks: [], error: 'Unsupported source' };
    }
    return connector.loadRecent({
      limit,
      project_path,
      project_dir,
      project_scope,
    });
  }

  async loadRecentAll({ limit = 200, project_path, project_dir } = {}) {
    const max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 200;
    const perSourceLimit = Math.max(200, max);
    const payload = {
      limit: perSourceLimit,
      project_path,
      project_dir,
      project_scope: 'all',
    };
    const sources = Array.from(this.connectors?.values() || [])
      .filter(sourceImpl => sourceImpl?.id !== 'all' && typeof sourceImpl?.loadRecent === 'function');
    const results = await Promise.all(sources.map(async (sourceImpl) => {
      try {
        return await sourceImpl.loadRecent(payload);
      } catch (_) {
        return { blocks: [], maybe_more: false };
      }
    }));

    const merged = [];
    const seen = new Set();
    for (const result of results) {
      for (const block of result?.blocks || []) {
        if (!block?.id || seen.has(block.id)) continue;
        seen.add(block.id);
        merged.push(block);
      }
    }

    const maybeMore = Boolean(results.some(result => result?.maybe_more) || merged.length > max);
    merged.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    return { blocks: merged.slice(0, max), maybe_more: maybeMore };
  }

  async listSessionsBySource(source, { limit, cursor, chunk_size } = {}) {
    const connector = this.getConnector(source);
    if (!connector || typeof connector.listSessions !== 'function') {
      return { sessions: [], maybe_more: false, next_cursor: null, error: 'Unsupported source' };
    }
    const result = await connector.listSessions({ limit, cursor, chunk_size });
    let sessions = normalizeSessionList(Array.isArray(result?.sessions) ? result.sessions : [], source);
    sessions = sessions.filter(blockHasInput);
    const start = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : null;
    const target = Number.isFinite(limit)
      ? Math.max(1, Math.floor(limit))
      : (Number.isFinite(chunk_size) ? Math.max(1, Math.floor(chunk_size)) : sessions.length);
    const existing = this.sourceCache.get(source);
    const base = start === 0 || start == null ? [] : (Array.isArray(existing?.sessions) ? existing.sessions : []);
    const merged = mergeSessionLists(base, sessions, source, target);
    this.setSourceCache(source, {
      sessions: merged,
      signature: existing?.signature || '',
      limit: target,
      hasMore: result?.next_cursor != null || result?.nextCursor != null || result?.maybe_more === true,
    });
    return {
      ...result,
      sessions,
    };
  }

  async listSessionsAll({ limit, cursor, chunk_size } = {}) {
    const pageSizeRaw = Number.isFinite(chunk_size) ? chunk_size : limit;
    const pageSize = Number.isFinite(pageSizeRaw)
      ? Math.max(1, Math.floor(pageSizeRaw))
      : DEFAULT_PAGE_LIMIT;
    const start = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : 0;
    const target = Math.max(1, start + pageSize);

    const cache = this.allCache;
    const cacheSessions = Array.isArray(cache?.sessions) ? cache.sessions : [];
    const cacheSufficient = cacheSessions.length >= target;
    if (!cacheSufficient) {
      let metaSources = null;
      let signature = cache?.signature || '';
      if (this.useMetaForCache) {
        const meta = await this.getAllMeta();
        metaSources = meta?.sources;
        signature = meta?.signature || signature;
      }
      const merged = await this.fetchMergedSessions({
        target,
        metaSources,
        state: cache?.mergeState || null,
        sessions: cacheSessions.length > 0 ? cacheSessions : null,
      });
      this.allCache = {
        sessions: merged.sessions,
        signature,
        createdAt: Date.now(),
        target,
        hasMore: merged.hasMore,
        mergeState: merged.state,
      };
    }

    const sessions = Array.isArray(this.allCache?.sessions) ? this.allCache.sessions : [];
    const end = Math.min(sessions.length, start + pageSize);
    const slice = sessions.slice(start, end);
    const moreAvailable = end < sessions.length || Boolean(this.allCache?.hasMore);
    const nextCursor = moreAvailable ? end : null;
    return {
      sessions: slice,
      maybe_more: nextCursor !== null,
      next_cursor: nextCursor,
    };
  }

  isAllCacheFresh({ signature, incomplete, now }) {
    const cache = this.allCache;
    if (!cache) return false;
    if (signature && cache.signature && cache.signature === signature) return true;
    if (incomplete) {
      const age = (now || Date.now()) - (cache.createdAt || 0);
      return age >= 0 && age < this.cacheTtlMs;
    }
    return false;
  }

  isAllCacheFreshByTtl({ now } = {}) {
    const cache = this.allCache;
    if (!cache) return false;
    const age = (now || Date.now()) - (cache.createdAt || 0);
    return age >= 0 && age < this.cacheTtlMs;
  }

  isSourceCacheFresh({ source, signature, now }) {
    const cache = this.sourceCache.get(source);
    if (!cache) return false;
    if (signature && cache.signature && cache.signature === signature) return true;
    if (!signature) {
      const age = (now || Date.now()) - (cache.createdAt || 0);
      return age >= 0 && age < this.cacheTtlMs;
    }
    return false;
  }

  async fetchAllSources(metaList = []) {
    const ids = this.getConnectorIds();
    const results = await Promise.all(ids.map(async (id) => {
      const connector = this.connectors.get(id);
      if (!connector || typeof connector.listSessions !== 'function') return [];
      const sessions = await this.fetchAllSessionsFromConnector(connector, id);
      const meta = metaList.find(item => item?.source === id);
      if (meta) {
        this.setSourceCache(id, {
          sessions,
          signature: meta.signature || '',
        });
      }
      return sessions;
    }));

    const merged = [];
    const byKey = new Map();
    for (const list of results) {
      for (const session of list) {
        if (!session) continue;
        const source = getSessionSource(session);
        if (!source) continue;
        const key = getSessionKey(session, source);
        if (!key) continue;
        const existing = byKey.get(key);
        if (!existing || compareSessions(session, existing) < 0) {
          byKey.set(key, session);
        }
      }
    }
    merged.push(...byKey.values());
    merged.sort(compareSessions);
    return merged;
  }

  async fetchMergedSessions({ target, metaSources, state, sessions } = {}) {
    const max = Number.isFinite(target) ? Math.max(1, Math.floor(target)) : DEFAULT_PAGE_LIMIT;
    const sourceMeta = Array.isArray(metaSources) ? metaSources : null;
    const metaIds = sourceMeta
      ? sourceMeta
        .filter(meta => !meta?.metaAvailable || Number(meta?.file_count || 0) > 0)
        .map(meta => meta?.source)
        .filter(Boolean)
      : [];
    const ids = (metaIds.length > 0 ? metaIds : this.getConnectorIds()).filter(Boolean);
    if (ids.length === 0) return { sessions: [], hasMore: false, state: null };

    const idsKey = ids.join('|');
    const desiredPageSize = Math.max(
      20,
      Math.min(DEFAULT_PAGE_LIMIT, Math.ceil(max / Math.max(1, ids.length * 2))),
    );

    const canReuse = state
      && state.idsKey === idsKey
      && state.states instanceof Map
      && state.seen instanceof Set
      && Array.isArray(sessions);

    let output = Array.isArray(sessions) ? sessions : [];
    let mergeState = state;

    if (!canReuse) {
      output = [];
      mergeState = {
        ids,
        idsKey,
        pageSize: desiredPageSize,
        states: new Map(),
        seen: new Set(),
      };
    } else if (!mergeState.pageSize) {
      mergeState.pageSize = desiredPageSize;
    }

    const loadPage = async (entry) => {
      if (entry.exhausted) return false;
      if (entry.pagesFetched >= MAX_PAGES) {
        entry.exhausted = true;
        return false;
      }
      const connector = entry.connector || this.connectors.get(entry.id);
      if (!connector || typeof connector.listSessions !== 'function') {
        entry.exhausted = true;
        return false;
      }
      entry.connector = connector;
      entry.pagesFetched += 1;
      const result = await connector.listSessions({
        limit: mergeState.pageSize,
        cursor: entry.cursor,
        chunk_size: mergeState.pageSize,
      });
      const batch = normalizeSessionList(Array.isArray(result?.sessions) ? result.sessions : [], entry.id);
      const filtered = batch.filter(blockHasInput);
      for (const session of filtered) {
        const key = getSessionKey(session, entry.id);
        if (!key || entry.seen.has(key)) continue;
        entry.seen.add(key);
        entry.buffer.push(session);
      }
      const nextCursor = result?.next_cursor ?? result?.nextCursor ?? null;
      if (nextCursor == null || nextCursor === entry.cursor || nextCursor === false || nextCursor === '') {
        entry.exhausted = true;
      } else {
        entry.cursor = nextCursor;
      }
      return entry.index < entry.buffer.length;
    };

    const ensureNext = async (entry) => {
      while (!entry.exhausted && entry.index >= entry.buffer.length) {
        const hadNext = await loadPage(entry);
        if (hadNext) break;
        if (entry.exhausted) break;
      }
    };

    if (!canReuse) {
      for (const id of ids) {
        const entry = {
          id,
          connector: this.connectors.get(id) || null,
          buffer: [],
          index: 0,
          cursor: undefined,
          exhausted: false,
          pagesFetched: 0,
          seen: new Set(),
        };
        mergeState.states.set(id, entry);
        await loadPage(entry);
      }
    } else if (mergeState.seen.size === 0 && output.length > 0) {
      for (const session of output) {
        const key = getSessionKey(session);
        if (key) mergeState.seen.add(key);
      }
    }

    while (output.length < max) {
      let bestEntry = null;
      let bestSession = null;
      for (const entry of mergeState.states.values()) {
        const session = entry.buffer[entry.index];
        if (!session) continue;
        if (!bestSession || compareSessions(session, bestSession) < 0) {
          bestSession = session;
          bestEntry = entry;
        }
      }
      if (!bestSession || !bestEntry) break;
      bestEntry.index += 1;
      const key = getSessionKey(bestSession, bestEntry.id);
      if (key && !mergeState.seen.has(key)) {
        mergeState.seen.add(key);
        output.push(bestSession);
      }
      await ensureNext(bestEntry);
    }

    let hasMore = false;
    for (const entry of mergeState.states.values()) {
      if (!entry.exhausted || entry.index < entry.buffer.length) {
        hasMore = true;
        break;
      }
    }
    return { sessions: output, hasMore, state: mergeState };
  }

  async fetchLimitedSessionsFromConnector(connector, fallbackSource, { limit } = {}) {
    const max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : DEFAULT_PAGE_LIMIT;
    const sessions = [];
    const seen = new Set();
    const pageSize = Math.min(DEFAULT_PAGE_LIMIT, Math.max(1, max));
    let cursor = undefined;
    let pages = 0;

    while (sessions.length < max && pages < MAX_PAGES) {
      pages += 1;
      const result = await connector.listSessions({
        limit: pageSize,
        cursor,
        chunk_size: pageSize,
      });
      const batch = normalizeSessionList(Array.isArray(result?.sessions) ? result.sessions : [], fallbackSource);
      if (batch.length === 0) {
        cursor = null;
        break;
      }
      for (const session of batch) {
        const key = getSessionKey(session, fallbackSource);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        sessions.push(session);
        if (sessions.length >= max) break;
      }
      const nextCursor = result?.next_cursor ?? result?.nextCursor ?? null;
      if (nextCursor == null || nextCursor === cursor || nextCursor === false || nextCursor === '') {
        cursor = null;
        break;
      }
      cursor = nextCursor;
    }

    const hasMore = cursor != null;
    return { sessions, hasMore, nextCursor: cursor };
  }

  async fetchAllSessionsFromConnector(connector, fallbackSource) {
    const sessions = [];
    const seen = new Set();
    const pageSize = DEFAULT_PAGE_LIMIT;
    let cursor = undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await connector.listSessions({
        limit: pageSize,
        cursor,
        chunk_size: pageSize,
      });
      const batch = normalizeSessionList(Array.isArray(result?.sessions) ? result.sessions : [], fallbackSource);
      if (batch.length === 0) break;
      for (const session of batch) {
        if (!session) continue;
        const key = getSessionKey(session, fallbackSource);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        sessions.push(session);
      }
      const nextCursor = result?.next_cursor ?? result?.nextCursor ?? null;
      if (nextCursor == null || nextCursor === cursor || nextCursor === false || nextCursor === '') break;
      cursor = nextCursor;
    }

    return sessions;
  }

  setSourceCache(source, { sessions, signature, limit, hasMore } = {}) {
    this.sourceCache.set(source, {
      sessions: Array.isArray(sessions) ? sessions : [],
      signature: signature || '',
      limit: Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : undefined,
      hasMore: Boolean(hasMore),
      createdAt: Date.now(),
    });
  }

  async loadSession({ source, session_id, sessionId, limit, cursor, project_path, project_dir, source_path, load_all } = {}) {
    const normalized = normalizeSource(source);
    const connector = this.getConnector(normalized);
    if (!connector || typeof connector.loadSession !== 'function') {
      return { blocks: [], error: 'Unsupported source' };
    }
    const resolvedSessionId = sessionId || session_id;
    const result = await connector.loadSession({
      sessionId: resolvedSessionId,
      limit,
      cursor,
      project_path,
      project_dir,
      source_path,
      load_all,
    });
    const blocks = Array.isArray(result?.blocks) ? result.blocks.filter(blockHasInput) : [];
    return {
      ...result,
      blocks,
    };
  }

  async createTimeMachine({ block } = {}) {
    if (!block || typeof block !== 'object') {
      return { success: false, error: 'Missing block' };
    }
    const source = normalizeSource(block.source);
    if (!source) return { success: false, error: 'Missing source' };
    const connector = this.getConnector(source);
    if (!connector || !connector.capabilities?.timeMachine || typeof connector.createTimeMachine !== 'function') {
      return { success: false, error: 'Time Machine unavailable' };
    }
    return connector.createTimeMachine({ block });
  }
}

module.exports = HistoryRepository;
