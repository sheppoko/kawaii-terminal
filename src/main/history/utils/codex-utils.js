const crypto = require('crypto');

function formatUuidFromBytes(bytes) {
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function generateUuidV7() {
  if (!crypto?.randomBytes) return '';
  try {
    const bytes = crypto.randomBytes(16);
    const ts = BigInt(Date.now());
    bytes[0] = Number((ts >> 40n) & 0xffn);
    bytes[1] = Number((ts >> 32n) & 0xffn);
    bytes[2] = Number((ts >> 24n) & 0xffn);
    bytes[3] = Number((ts >> 16n) & 0xffn);
    bytes[4] = Number((ts >> 8n) & 0xffn);
    bytes[5] = Number(ts & 0xffn);
    // Set version (7) and RFC 4122 variant.
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return formatUuidFromBytes(bytes);
  } catch (_) {
    return '';
  }
}

function buildTimeMachineSessionId() {
  const v7 = generateUuidV7();
  if (v7) return v7;
  if (crypto?.randomUUID) {
    return crypto.randomUUID();
  }
  return `tm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeCodexText(value) {
  return String(value || '').replace(/\\r\\n/g, '\\n').trim();
}

function isTargetCodexUserMessage(msg, targetInput, targetTimestamp) {
  if (!msg || msg.role !== 'user') return false;
  const text = normalizeCodexText(msg.text);
  const input = normalizeCodexText(targetInput);
  const textMatches = input && text === input;
  const ts = Number(msg.timestamp || 0);
  const targetTs = Number(targetTimestamp || 0);
  const timeMatches = ts && targetTs && Math.abs(ts - targetTs) < 2000;
  return Boolean(textMatches || timeMatches);
}

function isUuidLike(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (/^[0-9a-f]{32}$/i.test(raw)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return true;
  return false;
}

function extractCodexCwd(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const meta = entry.meta || entry.metadata || entry.context || {};
  const candidates = [
    entry.cwd,
    entry.workdir,
    entry.working_directory,
    entry.project_path,
    entry.projectPath,
    entry.repo_path,
    entry.repoPath,
    meta.cwd,
    meta.workdir,
    meta.working_directory,
    meta.project_path,
    meta.projectPath,
    meta.repo_path,
    meta.repoPath,
  ];
  for (const candidate of candidates) {
    const raw = String(candidate || '').trim();
    if (raw) return raw;
  }
  return '';
}

function buildSyntheticCodexSessionMeta({ entries, newSessionId, forkedFromId, now } = {}) {
  const timestampMs = Number.isFinite(now) ? now : Date.now();
  const timestamp = new Date(timestampMs).toISOString();
  let basePayload = null;
  for (const entry of entries || []) {
    if (entry?.type === 'session_meta' && entry.payload && typeof entry.payload === 'object') {
      basePayload = { ...entry.payload };
      break;
    }
  }

  const payload = basePayload ? { ...basePayload } : {};
  payload.id = newSessionId;
  payload.timestamp = timestamp;
  const forked = String(forkedFromId || '').trim();
  if (forked && isUuidLike(forked)) {
    payload.forked_from_id = forked;
  } else if (Object.prototype.hasOwnProperty.call(payload, 'forked_from_id')) {
    delete payload.forked_from_id;
  }

  if (!payload.cwd || !String(payload.cwd).trim()) {
    let cwd = '';
    for (const entry of entries || []) {
      cwd = extractCodexCwd(entry?.payload || entry) || '';
      if (cwd) break;
    }
    payload.cwd = cwd || '';
  }

  const originator = String(payload.originator || '').trim();
  const cliVersion = String(payload.cli_version || '').trim();
  const source = String(payload.source || '').trim();
  payload.originator = originator || 'codex_cli_rs';
  payload.cli_version = cliVersion || '0.0.0';
  payload.source = source || 'cli';

  return { timestamp, type: 'session_meta', payload };
}

module.exports = {
  buildSyntheticCodexSessionMeta,
  buildTimeMachineSessionId,
  extractCodexCwd,
  isTargetCodexUserMessage,
  isUuidLike,
  normalizeCodexText,
};
