const DEFAULT_SUMMARY_PROVIDER = 'gemini';
const FEATURE_SUMMARY = 'summary';
const FEATURE_COMMIT_MESSAGE = 'commitMessage';

class ProviderCapabilityService {
  constructor({ settingsStore, presenceService } = {}) {
    this.settingsStore = settingsStore || null;
    this.presenceService = presenceService || null;
  }

  getSettings() {
    return this.settingsStore?.get?.() || {};
  }

  getSummarySettings(settings) {
    const summaries = settings?.summaries || {};
    const enabled = typeof summaries.enabled === 'boolean' ? summaries.enabled : true;
    const provider = typeof summaries.provider === 'string' && summaries.provider.trim()
      ? summaries.provider.trim().toLowerCase()
      : DEFAULT_SUMMARY_PROVIDER;
    const gemini = summaries?.gemini || {};
    const claude = summaries?.claude || {};
    return {
      enabled,
      provider,
      gemini,
      claude,
    };
  }

  normalizeProviderId(value, fallback = DEFAULT_SUMMARY_PROVIDER) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'claude') return 'claude';
    if (raw === 'gemini') return 'gemini';
    return fallback;
  }

  async getProviderStatus({ refresh = false } = {}) {
    const presence = this.presenceService?.check
      ? await this.presenceService.check({ refresh })
      : null;
    const settings = this.getSettings();
    const summarySettings = this.getSummarySettings(settings);
    const geminiHasKey = Boolean(String(summarySettings.gemini?.apiKey || '').trim());
    const claudeLocalCli = Boolean(presence?.claude?.local?.cli?.present);

    return {
      claude: {
        available: claudeLocalCli,
        local: presence?.claude?.local || null,
        wsl: presence?.claude?.wsl || null,
      },
      gemini: {
        available: geminiHasKey,
        hasKey: geminiHasKey,
      },
    };
  }

  resolveCommitProvider(providers) {
    if (providers?.claude?.available) return 'claude';
    return '';
  }

  async checkFeature(feature, { refresh = false } = {}) {
    const safeFeature = String(feature || '').trim() || FEATURE_SUMMARY;
    const providers = await this.getProviderStatus({ refresh });

    if (safeFeature === FEATURE_COMMIT_MESSAGE) {
      const provider = this.resolveCommitProvider(providers);
      const available = Boolean(provider);
      return {
        ok: true,
        feature: FEATURE_COMMIT_MESSAGE,
        enabled: true,
        provider,
        available,
        providers,
        missing: available ? [] : ['claude', 'gemini'],
      };
    }

    if (safeFeature !== FEATURE_SUMMARY) {
      return {
        ok: false,
        feature: safeFeature,
        available: false,
        enabled: false,
        provider: '',
        providers,
        error: 'Unknown feature',
      };
    }

    const settings = this.getSettings();
    const summarySettings = this.getSummarySettings(settings);
    const providerId = this.normalizeProviderId(summarySettings.provider);
    const providerAvailable = Boolean(providers?.[providerId]?.available);
    const available = Boolean(summarySettings.enabled && providerAvailable);

    return {
      ok: true,
      feature: FEATURE_SUMMARY,
      available,
      enabled: summarySettings.enabled,
      provider: providerId,
      hasKey: providerId === 'gemini' ? Boolean(providers?.gemini?.hasKey) : false,
      providers,
    };
  }
}

module.exports = {
  ProviderCapabilityService,
  FEATURE_SUMMARY,
  FEATURE_COMMIT_MESSAGE,
};
