const { ClaudeCliRunner } = require('../../infra/agents/claude-cli');
const {
  DEFAULT_LANGUAGE,
  PROMPT_VERSION,
  buildCacheKey,
  buildPrompt,
  hashPayload,
  normalizeSummaryText,
  pickRecentPairs,
} = require('./summary-utils');

const DEFAULT_MODEL = 'claude-haiku-4-5';

class ClaudeSummaryProvider {
  constructor({ settingsStore, historyService, cliRunner } = {}) {
    this.settingsStore = settingsStore || null;
    this.historyService = historyService || null;
    this.cliRunner = cliRunner || new ClaudeCliRunner();
    this.cache = new Map();
    this.id = 'claude';
  }

  getSettings() {
    const settings = this.settingsStore?.get?.() || {};
    const summaries = settings?.summaries || {};
    const enabled = typeof summaries.enabled === 'boolean' ? summaries.enabled : true;
    const language = typeof summaries.language === 'string' && summaries.language.trim()
      ? summaries.language.trim()
      : DEFAULT_LANGUAGE;
    const claude = summaries?.claude || {};
    const model = typeof claude.model === 'string' && claude.model.trim()
      ? claude.model.trim()
      : DEFAULT_MODEL;
    return { enabled, language, model };
  }

  async checkAvailability() {
    const { enabled } = this.getSettings();
    const cliPath = await this.cliRunner.resolveCliPath();
    return {
      available: Boolean(enabled && cliPath),
      enabled,
      cliPath: cliPath || null,
    };
  }

  async generateSummary({ source, session_id } = {}) {
    const safeSource = String(source || '').trim().toLowerCase();
    const sessionId = String(session_id || '').trim();
    if (!safeSource || !sessionId) {
      return { ok: false, error: 'Missing session' };
    }
    if (safeSource !== 'codex' && safeSource !== 'claude') {
      return { ok: false, error: 'Unsupported source' };
    }

    const settings = this.getSettings();
    if (!settings.enabled) {
      return { ok: false, unavailable: true };
    }

    if (!this.historyService?.loadSessionEntries) {
      return { ok: false, error: 'HistoryService not ready' };
    }

    const result = await this.historyService.loadSessionEntries({
      session_id: sessionId,
      source: safeSource,
      limit: 200,
      load_all: true,
    });

    const blocks = Array.isArray(result?.blocks) ? result.blocks : [];
    const pairs = pickRecentPairs(blocks);
    if (pairs.length === 0) {
      return { ok: false, error: 'No pairs found' };
    }

    const payload = {
      promptVersion: PROMPT_VERSION,
      language: settings.language,
      turns: pairs,
    };
    const hash = hashPayload(payload);
    const sessionKey = `${safeSource}:${sessionId}`;
    const cacheKey = buildCacheKey({
      sessionKey,
      hash,
      model: settings.model,
      language: settings.language,
      provider: this.id,
    });
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { ok: true, cached: true, summary: cached.summary, hash, session_key: sessionKey };
    }

    const prompt = buildPrompt(pairs, settings.language);
    const response = await this.cliRunner.run({
      prompt,
      model: settings.model,
      resumeSessionId: null,
      allowTools: false,
      disallowedTools: '*',
      entrypoint: 'sdk-js',
    });

    if (!response?.ok || !response.text) {
      return { ok: false, error: response?.error || 'Generation failed' };
    }

    const summary = normalizeSummaryText(response.text);
    if (!summary) {
      return { ok: false, error: 'Empty summary' };
    }

    this.cache.set(cacheKey, { summary, createdAt: Date.now() });
    return {
      ok: true,
      summary,
      hash,
      session_key: sessionKey,
    };
  }
}

module.exports = {
  ClaudeSummaryProvider,
};
