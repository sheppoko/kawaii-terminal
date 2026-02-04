const os = require('os');
const path = require('path');
const HistoryRepository = require('../domain/repository');
const { createDefaultSources } = require('../domain/sources');
const { normalizeSearchTerms } = require('../utils/keyword-search');
const { resetWslCaches } = require('../infra/wsl-homes');
const { SESSION_INDEX_CACHE_TTL_MS } = require('../domain/history-constants');
const logHistoryDebug = () => {};

class HistoryService {
  constructor({ userDataDir } = {}) {
    this.userDataDir = userDataDir || path.join(os.tmpdir(), 'kawaii-terminal');
    this.sources = createDefaultSources({ logger: logHistoryDebug });
    this.connectors = this.sources;
    this.repository = new HistoryRepository({
      connectors: this.connectors,
      cacheTtlMs: SESSION_INDEX_CACHE_TTL_MS,
      useMetaForCache: false,
      logger: logHistoryDebug,
    });
  }

  resetWslCaches() {
    resetWslCaches();
    if (this.sources) {
      for (const source of this.sources.values()) {
        if (typeof source?.resetCaches === 'function') {
          source.resetCaches();
        }
      }
    }
    if (this.repository) this.repository.resetCaches();
  }


  async keywordSearch({ query, source, project_path, project_dir, project_scope, limit, cursor, chunk_size } = {}) {
    const rawQuery = String(query || '').trim();
    if (!rawQuery) {
      return { mode: 'keyword', query: '', summary: 'Missing query', candidates: [] };
    }

    const max = Number.isFinite(limit) ? Math.max(1, Math.min(2000, limit)) : 400;
    const terms = normalizeSearchTerms(rawQuery);
    const normalized = String(source || 'all').trim().toLowerCase();
    if (!this.repository?.keywordSearch) {
      return { mode: 'keyword', query: rawQuery, summary: 'HistoryService not ready', candidates: [] };
    }
    return this.repository.keywordSearch({
      source: normalized,
      query: rawQuery,
      terms,
      limit: max,
      cursor,
      chunk_size,
      project_path,
      project_dir,
      project_scope,
    });
  }

  async keywordSearchClaude({ query, terms, project_path, project_dir, project_scope, limit, cursor, chunk_size } = {}) {
    if (this.repository?.keywordSearch) {
      return this.repository.keywordSearch({
        source: 'claude',
        query,
        terms,
        project_path,
        project_dir,
        project_scope,
        limit,
        cursor,
        chunk_size,
      });
    }
    const sourceImpl = this.sources?.get('claude');
    if (!sourceImpl?.keywordSearch) {
      return { mode: 'keyword', query, summary: 'Claude search unavailable.', candidates: [] };
    }
    return sourceImpl.keywordSearch({
      query,
      terms,
      project_path,
      project_dir,
      project_scope,
      limit,
      cursor,
      chunk_size,
    });
  }

  async keywordSearchCodex({ query, terms, limit, cursor, chunk_size } = {}) {
    if (this.repository?.keywordSearch) {
      return this.repository.keywordSearch({
        source: 'codex',
        query,
        terms,
        limit,
        cursor,
        chunk_size,
      });
    }
    const sourceImpl = this.sources?.get('codex');
    if (!sourceImpl?.keywordSearch) {
      return { mode: 'keyword', query, summary: 'Codex search unavailable.', candidates: [] };
    }
    return sourceImpl.keywordSearch({ query, terms, limit, cursor, chunk_size });
  }

  async keywordSearchAll({ query, terms, limit, cursor, chunk_size, project_path, project_dir, project_scope } = {}) {
    if (!this.repository?.keywordSearch) {
      return { mode: 'keyword', query, summary: 'HistoryService not ready', candidates: [] };
    }
    return this.repository.keywordSearch({
      source: 'all',
      query,
      terms,
      limit,
      cursor,
      chunk_size,
      project_path,
      project_dir,
      project_scope,
    });
  }

  async listClaudeProjects() {
    const source = this.sources?.get('claude');
    if (!source || typeof source.listProjects !== 'function') return { projects: [] };
    return source.listProjects();
  }

  async loadSessionSummaries({ limit = 200, source, cursor, chunk_size } = {}) {
    if (!this.repository?.listSessions) return { sessions: [] };
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : undefined;
    const safeCursor = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : undefined;
    const safeChunk = Number.isFinite(chunk_size) ? Math.max(1, Math.floor(chunk_size)) : undefined;
    return this.repository.listSessions({
      limit: safeLimit,
      source,
      cursor: safeCursor,
      chunk_size: safeChunk,
    });
  }

  async loadAllSessionSummaries({ limit = 200, cursor, chunk_size } = {}) {
    return this.loadSessionSummaries({
      limit,
      source: 'all',
      cursor,
      chunk_size,
    });
  }

  async loadClaudeSessionSummaries({ limit = 200, cursor, chunk_size } = {}) {
    return this.loadSessionSummaries({
      limit,
      source: 'claude',
      cursor,
      chunk_size,
    });
  }

  async loadCodexSessionSummaries({ limit = 200, cursor, chunk_size } = {}) {
    return this.loadSessionSummaries({
      limit,
      source: 'codex',
      cursor,
      chunk_size,
    });
  }

  async loadSessionEntries({ session_id, source, limit = 200, project_path, project_dir, source_path, load_all } = {}) {
    if (!this.repository?.loadSession) return { blocks: [], error: 'HistoryService not ready' };
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : undefined;
    return this.repository.loadSession({
      session_id,
      source,
      limit: safeLimit,
      project_path,
      project_dir,
      source_path,
      load_all,
    });
  }

  async loadClaudeSessionEntries({ sessionId, limit = 200, project_path, project_dir, source_path, load_all } = {}) {
    return this.loadSessionEntries({
      session_id: sessionId,
      source: 'claude',
      limit,
      project_path,
      project_dir,
      source_path,
      load_all,
    });
  }

  async loadCodexSessionEntries({ sessionId, limit = 200, source_path, load_all } = {}) {
    return this.loadSessionEntries({
      session_id: sessionId,
      source: 'codex',
      limit,
      source_path,
      load_all,
    });
  }

  async loadClaudeRecent({ project_path, project_dir, project_scope, limit = 200 } = {}) {
    if (this.repository?.loadRecent) {
      return this.repository.loadRecent({
        source: 'claude',
        limit,
        project_path,
        project_dir,
        project_scope,
      });
    }
    const source = this.sources?.get('claude');
    if (!source || typeof source.loadRecent !== 'function') return { blocks: [] };
    return source.loadRecent({ project_path, project_dir, project_scope, limit });
  }

  async loadCodexRecent({ limit = 200 } = {}) {
    if (this.repository?.loadRecent) {
      return this.repository.loadRecent({ source: 'codex', limit });
    }
    const source = this.sources?.get('codex');
    if (!source || typeof source.loadRecent !== 'function') return { blocks: [] };
    return source.loadRecent({ limit });
  }

  async loadAllRecent({ limit = 200, project_path, project_dir } = {}) {
    if (!this.repository?.loadRecent) {
      return { blocks: [], error: 'HistoryService not ready' };
    }
    return this.repository.loadRecent({ source: 'all', limit, project_path, project_dir });
  }

  async loadRecent({ limit = 200, source, project_path, project_dir } = {}) {
    if (!this.repository?.loadRecent) {
      return { blocks: [], error: 'HistoryService not ready' };
    }
    const normalized = String(source || 'all').trim().toLowerCase();
    if (normalized === 'claude') {
      return this.repository.loadRecent({
        source: 'claude',
        limit,
        project_path,
        project_dir,
        project_scope: 'all',
      });
    }
    if (normalized === 'codex') {
      return this.repository.loadRecent({ source: 'codex', limit });
    }
    if (normalized === 'all') {
      return this.repository.loadRecent({ source: 'all', limit, project_path, project_dir });
    }
    return { blocks: [], error: 'Unsupported source' };
  }

  async getHistoryMeta({ source } = {}) {
    if (!this.repository?.getMeta) return { signature: '' };
    return this.repository.getMeta({ source });
  }

  async findBlocksById({ ids, source, project_path, project_dir } = {}) {
    const normalized = String(source || '').trim().toLowerCase();
    if (normalized === 'claude') {
      const sourceImpl = this.sources?.get('claude');
      if (!sourceImpl?.findBlocksById) return { blocks: [] };
      return sourceImpl.findBlocksById({ ids, project_path, project_dir });
    }

    if (normalized === 'codex') {
      const sourceImpl = this.sources?.get('codex');
      if (!sourceImpl?.findBlocksById) return { blocks: [] };
      return sourceImpl.findBlocksById({ ids });
    }

    if (normalized === 'all') {
      const [claude, codex] = await Promise.all([
        this.findBlocksById({ ids, source: 'claude', project_path, project_dir }),
        this.findBlocksById({ ids, source: 'codex' }),
      ]);
      const blocks = [...(claude?.blocks || []), ...(codex?.blocks || [])];
      return { blocks };
    }

    return { blocks: [] };
  }

  async search(payload = {}) {
    const {
      query,
      mode,
      source,
      project_path,
      project_dir,
      project_scope,
      limit,
      cursor,
      chunk_size,
    } = payload || {};
    if (!query) return { error: 'Missing query' };
    if (mode === 'llm') {
      return { error: 'LLM search is disabled.' };
    }
    return this.keywordSearch({
      query,
      source,
      project_path,
      project_dir,
      project_scope,
      limit,
      cursor,
      chunk_size,
    });
  }
}

module.exports = HistoryService;
