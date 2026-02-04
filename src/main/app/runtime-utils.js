const crypto = require('crypto');

function createSessionKey() {
  try {
    return `w-${crypto.randomUUID()}`;
  } catch (_) {
    return `w-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function getResetOptionsFromArgs(argv = process.argv) {
  let resetRequested = false;
  let rollbackClaude = false;
  for (const arg of argv || []) {
    if (arg === '--kawaii-reset' || String(arg || '').startsWith('--kawaii-reset=')) {
      resetRequested = true;
    }
    if (arg === '--kawaii-reset-claude' || arg === '--kawaii-reset-claude=1') {
      rollbackClaude = true;
    }
  }
  if (!resetRequested) return null;
  return { rollbackClaude };
}

function stripResetArgs(argv = process.argv) {
  return (argv || []).filter((arg) => {
    const raw = String(arg || '');
    if (raw === '--kawaii-reset' || raw.startsWith('--kawaii-reset=')) return false;
    if (raw === '--kawaii-reset-claude' || raw === '--kawaii-reset-claude=1') return false;
    return true;
  });
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const int = Math.floor(num);
  return Math.min(max, Math.max(min, int));
}

function normalizeTabId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 160) return null;
  // dataset/tabId用途なので、制御文字やスペースは拒否
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(trimmed)) return null;
  return trimmed;
}

module.exports = {
  clampInt,
  createSessionKey,
  getResetOptionsFromArgs,
  normalizeTabId,
  stripResetArgs,
};
