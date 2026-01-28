const HistorySource = require('./base');
const { SessionIndexBuilder } = require('../builders/session-index-builder');
const { buildStatsSignature, createFileStats, aggregateFileStats } = require('../../infra/file-stats');
const { SESSION_INDEX_CACHE_TTL_MS, SEARCH_FILELIST_CACHE_TTL_MS } = require('../history-constants');

class JsonlSource extends HistorySource {
  constructor({
    id,
    capabilities,
    sessionIndexBuilder,
    cacheTtlMs = SESSION_INDEX_CACHE_TTL_MS,
    searchCacheTtlMs = SEARCH_FILELIST_CACHE_TTL_MS,
    logger,
  } = {}) {
    super({ id, capabilities });
    this.sessionIndexBuilder = sessionIndexBuilder || new SessionIndexBuilder();
    this.cacheTtlMs = Number(cacheTtlMs) || SESSION_INDEX_CACHE_TTL_MS;
    this.searchCacheTtlMs = Number(searchCacheTtlMs) || SEARCH_FILELIST_CACHE_TTL_MS;
    this.logger = typeof logger === 'function' ? logger : null;
    this.sessionIndexCache = new Map();
    this.searchFileCache = new Map();
  }

  resetCaches() {
    this.sessionIndexCache.clear();
    this.searchFileCache.clear();
  }

  isSessionIndexCacheFresh(cache) {
    if (!cache) return false;
    const createdAt = Number(cache.createdAt) || 0;
    if (!createdAt) return false;
    const age = Date.now() - createdAt;
    return age >= 0 && age < this.cacheTtlMs;
  }

  isSearchFileCacheFresh(cache) {
    if (!cache) return false;
    const createdAt = Number(cache.createdAt) || 0;
    if (!createdAt) return false;
    const age = Date.now() - createdAt;
    return age >= 0 && age < this.searchCacheTtlMs;
  }

  async getSearchFileList(cacheKey, buildFn, { useCache = false, refresh = false } = {}) {
    if (!useCache) {
      return buildFn();
    }
    const cached = this.searchFileCache.get(cacheKey);
    if (refresh || !cached || !this.isSearchFileCacheFresh(cached)) {
      const files = await buildFn();
      this.searchFileCache.set(cacheKey, { files, createdAt: Date.now() });
      return files;
    }
    return Array.isArray(cached.files) ? cached.files : [];
  }

  async getMeta() {
    const stats = await this.collectFileStats();
    return {
      source: this.id,
      file_count: stats.fileCount,
      latest_mtime: stats.latestMtime,
      latest_size: stats.latestSize,
      signature: buildStatsSignature(stats),
    };
  }

  async collectFileStats() {
    const stats = createFileStats();
    const files = await this.listSessionFiles();
    aggregateFileStats(stats, files);
    return stats;
  }

  async listSessions({ limit = 200, cursor, chunk_size } = {}) {
    const max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 200;
    const cursorProvided = Number.isFinite(cursor);
    const start = cursorProvided ? Math.max(0, Math.floor(cursor)) : 0;
    const chunkProvided = Number.isFinite(chunk_size);
    const chunkSize = chunkProvided ? Math.max(1, Math.floor(chunk_size)) : 0;
    const target = chunkSize > 0 ? chunkSize : max;

    const useCache = cursorProvided || chunkProvided;
    let entries = null;
    if (useCache) {
      const cacheKey = this.id;
      const cached = this.sessionIndexCache.get(cacheKey);
      if (!cached || !this.isSessionIndexCacheFresh(cached) || start === 0) {
        entries = await this.listSessionIndexEntries();
        this.sessionIndexCache.set(cacheKey, { entries, createdAt: Date.now() });
      } else {
        entries = Array.isArray(cached.entries) ? cached.entries : [];
      }
    } else {
      entries = await this.listSessionIndexEntries();
    }

    if (!Array.isArray(entries)) entries = [];
    if (!entries || entries.length === 0) {
      return { sessions: [], maybe_more: false, next_cursor: null };
    }

    const { blocks, nextCursor } = await this.sessionIndexBuilder.buildSummaries(entries, {
      start,
      target,
      buildFn: (entry) => this.buildSummaryBlock(entry),
    });
    const sessions = blocks;

    const maybeMore = nextCursor < entries.length;
    const includeCursor = cursorProvided || chunkProvided;
    return {
      sessions,
      maybe_more: maybeMore,
      next_cursor: includeCursor ? (maybeMore ? nextCursor : null) : undefined,
    };
  }

  // Abstracts for subclasses.
  async listSessionFiles() {
    return [];
  }

  async listSessionIndexEntries() {
    return [];
  }

  async buildSummaryBlock() {
    return null;
  }
}

module.exports = JsonlSource;
