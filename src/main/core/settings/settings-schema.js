const DEFAULT_SETTINGS = {
  schemaVersion: 2,
  onboarding: {
    dismissedVersion: 0,
  },
  summaries: {
    enabled: true,
    provider: 'gemini',
    language: 'ja',
    showInPane: true,
    gemini: {
      apiKey: '',
      model: 'gemini-2.5-flash-lite',
    },
    claude: {
      model: 'claude-haiku-4-5',
    },
  },
  cheer: {
    enabled: true,
    language: 'en',
    languageSource: 'auto',
    minInterval: 1800,
  },
  terminal: {
    fontSize: 14,
    fontFamily: '"HackGen Console NF", Consolas, monospace',
    scrollback: 5000,
    webglEnabled: true,
  },
  theme: {
    name: 'dark',
  },
  shortcuts: {
    version: 1,
    mac: {},
    win: {},
  },
};

const isPlainObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value);

const deepClone = (value) => JSON.parse(JSON.stringify(value));

const deepMerge = (target, source) => {
  if (!isPlainObject(target)) return deepClone(source);
  if (!isPlainObject(source)) return target;
  Object.entries(source).forEach(([key, value]) => {
    if (value === undefined) return;
    if (Array.isArray(value)) {
      target[key] = value.slice();
      return;
    }
    if (isPlainObject(value)) {
      const base = isPlainObject(target[key]) ? target[key] : {};
      target[key] = deepMerge({ ...base }, value);
      return;
    }
    target[key] = value;
  });
  return target;
};

function normalizeSettings(raw) {
  const base = deepClone(DEFAULT_SETTINGS);
  const merged = isPlainObject(raw) ? deepMerge(base, raw) : base;

  if (!Number.isFinite(merged.schemaVersion)) {
    merged.schemaVersion = DEFAULT_SETTINGS.schemaVersion;
  }
  if (!isPlainObject(merged.onboarding)) {
    merged.onboarding = deepClone(DEFAULT_SETTINGS.onboarding);
  }
  if (!Number.isFinite(merged.onboarding.dismissedVersion)) {
    merged.onboarding.dismissedVersion = DEFAULT_SETTINGS.onboarding.dismissedVersion;
  }
  if (!isPlainObject(merged.summaries)) {
    merged.summaries = deepClone(DEFAULT_SETTINGS.summaries);
  }
  if (typeof merged.summaries.enabled !== 'boolean') {
    merged.summaries.enabled = DEFAULT_SETTINGS.summaries.enabled;
  }
  if (typeof merged.summaries.provider !== 'string') {
    merged.summaries.provider = DEFAULT_SETTINGS.summaries.provider;
  }
  if (typeof merged.summaries.language !== 'string') {
    merged.summaries.language = DEFAULT_SETTINGS.summaries.language;
  }
  if (typeof merged.summaries.showInPane !== 'boolean') {
    merged.summaries.showInPane = DEFAULT_SETTINGS.summaries.showInPane;
  }
  if (!isPlainObject(merged.summaries.gemini)) {
    merged.summaries.gemini = deepClone(DEFAULT_SETTINGS.summaries.gemini);
  }
  if (typeof merged.summaries.gemini.apiKey !== 'string') {
    merged.summaries.gemini.apiKey = DEFAULT_SETTINGS.summaries.gemini.apiKey;
  }
  if (typeof merged.summaries.gemini.model !== 'string') {
    merged.summaries.gemini.model = DEFAULT_SETTINGS.summaries.gemini.model;
  }
  if (!isPlainObject(merged.summaries.claude)) {
    merged.summaries.claude = deepClone(DEFAULT_SETTINGS.summaries.claude);
  }
  if (typeof merged.summaries.claude.model !== 'string') {
    merged.summaries.claude.model = DEFAULT_SETTINGS.summaries.claude.model;
  }
  if (!isPlainObject(merged.cheer)) {
    merged.cheer = deepClone(DEFAULT_SETTINGS.cheer);
  }
  if (typeof merged.cheer.enabled !== 'boolean') {
    merged.cheer.enabled = DEFAULT_SETTINGS.cheer.enabled;
  }
  if (typeof merged.cheer.language !== 'string') {
    merged.cheer.language = DEFAULT_SETTINGS.cheer.language;
  }
  if (typeof merged.cheer.languageSource !== 'string') {
    merged.cheer.languageSource = DEFAULT_SETTINGS.cheer.languageSource;
  }
  if (!Number.isFinite(merged.cheer.minInterval)) {
    merged.cheer.minInterval = DEFAULT_SETTINGS.cheer.minInterval;
  }
  if (!isPlainObject(merged.terminal)) {
    merged.terminal = deepClone(DEFAULT_SETTINGS.terminal);
  }
  if (!Number.isFinite(merged.terminal.fontSize)) {
    merged.terminal.fontSize = DEFAULT_SETTINGS.terminal.fontSize;
  }
  if (typeof merged.terminal.fontFamily !== 'string') {
    merged.terminal.fontFamily = DEFAULT_SETTINGS.terminal.fontFamily;
  } else if (!merged.terminal.fontFamily.trim()) {
    merged.terminal.fontFamily = DEFAULT_SETTINGS.terminal.fontFamily;
  }
  if (!Number.isFinite(merged.terminal.scrollback)) {
    merged.terminal.scrollback = DEFAULT_SETTINGS.terminal.scrollback;
  }
  if (typeof merged.terminal.webglEnabled !== 'boolean') {
    merged.terminal.webglEnabled = DEFAULT_SETTINGS.terminal.webglEnabled;
  }
  if (!isPlainObject(merged.theme)) {
    merged.theme = deepClone(DEFAULT_SETTINGS.theme);
  }
  if (typeof merged.theme.name !== 'string') {
    merged.theme.name = DEFAULT_SETTINGS.theme.name;
  }
  if (!isPlainObject(merged.shortcuts)) {
    merged.shortcuts = deepClone(DEFAULT_SETTINGS.shortcuts);
  }
  if (!Number.isFinite(merged.shortcuts.version)) {
    merged.shortcuts.version = DEFAULT_SETTINGS.shortcuts.version;
  }
  if (!isPlainObject(merged.shortcuts.mac)) {
    merged.shortcuts.mac = deepClone(DEFAULT_SETTINGS.shortcuts.mac);
  }
  if (!isPlainObject(merged.shortcuts.win)) {
    merged.shortcuts.win = deepClone(DEFAULT_SETTINGS.shortcuts.win);
  }

  return merged;
}

module.exports = {
  DEFAULT_SETTINGS,
  deepMerge,
  deepClone,
  normalizeSettings,
};
