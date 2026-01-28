const path = require('path');

function isWslUncPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  const normalized = raw.replace(/\//g, '\\');
  return /^\\\\wsl(?:\\.localhost)?(?:\\$)?\\\\/i.test(normalized);
}

function extractWslDistroFromPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const normalized = raw.replace(/\//g, '\\');
  const match = normalized.match(/^\\\\wsl(?:\\.localhost)?(?:\\$)?\\\\([^\\]+)(?:\\\\|$)/i);
  if (!match) return '';
  return sanitizeFsSegment(match[1]);
}

function attachWslMetadata(block, { sourcePath, projectDir } = {}) {
  if (!block || typeof block !== 'object') return block;
  const source = typeof sourcePath === 'string' ? sourcePath.trim() : '';
  if (source) {
    block.source_path = source;
  }
  const candidates = [
    source,
    typeof projectDir === 'string' ? projectDir.trim() : '',
    typeof block.pane_id === 'string' ? block.pane_id.trim() : '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const distro = extractWslDistroFromPath(candidate);
    if (distro) {
      block.wsl_distro = distro;
      break;
    }
  }
  return block;
}

function toPosixPathMaybeWsl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw.replace(/\//g, '\\');
  const match = normalized.match(/^\\\\wsl(?:\\.localhost)?(?:\\$)?\\\\([^\\]+)(?:\\\\(.*))?$/i);
  if (match) {
    const rest = match[2] ? match[2].replace(/\\/g, '/') : '';
    return rest ? `/${rest.replace(/^\/+/, '')}` : '/';
  }
  if (raw.startsWith('/')) return raw;
  return null;
}

function sanitizeFsSegment(value, limit = 120) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw)) return '';
  return raw.slice(0, limit);
}

function normalizeDedupPaneId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const wslPosix = toPosixPathMaybeWsl(raw);
  let normalized = wslPosix || raw;
  normalized = normalized.replace(/\\/g, '/');
  normalized = normalized.replace(/^\/mnt\/([a-zA-Z])\//, (_, drive) => `${drive.toLowerCase()}:/`);
  normalized = normalized.replace(/^([a-zA-Z]):\//, (_, drive) => `${drive.toLowerCase()}:/`);
  normalized = normalized.replace(/\/+$/, '');
  return normalized;
}

function resolvePathInside(root, ...segments) {
  return path.join(root, ...segments);
}

module.exports = {
  attachWslMetadata,
  extractWslDistroFromPath,
  isWslUncPath,
  normalizeDedupPaneId,
  resolvePathInside,
  sanitizeFsSegment,
  toPosixPathMaybeWsl,
};
