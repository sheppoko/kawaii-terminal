const https = require('https');

const {
  DEFAULT_LANGUAGE,
  PROMPT_VERSION,
  buildCacheKey,
  buildPrompt,
  hashPayload,
  normalizeSummaryText,
  pickRecentPairs,
} = require('./summary-utils');

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const REQUEST_TIMEOUT_MS = 12000;

function requestGemini({ apiKey, model, prompt, timeoutMs }) {
  return new Promise((resolve) => {
    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`);
    url.searchParams.set('key', apiKey);

    const body = JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        topP: 0.9,
        maxOutputTokens: 200,
      },
    });

    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk.toString();
      });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          resolve({ ok: false, error: `HTTP ${res.statusCode}` });
          return;
        }
        try {
          const json = JSON.parse(data);
          const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          resolve({ ok: Boolean(text), text });
        } catch (_) {
          resolve({ ok: false, error: 'Invalid JSON response' });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Request timeout' });
    });

    req.on('error', (err) => {
      resolve({ ok: false, error: err?.message || 'Request failed' });
    });

    req.write(body);
    req.end();
  });
}

class GeminiSummaryProvider {
  constructor({ settingsStore, historyService } = {}) {
    this.settingsStore = settingsStore || null;
    this.historyService = historyService || null;
    this.cache = new Map();
    this.id = 'gemini';
  }

  getSettings() {
    const settings = this.settingsStore?.get?.() || {};
    const summaries = settings?.summaries || {};
    const enabled = typeof summaries.enabled === 'boolean' ? summaries.enabled : true;
    const language = typeof summaries.language === 'string' && summaries.language.trim()
      ? summaries.language.trim()
      : DEFAULT_LANGUAGE;
    const gemini = summaries?.gemini || {};
    let model = typeof gemini.model === 'string' && gemini.model.trim()
      ? gemini.model.trim()
      : (typeof summaries.model === 'string' && summaries.model.trim()
        ? summaries.model.trim()
        : DEFAULT_MODEL);
    if (model.startsWith('models/')) {
      model = model.slice(7);
    }
    const apiKey = String(gemini?.apiKey || '').trim();
    return {
      enabled,
      model,
      language,
      apiKey,
    };
  }

  checkAvailability() {
    const { enabled, apiKey } = this.getSettings();
    return {
      available: Boolean(enabled && apiKey),
      enabled,
      hasKey: Boolean(apiKey),
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
    if (!settings.enabled || !settings.apiKey) {
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
    const response = await requestGemini({
      apiKey: settings.apiKey,
      model: settings.model,
      prompt,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    if (!response.ok || !response.text) {
      return { ok: false, error: response.error || 'Generation failed' };
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
  GeminiSummaryProvider,
};
