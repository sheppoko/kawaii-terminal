const fs = require('fs');
const os = require('os');
const path = require('path');
const { listWslHomes } = require('../../history/infra/wsl-homes');
const {
  resolveClaudeConfigRoot,
  resolveClaudeSettingsPath,
  resolveCodexConfigRoot,
} = require('../../infra/path/agent-paths');

const REQUIRED_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SessionEnd',
];

const LEGACY_NOTIFY_PATH_SEGMENT = '/scripts/notify/kawaii-notify';

const isDirectory = (dirPath) => {
  if (!dirPath) return false;
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch (_) {
    return false;
  }
};

const safeReadJson = (filePath) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
};

const extractHookCommands = (entry) => {
  if (!entry) return [];
  if (typeof entry === 'string') return [entry];
  if (typeof entry.command === 'string') return [entry.command];
  if (Array.isArray(entry.hooks)) {
    return entry.hooks
      .filter(hook => hook && typeof hook === 'object')
      .map(hook => hook.command)
      .filter(cmd => typeof cmd === 'string');
  }
  return [];
};

const hasKawaiiNotifyForEvent = (command, eventName) => {
  const raw = String(command || '').trim().toLowerCase();
  if (!raw) return false;
  if (!raw.includes('kawaii-notify')) return false;
  const hookToken = `--hook ${String(eventName || '').trim().toLowerCase()}`;
  return raw.includes(hookToken);
};

const normalizeCommandPath = (command) =>
  String(command || '').trim().toLowerCase().replace(/\\/g, '/');

const isLegacyNotifyCommand = (command) => {
  const normalized = normalizeCommandPath(command);
  if (!normalized) return false;
  return normalized.includes(LEGACY_NOTIFY_PATH_SEGMENT);
};

const getClaudeHookStatus = (settingsPath) => {
  if (!settingsPath) {
    return { status: 'unavailable', missingEvents: REQUIRED_HOOK_EVENTS.slice() };
  }
  if (!fs.existsSync(settingsPath)) {
    return { status: 'missing', missingEvents: REQUIRED_HOOK_EVENTS.slice() };
  }
  const config = safeReadJson(settingsPath);
  if (!config || typeof config !== 'object') {
    return { status: 'error', missingEvents: REQUIRED_HOOK_EVENTS.slice() };
  }
  const hooks = config.hooks || {};
  const missing = [];
  let hitCount = 0;
  const legacyEvents = new Set();
  for (const eventName of REQUIRED_HOOK_EVENTS) {
    const entries = Array.isArray(hooks[eventName]) ? hooks[eventName] : (hooks[eventName] ? [hooks[eventName]] : []);
    const commands = entries.flatMap(extractHookCommands);
    const matches = commands.filter(cmd => hasKawaiiNotifyForEvent(cmd, eventName));
    const hasLegacy = matches.some(cmd => isLegacyNotifyCommand(cmd));
    if (hasLegacy) legacyEvents.add(eventName);
    const hasCurrent = matches.some(cmd => !isLegacyNotifyCommand(cmd));
    if (hasCurrent) {
      hitCount += 1;
    } else {
      missing.push(eventName);
    }
  }
  if (legacyEvents.size > 0) {
    const legacyMissing = new Set([...missing, ...legacyEvents]);
    return { status: hitCount > 0 ? 'partial' : 'missing', missingEvents: Array.from(legacyMissing) };
  }
  if (hitCount === REQUIRED_HOOK_EVENTS.length) {
    return { status: 'configured', missingEvents: [] };
  }
  if (hitCount > 0) {
    return { status: 'partial', missingEvents: missing };
  }
  return { status: 'missing', missingEvents: missing };
};

const aggregateHookStatus = (entries) => {
  const statusCounts = { configured: 0, partial: 0, missing: 0, error: 0 };
  const missingEvents = new Set();
  for (const entry of entries) {
    if (!entry) continue;
    const { status, missingEvents: missing = [] } = entry;
    if (statusCounts[status] != null) statusCounts[status] += 1;
    missing.forEach(name => missingEvents.add(name));
  }
  if (statusCounts.error > 0) {
    return { status: 'error', missingEvents: Array.from(missingEvents) };
  }
  if (statusCounts.configured > 0 && statusCounts.partial === 0 && statusCounts.missing === 0) {
    return { status: 'configured', missingEvents: [] };
  }
  if (statusCounts.configured > 0 || statusCounts.partial > 0) {
    return { status: 'partial', missingEvents: Array.from(missingEvents) };
  }
  return { status: 'missing', missingEvents: Array.from(missingEvents) };
};

async function getOnboardingStatus() {
  const home = os.homedir();

  const claudeRoot = resolveClaudeConfigRoot({ home, env: process.env });
  const codexRoot = resolveCodexConfigRoot({ home, env: process.env });
  const claudePresent = isDirectory(claudeRoot);
  const codexPresent = isDirectory(codexRoot);

  const localClaudeSettings = resolveClaudeSettingsPath({ home, env: process.env });
  const localClaudeHooks = claudePresent
    ? getClaudeHookStatus(localClaudeSettings)
    : { status: 'unavailable', missingEvents: REQUIRED_HOOK_EVENTS.slice() };

  let wslClaudeRoots = [];
  let wslCodexRoots = [];
  if (process.platform === 'win32') {
    const homes = await listWslHomes();
    const isRootHome = (value) => /[\\/]+root$/i.test(String(value || '').trim());
    const filteredHomes = homes.filter(homePath => homePath && !isRootHome(homePath));
    for (const homePath of filteredHomes) {
      const claudePath = path.join(homePath, '.claude');
      const codexPath = path.join(homePath, '.codex');
      if (isDirectory(claudePath)) wslClaudeRoots.push(claudePath);
      if (isDirectory(codexPath)) wslCodexRoots.push(codexPath);
    }
  }

  const wslClaudeHooksList = wslClaudeRoots.map(root =>
    getClaudeHookStatus(path.join(root, 'settings.json'))
  );
  const wslClaudeHooks = wslClaudeRoots.length
    ? aggregateHookStatus(wslClaudeHooksList)
    : { status: 'unavailable', missingEvents: REQUIRED_HOOK_EVENTS.slice() };

  return {
    local: {
      claude: {
        present: claudePresent,
        root: claudeRoot,
        settingsPath: localClaudeSettings,
        hooks: localClaudeHooks,
      },
      codex: {
        present: codexPresent,
        root: codexRoot,
      },
    },
    wsl: {
      claude: {
        present: wslClaudeRoots.length > 0,
        roots: wslClaudeRoots,
        hooks: wslClaudeHooks,
      },
      codex: {
        present: wslCodexRoots.length > 0,
        roots: wslCodexRoots,
      },
    },
  };
}

module.exports = {
  getOnboardingStatus,
};
