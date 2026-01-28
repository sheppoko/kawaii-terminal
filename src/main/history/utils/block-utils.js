function buildSourceBlockId(source, rawId) {
  const id = String(rawId || '').trim();
  if (!id) return '';
  const prefix = String(source || '').trim().toLowerCase();
  if (!prefix) return id;
  const token = `${prefix}:`;
  return id.startsWith(token) ? id : `${prefix}:${id}`;
}

function stripSourcePrefix(source, value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const prefix = String(source || '').trim().toLowerCase();
  if (!prefix) return raw;
  const token = `${prefix}:`;
  return raw.startsWith(token) ? raw.slice(token.length) : raw;
}

function parseTimestampMs(value) {
  if (value == null) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 0 && value < 1e12) return Math.round(value * 1000);
    return Math.round(value);
  }
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    if (numeric > 0 && numeric < 1e12) return Math.round(numeric * 1000);
    return Math.round(numeric);
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function hashString(value) {
  const text = String(value || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function buildFallbackId(prefix, inputText, outputText, createdAt) {
  const seed = `${createdAt || ''}|${String(inputText || '').slice(0, 200)}|${String(outputText || '').slice(0, 200)}`;
  const base = prefix ? String(prefix).trim() : 'entry';
  return `${base}-${hashString(seed)}`;
}

module.exports = {
  buildSourceBlockId,
  stripSourcePrefix,
  parseTimestampMs,
  hashString,
  buildFallbackId,
};
