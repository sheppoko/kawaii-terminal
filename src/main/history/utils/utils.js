function normalizeSource(value, fallback = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized) return normalized;
  return String(fallback || '').trim().toLowerCase();
}

function getSessionId(session) {
  if (!session) return '';
  const raw = session.session_id ?? session.sessionId ?? session.id ?? '';
  return String(raw || '').trim();
}

function getSessionSource(session, fallback = '') {
  if (!session) return normalizeSource(fallback);
  return normalizeSource(session.source, fallback);
}

function getSessionKey(session, fallbackSource = '') {
  const source = getSessionSource(session, fallbackSource);
  const id = getSessionId(session);
  if (!source || !id) return '';
  return `${source}:${id}`;
}

function getSessionTimestamp(session) {
  if (!session) return 0;
  const last = Number(session.last_output_at ?? session.lastOutputAt ?? 0) || 0;
  const created = Number(session.created_at ?? session.createdAt ?? 0) || 0;
  return last || created || 0;
}

function getSessionCreatedAt(session) {
  if (!session) return 0;
  return Number(session.created_at ?? session.createdAt ?? 0) || 0;
}

function compareSessions(a, b) {
  const aLast = getSessionTimestamp(a);
  const bLast = getSessionTimestamp(b);
  if (aLast !== bLast) return bLast - aLast;
  const aCreated = getSessionCreatedAt(a);
  const bCreated = getSessionCreatedAt(b);
  if (aCreated !== bCreated) return bCreated - aCreated;
  const aId = getSessionId(a);
  const bId = getSessionId(b);
  if (aId === bId) return 0;
  return aId < bId ? -1 : 1;
}

function getSessionFingerprint(session) {
  if (!session) return '';
  const last = session.last_output_at ?? session.lastOutputAt ?? 0;
  const created = session.created_at ?? session.createdAt ?? 0;
  const input = session.input_preview ?? session.inputPreview ?? '';
  const output = session.output_preview ?? session.outputPreview ?? '';
  const cwd = session.cwd ?? '';
  const sourcePath = session.source_path ?? session.sourcePath ?? '';
  return [last, created, input, output, cwd, sourcePath].join('|');
}

function splitSessionKey(key) {
  const raw = String(key || '');
  const idx = raw.indexOf(':');
  if (idx <= 0) return { source: '', id: raw };
  return { source: raw.slice(0, idx), id: raw.slice(idx + 1) };
}

module.exports = {
  normalizeSource,
  getSessionId,
  getSessionSource,
  getSessionKey,
  getSessionTimestamp,
  getSessionCreatedAt,
  compareSessions,
  getSessionFingerprint,
  splitSessionKey,
};
