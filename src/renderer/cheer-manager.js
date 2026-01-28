// 応援メッセージ管理
if (!window.kawaiiDebugLog) {
  window.kawaiiDebugLog = () => {};
}

// メッセージの検証（不適切なら null を返す）
function validateMessage(message, language) {
  if (!message) return null;

  // 300文字を超える場合は表示しない
  if (message.length > 300) {
    window.kawaiiDebugLog('[Cheer] Message too long, skipping:', message.length);
    return null;
  }

  // 日本語設定時: 70%以上が英字（A-Za-z）なら表示しない
  if (language === 'ja') {
    const letters = message.match(/[A-Za-z]/g) || [];
    const nonSpace = message.replace(/\s/g, '');
    const englishRatio = nonSpace.length > 0 ? letters.length / nonSpace.length : 0;
    if (englishRatio > 0.7) {
      window.kawaiiDebugLog('[Cheer] Too much English for ja setting, skipping:', englishRatio.toFixed(2));
      return null;
    }
  }

  return message;
}

function normalizeLanguage(value) {
  return value === 'ja' ? 'ja' : 'en';
}

function detectSystemLanguage() {
  try {
    const preferred = Array.isArray(navigator?.languages) && navigator.languages.length > 0
      ? navigator.languages[0]
      : navigator?.language;
    const lang = String(preferred || '').toLowerCase();
    return lang === 'ja' || lang.startsWith('ja-') ? 'ja' : 'en';
  } catch {
    return 'en';
  }
}

const DEFAULT_SETTINGS = {
  enabled: true,
  language: 'en',        // 'ja' | 'en'
  languageSource: 'auto', // 'auto' | 'user'
  minInterval: 1800,     // 秒（30分）
};

function normalizeCheerSettings(input, systemLanguage) {
  const baseLanguage = normalizeLanguage(systemLanguage);
  const raw = input && typeof input === 'object' ? input : {};
  const languageSource = raw.languageSource === 'user' ? 'user' : 'auto';
  let language = normalizeLanguage(raw.language || DEFAULT_SETTINGS.language);
  if (languageSource === 'auto') {
    language = baseLanguage;
  }
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_SETTINGS.enabled;
  const minIntervalRaw = Number(raw.minInterval);
  const minInterval = Number.isFinite(minIntervalRaw) ? Math.max(1, Math.round(minIntervalRaw)) : DEFAULT_SETTINGS.minInterval;
  return {
    enabled,
    language,
    languageSource,
    minInterval,
  };
}

const CHEER_AVAILABILITY_MESSAGES = {
  ready: {
    ja: '今日も一緒にがんばろうね！',
    en: "Let's do our best together today!",
  },
  missing: {
    ja: 'いまはおしゃべり準備中みたい...！Claude CLI を入れてくれたら、応援できるよ♪',
    en: "Hmm... I'm not ready to cheer yet. Install Claude CLI, and I can cheer you on!",
  },
};

function getPersonaMessage(type, language) {
  const lang = language === 'ja' ? 'ja' : 'en';
  return CHEER_AVAILABILITY_MESSAGES[type]?.[lang] || null;
}

function isAvatarPanelCollapsed() {
  // ステータスバーは常に表示されているので、常にfalseを返す
  return false;
}

class CheerManager {
  constructor(onMessage) {
    this.onMessage = onMessage; // メッセージ表示コールバック
    this.settings = normalizeCheerSettings(null, detectSystemLanguage());
    this.sessionId = null; // セッション継続用
    this.intervalTimer = null;
    this.isRequesting = false;
    this.lastEnterTime = null; // 最後のEnter時刻
    this.availability = { checked: false, available: false, missing: [] };
    this.hasAnnouncedAvailability = false;
    this.settingsUnsubscribe = null;

    // 固定間隔タイマー開始
    this.startIntervalTimer();
    this.ensureAvailability({ announce: true });

    this.refreshSettingsFromStore();
    if (window.settingsAPI?.onChange) {
      this.settingsUnsubscribe = window.settingsAPI.onChange((payload) => {
        if (payload?.settings) {
          this.applySettingsFromStore(payload.settings);
        }
      });
    }
  }

  // 固定間隔タイマー
  startIntervalTimer() {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
    }

    this.intervalTimer = setInterval(() => {
      if (!this.settings.enabled) return;
      if (this.isRequesting) return;
      if (!this.lastEnterTime) return; // 一度もEnterされてなければスキップ

      // パネルが閉じている時はスキップ（トークン節約）
      if (isAvatarPanelCollapsed()) {
        window.kawaiiDebugLog('[Cheer] Panel collapsed, skipping');
        return;
      }

      // 最後のEnterからタイマー間隔以内かチェック
      const elapsed = Date.now() - this.lastEnterTime;
      const intervalMs = this.settings.minInterval * 1000;

      if (elapsed <= intervalMs) {
        window.kawaiiDebugLog('[Cheer] Timer fired, last Enter was', Math.round(elapsed / 1000), 's ago');
        this.requestCheer();
      } else {
        window.kawaiiDebugLog('[Cheer] Timer fired but last Enter was', Math.round(elapsed / 1000), 's ago (> interval)');
      }
    }, this.settings.minInterval * 1000);
  }

  // コマンドが確定された（Enter押下）- 時刻を記録
  onCommandSubmit(command) {
    if (!this.settings.enabled) return;

    // パネルが閉じている場合は完全に休止（トークン節約）
    if (isAvatarPanelCollapsed()) return;

    if (command && command.length >= 2) {
      const isFirst = !this.lastEnterTime;
      this.lastEnterTime = Date.now();
      // 最初のコマンドは1秒後に応援
      if (isFirst && !this.isRequesting) {
        setTimeout(() => {
          if (!this.isRequesting) {
            this.requestCheer();
          }
        }, 1000);
      }
    }
  }

  applySettings(nextSettings) {
    const wasEnabled = this.settings.enabled;
    const intervalChanged = nextSettings.minInterval !== this.settings.minInterval;
    const languageChanged = nextSettings.language !== this.settings.language;

    this.settings = { ...nextSettings };

    if (languageChanged) {
      this.sessionId = null;
    }
    if (intervalChanged) {
      this.startIntervalTimer();
    }
    if (!wasEnabled && this.settings.enabled) {
      this.hasAnnouncedAvailability = false;
      this.ensureAvailability({ announce: true, force: true });
    }
  }

  async refreshSettingsFromStore() {
    if (!window.settingsAPI?.get) return;
    try {
      const settings = await window.settingsAPI.get();
      if (settings) {
        this.applySettingsFromStore(settings);
      }
    } catch (_) {
      // ignore
    }
  }

  applySettingsFromStore(settings) {
    const systemLanguage = detectSystemLanguage();
    const cheer = normalizeCheerSettings(settings?.cheer, systemLanguage);
    this.applySettings(cheer);

    const patch = {};
    const storedCheer = settings?.cheer || null;
    if (!storedCheer
      || storedCheer.enabled !== cheer.enabled
      || storedCheer.language !== cheer.language
      || storedCheer.languageSource !== cheer.languageSource
      || storedCheer.minInterval !== cheer.minInterval) {
      patch.cheer = cheer;
    }
    const summaryLanguage = settings?.summaries?.language;
    if (summaryLanguage !== cheer.language) {
      patch.summaries = { language: cheer.language };
    }
    if (window.settingsAPI?.update && Object.keys(patch).length > 0) {
      window.settingsAPI.update(patch);
    }
  }

  updateSettings(newSettings) {
    const hasLanguageUpdate = Object.prototype.hasOwnProperty.call(newSettings, 'language');
    const languageSource = hasLanguageUpdate ? 'user' : this.settings.languageSource;
    const merged = {
      ...this.settings,
      ...newSettings,
      language: hasLanguageUpdate ? normalizeLanguage(newSettings.language) : this.settings.language,
      languageSource,
    };
    const nextSettings = normalizeCheerSettings(merged, detectSystemLanguage());
    this.applySettings(nextSettings);

    if (window.settingsAPI?.update) {
      window.settingsAPI.update({
        cheer: { ...nextSettings },
        summaries: { language: nextSettings.language },
      });
    }
  }

  getSettings() {
    return { ...this.settings };
  }

  // 応援リクエスト送信
  async requestCheer() {
    if (!this.settings.enabled) return;
    if (this.isRequesting) return;

    // 表示できない時は生成しない（トークン節約）
    if (isAvatarPanelCollapsed()) return;

    window.kawaiiDebugLog('[Cheer] Requesting cheer, session_id:', this.sessionId || '(new)');

    this.isRequesting = true;

    try {
      if (!this.availability.checked) {
        await this.ensureAvailability();
      }

      if (!this.availability.available) {
        if (!this.hasAnnouncedAvailability) {
          const msg = getPersonaMessage('missing', this.settings.language);
          if (msg) this.onMessage(msg);
          this.hasAnnouncedAvailability = true;
        }
        return;
      }

      const result = await window.cheerAPI.generate(
        this.settings.language,
        this.sessionId
      );
      window.kawaiiDebugLog('[Cheer] Result:', result);

      if (result?.unavailable) {
        this.availability = {
          checked: true,
          available: false,
          missing: Array.isArray(result.missing) ? result.missing : [],
        };
        if (!this.hasAnnouncedAvailability) {
          const msg = getPersonaMessage('missing', this.settings.language);
          if (msg) this.onMessage(msg);
          this.hasAnnouncedAvailability = true;
        }
        return;
      }

      if (result.message) {
        const validated = validateMessage(result.message, this.settings.language);
        if (validated) {
          this.onMessage(validated);
        }
        // session_idを保存（次回継続用）
        if (result.session_id) {
          this.sessionId = result.session_id;
        }
      } else if (result.error) {
        console.error('[Cheer] Error:', result.error);
        // エラー時はセッションをリセット
        this.sessionId = null;
      }
    } catch (e) {
      console.error('[Cheer] Request failed:', e);
      this.sessionId = null;
    } finally {
      this.isRequesting = false;
    }
  }

  async ensureAvailability({ announce = false, force = false } = {}) {
    if (!window.cheerAPI?.checkAvailability) return this.availability;
    if (this.availability.checked && !force) return this.availability;

    // パネルが閉じている間は、UI表示前提のアナウンスをしない
    if (announce && isAvatarPanelCollapsed()) {
      announce = false;
    }

    try {
      const result = await window.cheerAPI.checkAvailability();
      const available = Boolean(result?.available);
      const missing = Array.isArray(result?.missing) ? result.missing : [];
      this.availability = { checked: true, available, missing };

      if (announce && this.settings.enabled && !this.hasAnnouncedAvailability) {
        const msg = getPersonaMessage(available ? 'ready' : 'missing', this.settings.language);
        if (msg) this.onMessage(msg);
        this.hasAnnouncedAvailability = true;
      }
    } catch (e) {
      // Fail silently; cheer will try later
    }

    return this.availability;
  }
}

window.CheerManager = CheerManager;
