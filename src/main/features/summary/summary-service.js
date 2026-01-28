const { AgentPresenceService } = require('../../infra/agents/agent-presence-service');
const { ClaudeSummaryProvider } = require('./claude-summary-provider');
const { GeminiSummaryProvider } = require('./gemini-summary-service');

const DEFAULT_PROVIDER = 'gemini';

class SummaryService {
  constructor({ settingsStore, historyService, presenceService, capabilityService } = {}) {
    this.settingsStore = settingsStore || null;
    this.historyService = historyService || null;
    this.presenceService = presenceService || new AgentPresenceService();
    this.capabilityService = capabilityService || null;
    this.providers = new Map();
    this.providers.set('claude', new ClaudeSummaryProvider({ settingsStore, historyService }));
    this.providers.set('gemini', new GeminiSummaryProvider({ settingsStore, historyService }));
  }

  getSettings() {
    const settings = this.settingsStore?.get?.() || {};
    const summaries = settings?.summaries || {};
    const enabled = typeof summaries.enabled === 'boolean' ? summaries.enabled : true;
    const provider = typeof summaries.provider === 'string' && summaries.provider.trim()
      ? summaries.provider.trim().toLowerCase()
      : DEFAULT_PROVIDER;
    const gemini = summaries?.gemini || {};
    const claude = summaries?.claude || {};
    return {
      enabled,
      provider,
      gemini,
      claude,
    };
  }

  getProviderId() {
    const { provider } = this.getSettings();
    if (provider === 'claude') return 'claude';
    return 'gemini';
  }

  getProvider() {
    const id = this.getProviderId();
    return this.providers.get(id) || this.providers.get(DEFAULT_PROVIDER);
  }

  async checkAvailability() {
    if (this.capabilityService?.checkFeature) {
      const result = await this.capabilityService.checkFeature('summary');
      if (result) return result;
    }
    const settings = this.getSettings();
    const providerId = this.getProviderId();
    const presence = await this.presenceService.check();
    const claudeLocalCli = Boolean(presence?.claude?.local?.cli?.present);
    const geminiHasKey = Boolean(String(settings.gemini?.apiKey || '').trim());

    const providerAvailable = providerId === 'claude'
      ? claudeLocalCli
      : geminiHasKey;

    return {
      available: Boolean(settings.enabled && providerAvailable),
      enabled: settings.enabled,
      provider: providerId,
      hasKey: providerId === 'gemini' ? geminiHasKey : false,
      providers: {
        claude: {
          available: claudeLocalCli,
          local: presence?.claude?.local || null,
          wsl: presence?.claude?.wsl || null,
        },
        gemini: {
          available: geminiHasKey,
          hasKey: geminiHasKey,
        },
      },
    };
  }

  async generateSummary({ source, session_id } = {}) {
    const availability = await this.checkAvailability();
    if (!availability?.available) {
      if (availability?.enabled === false) {
        return { ok: false, unavailable: true };
      }
      if (availability?.provider === 'claude') {
        return { ok: false, unavailable: true, missing: ['claude'] };
      }
      return { ok: false, unavailable: true };
    }

    const provider = this.getProvider();
    if (!provider?.generateSummary) {
      return { ok: false, error: 'Summary provider unavailable' };
    }
    return provider.generateSummary({ source, session_id });
  }
}

module.exports = {
  SummaryService,
};
