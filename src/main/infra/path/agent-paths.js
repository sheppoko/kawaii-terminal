const fs = require('fs');
const os = require('os');
const path = require('path');

const isDirectory = (dirPath) => {
  if (!dirPath) return false;
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch (_) {
    return false;
  }
};

const resolveHomePath = (value, home = os.homedir()) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('~')) return path.join(home, raw.slice(1));
  return raw;
};

const uniquePush = (list, value) => {
  if (!value) return;
  if (list.includes(value)) return;
  list.push(value);
};

const splitEnvPaths = (rawValue, home) => {
  const raw = String(rawValue || '').trim();
  if (!raw) return [];
  const parts = raw.split(path.delimiter).map(part => resolveHomePath(part, home)).filter(Boolean);
  const unique = [];
  for (const part of parts) {
    uniquePush(unique, part);
  }
  return unique;
};

const resolveClaudeConfigRoot = ({ home = os.homedir(), env = process.env } = {}) => {
  const envDir = resolveHomePath(env?.CLAUDE_CONFIG_DIR, home);
  if (envDir && isDirectory(envDir)) return envDir;
  return path.join(home, '.claude');
};

const resolveClaudeSettingsPath = (options = {}) =>
  path.join(resolveClaudeConfigRoot(options), 'settings.json');

const listClaudeConfigRoots = ({ home = os.homedir(), env = process.env, includeAppData = true } = {}) => {
  const roots = [];
  uniquePush(roots, resolveClaudeConfigRoot({ home, env }));

  if (includeAppData && process.platform === 'win32') {
    const local = resolveHomePath(env?.LOCALAPPDATA, home);
    const roaming = resolveHomePath(env?.APPDATA, home);
    const candidates = [
      local ? path.join(local, 'Claude') : '',
      roaming ? path.join(roaming, 'Claude') : '',
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (isDirectory(candidate) || isDirectory(path.join(candidate, 'projects'))) {
        uniquePush(roots, candidate);
      }
    }
  }

  return roots;
};

const resolveCodexConfigRoot = ({ home = os.homedir(), env = process.env } = {}) => {
  const candidates = splitEnvPaths(env?.CODEX_HOME, home);
  for (const candidate of candidates) {
    if (isDirectory(candidate)) return candidate;
  }
  return path.join(home, '.codex');
};

const resolveCodexConfigPath = (options = {}) =>
  path.join(resolveCodexConfigRoot(options), 'config.toml');

const listCodexConfigRoots = ({ home = os.homedir(), env = process.env } = {}) => {
  const roots = [];
  const candidates = splitEnvPaths(env?.CODEX_HOME, home);
  for (const candidate of candidates) {
    if (isDirectory(candidate)) uniquePush(roots, candidate);
  }
  uniquePush(roots, path.join(home, '.codex'));
  return roots;
};

module.exports = {
  listClaudeConfigRoots,
  listCodexConfigRoots,
  resolveClaudeConfigRoot,
  resolveClaudeSettingsPath,
  resolveCodexConfigRoot,
  resolveCodexConfigPath,
};
