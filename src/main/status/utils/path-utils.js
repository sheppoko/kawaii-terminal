function normalizeCwd(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const normalizedSlashes = raw.replace(/\//g, '\\');
  const wslMatch = normalizedSlashes.match(/^\\\\wsl(?:\\.localhost)?(?:\\$)?\\\\([^\\]+)(?:\\\\(.*))?$/i);
  let normalized = raw.replace(/\\/g, '/');
  if (wslMatch) {
    const rest = wslMatch[2] ? wslMatch[2].replace(/\\/g, '/') : '';
    normalized = rest ? `/${rest.replace(/^\/+/, '')}` : '/';
  }
  if (!normalized.startsWith('/') && !/^[A-Za-z]:\//.test(normalized)) {
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length > 1) {
      const rest = parts.slice(1).join('/');
      if (/^(home|mnt|usr|opt|var|etc|srv|root|tmp)\b/.test(rest)) {
        normalized = `/${rest}`;
      }
    }
  }
  normalized = normalized.replace(/^\/mnt\/([a-zA-Z])\//, (_, drive) => `${drive.toLowerCase()}:/`);
  normalized = normalized.replace(/^([a-zA-Z]):\//, (_, drive) => `${drive.toLowerCase()}:/`);
  normalized = normalized.replace(/\/+$/, '');
  return normalized;
}

module.exports = {
  normalizeCwd,
};
