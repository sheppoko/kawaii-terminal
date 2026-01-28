(() => {
  const DEFAULT_PREFIX = 'kt';
  const TOKEN_REF = /^\{(.+)\}$/;

  const isPlainObject = (value) => {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return false;
    return Object.prototype.toString.call(value) === '[object Object]';
  };

  const toCssVarName = (token, prefix = DEFAULT_PREFIX) => {
    return `--${prefix}-${token.replace(/\./g, '-')}`;
  };

  const flatten = (obj, path, out) => {
    Object.entries(obj).forEach(([key, value]) => {
      const nextPath = path.concat(key);
      if (isPlainObject(value)) {
        flatten(value, nextPath, out);
        return;
      }
      out.push([nextPath.join('.'), value]);
    });
  };

  const resolveValue = (value, prefix = DEFAULT_PREFIX) => {
    if (typeof value !== 'string') return value;
    const match = value.match(TOKEN_REF);
    if (!match) return value;
    return `var(${toCssVarName(match[1], prefix)})`;
  };

  const applyTheme = (theme, options = {}) => {
    const target = options.target || document.documentElement;
    const prefix = options.prefix || DEFAULT_PREFIX;
    const sections = ['color', 'type', 'space', 'radius', 'shadow', 'size', 'icon', 'cursor'];
    const entries = [];

    sections.forEach((section) => {
      if (!theme[section]) return;
      flatten(theme[section], [section], entries);
    });

    entries.forEach(([token, raw]) => {
      const value = resolveValue(raw, prefix);
      const cssValue = String(value);
      target.style.setProperty(toCssVarName(token, prefix), cssValue);

      // No legacy aliasing (Carbon/Fluent) - keep tokens explicit.
    });

    if (theme.name) {
      target.setAttribute('data-theme', theme.name);
    }

    return { tokensApplied: entries.length };
  };

  const loadTheme = async (url, options = {}) => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load theme: ${response.status} ${response.statusText}`);
    }
    const theme = await response.json();
    applyTheme(theme, options);
    return theme;
  };

  window.KawaiiTheme = {
    applyTheme,
    loadTheme,
    toCssVarName,
  };
})();
