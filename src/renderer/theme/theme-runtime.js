(() => {
  const DEFAULT_THEME = 'dark';
  let currentTheme = DEFAULT_THEME;

  const dispatchThemeChange = (detail) => {
    window.dispatchEvent(new CustomEvent('kawaii-theme-change', { detail }));
  };

  const resolveThemeName = (name) => {
    if (typeof name === 'string' && name.trim()) return name.trim();
    return DEFAULT_THEME;
  };

  const loadTheme = async (name, { persist = true } = {}) => {
    const themeName = resolveThemeName(name);
    const theme = await window.KawaiiTheme.loadTheme(`theme/themes/${themeName}.json`);
    currentTheme = themeName;
    if (persist && window.settingsAPI?.update) {
      window.settingsAPI.update({ theme: { name: themeName } });
    }
    dispatchThemeChange({ name: themeName, theme });
    return theme;
  };

  const init = async () => {
    let saved = null;
    try {
      if (window.settingsAPI?.get) {
        const settings = await window.settingsAPI.get();
        saved = settings?.theme?.name || null;
      }
    } catch (_) {
      saved = null;
    }
    const initial = resolveThemeName(saved);
    try {
      await loadTheme(initial, { persist: !saved });
    } catch (err) {
      console.error('[theme-runtime] Failed to load theme:', err);
      if (initial !== DEFAULT_THEME) {
        try {
          await loadTheme(DEFAULT_THEME, { persist: true });
        } catch (fallbackErr) {
          console.error('[theme-runtime] Failed to load default theme:', fallbackErr);
        }
      }
    }

    if (window.settingsAPI?.onChange) {
      window.settingsAPI.onChange((payload) => {
        const next = resolveThemeName(payload?.settings?.theme?.name);
        if (next !== currentTheme) {
          loadTheme(next, { persist: false }).catch(() => {});
        }
      });
    }
  };

  window.KawaiiThemeRuntime = {
    loadTheme,
    getCurrentTheme: () => currentTheme,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    void init();
  }
})();
