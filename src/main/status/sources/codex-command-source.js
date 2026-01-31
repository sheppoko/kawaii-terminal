function stripOuterQuotes(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function splitCommandTokens(command) {
  const tokens = [];
  const raw = String(command || '');
  const pattern = /"([^"]*)"|'([^']*)'|\S+/g;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    tokens.push(match[1] || match[2] || match[0]);
  }
  return tokens;
}

const { normalizeCwd } = require('../utils/path-utils');

const CODEX_HELP_FLAGS = new Set(['-h', '--help', '-V', '--version']);
const CODEX_FLAGS_WITH_VALUE = new Set([
  '-m',
  '--model',
  '-c',
  '--config',
  '-C',
  '--cwd',
  '--project',
  '--profile',
  '--session',
  '--id',
  '-e',
  '--env',
  '--output',
  '--input',
]);
const CODEX_NON_TUI_SUBCOMMANDS = new Set([
  'completion',
  'exec',
  'e',
  'review',
  'login',
  'logout',
  'apply',
  'a',
  'mcp',
  'mcp-server',
  'app-server',
  'sandbox',
  'debug',
  'execpolicy',
  'cloud',
  'cloud-tasks',
  'features',
  'responses-api-proxy',
  'stdio-to-uds',
]);
const CODEX_PENDING_NEGATIVE_SKEW_MS = 5000;

function isCodexExecutable(token) {
  const raw = stripOuterQuotes(token).replace(/\\/g, '/');
  if (!raw) return false;
  const base = raw.split('/').pop() || '';
  const lower = base.toLowerCase();
  return lower === 'codex' || lower === 'codex.exe' || lower === 'codex.cmd' || lower === 'codex.bat';
}

function extractResumeSessionId(tokens, startIndex, endIndex) {
  if (!Array.isArray(tokens) || startIndex < 0) return '';
  const end = Number.isFinite(endIndex) ? endIndex : tokens.length;
  for (let i = startIndex + 1; i < end; i += 1) {
    const raw = stripOuterQuotes(tokens[i]);
    if (!raw) continue;
    if (raw === '--') continue;
    if (raw.startsWith('-')) continue;
    return raw;
  }
  return '';
}

function isEnvAssignment(token) {
  const raw = stripOuterQuotes(token);
  if (!raw) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw);
}

const COMMAND_SEPARATORS = new Set(['|', '||', '&&', ';', '&']);

function findCommandEnd(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const raw = stripOuterQuotes(tokens[i]);
    if (COMMAND_SEPARATORS.has(raw)) return i;
  }
  return tokens.length;
}

function skipWrapperFlags(tokens, index, endIndex) {
  let i = index;
  while (i < endIndex) {
    const raw = stripOuterQuotes(tokens[i]);
    if (!raw) {
      i += 1;
      continue;
    }
    if (raw === '--') return i + 1;
    if (raw.startsWith('-')) {
      i += 1;
      continue;
    }
    return i;
  }
  return i;
}

function unwrapCommandTokenIndex(tokens, startIndex, endIndex) {
  let i = startIndex;
  let safety = 0;
  while (i < endIndex && safety < 12) {
    safety += 1;
    while (i < endIndex && isEnvAssignment(tokens[i])) {
      i += 1;
    }
    const raw = stripOuterQuotes(tokens[i]);
    if (!raw) {
      i += 1;
      continue;
    }
    const lower = raw.toLowerCase();
    if (lower === 'env') {
      i += 1;
      i = skipWrapperFlags(tokens, i, endIndex);
      continue;
    }
    if (lower === 'command') {
      i += 1;
      i = skipWrapperFlags(tokens, i, endIndex);
      continue;
    }
    if (lower === 'sudo') {
      i += 1;
      i = skipWrapperFlags(tokens, i, endIndex);
      if (i < endIndex && stripOuterQuotes(tokens[i]).toLowerCase() === '-u') {
        i += 2;
      }
      continue;
    }
    if (lower === 'nohup') {
      i += 1;
      continue;
    }
    if (lower === 'nice') {
      i += 1;
      if (i < endIndex && /^[-+]?\d+$/.test(stripOuterQuotes(tokens[i]))) {
        i += 1;
      }
      continue;
    }
    if (lower === 'npx' || lower === 'pnpx' || lower === 'bunx') {
      i += 1;
      i = skipWrapperFlags(tokens, i, endIndex);
      continue;
    }
    if (lower === 'pnpm' || lower === 'npm' || lower === 'yarn') {
      i += 1;
      const next = stripOuterQuotes(tokens[i]).toLowerCase();
      if (next === 'dlx' || next === 'exec') {
        i += 1;
      }
      i = skipWrapperFlags(tokens, i, endIndex);
      continue;
    }
    break;
  }
  return i;
}

function findCodexTokenIndex(tokens) {
  const endIndex = findCommandEnd(tokens);
  const startIndex = unwrapCommandTokenIndex(tokens, 0, endIndex);
  if (startIndex >= endIndex) return { index: -1, endIndex };
  const token = tokens[startIndex];
  if (isCodexExecutable(token)) {
    return { index: startIndex, endIndex };
  }
  return { index: -1, endIndex };
}

function parseCodexCommand(command) {
  const tokens = splitCommandTokens(command);
  if (!tokens.length) return null;
  const { index: codexIndex, endIndex } = findCodexTokenIndex(tokens);
  if (codexIndex < 0) return null;
  const hasHelp = tokens
    .slice(codexIndex + 1, endIndex)
    .some((token) => CODEX_HELP_FLAGS.has(stripOuterQuotes(token)));
  if (hasHelp) {
    return { isCodex: true, isTuiCandidate: false, subcommand: 'help' };
  }
  let subcommand = '';
  let sessionId = '';
  for (let i = codexIndex + 1; i < endIndex; i += 1) {
    const raw = stripOuterQuotes(tokens[i]);
    if (!raw) continue;
    if (raw === '--') break;
    if (raw.startsWith('-')) {
      const lowerFlag = raw.toLowerCase();
      if (CODEX_FLAGS_WITH_VALUE.has(lowerFlag) && i + 1 < endIndex) {
        i += 1;
      }
      continue;
    }
    const lower = raw.toLowerCase();
    if (lower === 'resume') {
      sessionId = extractResumeSessionId(tokens, i, endIndex);
      return { isCodex: true, isTuiCandidate: true, subcommand: 'resume', sessionId };
    }
    if (lower === 'fork') {
      return { isCodex: true, isTuiCandidate: true, subcommand: 'fork', sessionId: '' };
    }
    if (CODEX_NON_TUI_SUBCOMMANDS.has(lower)) {
      return { isCodex: true, isTuiCandidate: false, subcommand: lower };
    }
    subcommand = lower;
    break;
  }
  return { isCodex: true, isTuiCandidate: true, subcommand };
}

class CodexCommandSource {
  constructor({ statusService } = {}) {
    this.statusService = statusService || null;
    this.pending = new Map();
  }

  handleCommand({ paneId, command, cwd } = {}) {
    const pid = String(paneId || '').trim();
    if (!pid) return;
    const parsed = parseCodexCommand(command);
    if (!parsed || !parsed.isCodex || !parsed.isTuiCandidate) {
      this.clearPendingForPane(pid);
      return;
    }
    if (parsed.subcommand === 'resume' && parsed.sessionId) {
      this.clearPendingForPane(pid);
      this.statusService?.bindSessionToPane?.({ source: 'codex', sessionId: parsed.sessionId, paneId: pid });
      return;
    }
    const now = Date.now();
    const normalized = normalizeCwd(cwd);
    this.pending.set(pid, { startedAt: now, cwd: normalized });
  }

  clearPendingForPane(paneId) {
    const pid = String(paneId || '').trim();
    if (!pid) return false;
    if (!this.pending.has(pid)) return false;
    this.pending.delete(pid);
    return true;
  }

  matchPendingLaunch({ sessionId, activityAt, sessionCwd, ttlMs = 120000 } = {}) {
    const sid = String(sessionId || '').trim();
    const at = Number(activityAt || 0);
    if (!sid || !Number.isFinite(at) || this.pending.size === 0) return false;
    const normalizedSessionCwd = normalizeCwd(sessionCwd);
    let bestPane = '';
    let bestPositive = Infinity;
    let bestAbs = Infinity;
    const entries = Array.from(this.pending.entries());
    let hadMismatch = false;
    for (let i = 0; i < entries.length; i += 1) {
      const [paneId, info] = entries[i];
      const startedAt = Number(info?.startedAt || info || 0);
      const pendingCwd = normalizeCwd(info?.cwd);
      if (normalizedSessionCwd && pendingCwd && pendingCwd !== normalizedSessionCwd) {
        hadMismatch = true;
        continue;
      }
      const delta = at - startedAt;
      if (delta < -CODEX_PENDING_NEGATIVE_SKEW_MS) continue;
      if (delta >= 0) {
        if (delta < bestPositive) {
          bestPositive = delta;
          bestPane = paneId;
        }
      } else if (bestPositive === Infinity) {
        const abs = Math.abs(delta);
        if (abs < bestAbs) {
          bestAbs = abs;
          bestPane = paneId;
        }
      }
    }
    if (!bestPane) {
      if (hadMismatch && Number.isFinite(ttlMs) && ttlMs > 0) {
        this.prunePending({ ttlMs });
      }
      return false;
    }
    this.pending.delete(bestPane);
    this.statusService?.bindSessionToPane?.({ source: 'codex', sessionId: sid, paneId: bestPane });
    return true;
  }

  prunePending({ ttlMs = 120000 } = {}) {
    const now = Date.now();
    for (const [paneId, startedAt] of this.pending.entries()) {
      const ts = Number(startedAt?.startedAt || startedAt || 0);
      if (now - ts > ttlMs) this.pending.delete(paneId);
    }
  }
}

module.exports = {
  CodexCommandSource,
  parseCodexCommand,
};
