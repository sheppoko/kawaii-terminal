const fs = require('fs');
const os = require('os');
const path = require('path');
const { listWslHomes } = require('../../history/infra/wsl-homes');
const {
  resolveClaudeSettingsPath,
  resolveCodexConfigPath,
} = require('../../infra/path/agent-paths');

function ensureDir(dirPath) {
  if (!dirPath) return;
  fs.mkdirSync(dirPath, { recursive: true });
}

function atomicWriteFile(targetPath, content) {
  const dir = path.dirname(targetPath);
  ensureDir(dir);
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, content, { encoding: 'utf8' });
  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (_) {
    try {
      fs.copyFileSync(tmpPath, targetPath);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (_) { /* noop */ }
    }
  }
}

function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return '';
  }
}

function copyFileIfChanged(sourcePath, targetPath) {
  if (!sourcePath || !targetPath) return { ok: false, error: 'copy failed: missing path' };
  if (!fs.existsSync(sourcePath)) return { ok: false, error: `Missing source script: ${sourcePath}` };
  try {
    if (fs.existsSync(targetPath)) {
      const source = fs.readFileSync(sourcePath);
      const target = fs.readFileSync(targetPath);
      if (source.equals(target)) return { ok: true, changed: false };
    }
    fs.copyFileSync(sourcePath, targetPath);
    return { ok: true, changed: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'copy failed' };
  }
}

function backupOnce(filePath) {
  if (!filePath) return;
  const backupPath = `${filePath}.bak`;
  if (fs.existsSync(backupPath)) return;
  if (!fs.existsSync(filePath)) return;
  fs.copyFileSync(filePath, backupPath);
}

function quotePowerShell(value) {
  const raw = String(value || '');
  return `"${raw.replace(/"/g, '""')}"`;
}

function quotePosix(value) {
  const raw = String(value || '');
  if (!raw) return "''";
  return `'${raw.replace(/'/g, `'\\''`)}'`;
}

function resolveEnvPath(value, home) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('~')) return path.join(home, raw.slice(1));
  return raw;
}

function resolveNotifyInstallDir({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === 'win32') {
    const base = resolveEnvPath(env?.LOCALAPPDATA, home) || path.join(home, 'AppData', 'Local');
    return path.join(base, 'Kawaii Terminal', 'notify');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Kawaii Terminal', 'notify');
  }
  const xdg = resolveEnvPath(env?.XDG_DATA_HOME, home);
  const base = xdg || path.join(home, '.local', 'share');
  return path.join(base, 'kawaii-terminal', 'notify');
}

function resolveScriptsBase() {
  const basePath = __dirname.includes('app.asar')
    ? __dirname.replace('app.asar', 'app.asar.unpacked')
    : __dirname;
  return path.join(basePath, '../../../../scripts/notify');
}

function toWslPath(winPath) {
  const raw = String(winPath || '').trim();
  const match = raw.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (!match) return raw.replace(/\\/g, '/');
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
}

function normalizeHookRules(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value && typeof value === 'object') return [value];
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function commandRule(command) {
  return {
    hooks: [{ type: 'command', command }],
  };
}

function ruleContainsCommand(rule, command) {
  if (!rule || !command) return false;
  if (typeof rule === 'string') return rule.trim() === command;
  if (typeof rule !== 'object') return false;
  if (typeof rule.command === 'string' && rule.command.trim() === command) return true;
  const hooks = Array.isArray(rule.hooks) ? rule.hooks : [];
  return hooks.some((hook) => {
    if (!hook || typeof hook !== 'object') return false;
    if (hook.type && String(hook.type).toLowerCase() !== 'command') return false;
    return typeof hook.command === 'string' && hook.command.trim() === command;
  });
}

function updateClaudeConfig(filePath, commandsByEvent, { removeCommands = [] } = {}) {
  const raw = safeReadFile(filePath);
  let config = {};
  if (raw.trim()) {
    try {
      config = JSON.parse(raw);
    } catch (error) {
      return { ok: false, error: `JSON parse failed: ${error.message}` };
    }
  }
  if (!config || typeof config !== 'object') config = {};
  if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};

  let changed = false;
  const removeSet = new Set(removeCommands.filter(Boolean).map((entry) => String(entry).trim()).filter(Boolean));

  const isKawaiiNotifyCommandForEvent = (command, eventName) => {
    const raw = String(command || '').trim();
    if (!raw) return false;
    const lower = raw.toLowerCase();
    if (!lower.includes('kawaii-notify')) return false;
    if (!lower.includes('--source claude')) return false;
    const hookToken = `--hook ${String(eventName || '').trim().toLowerCase()}`;
    if (!hookToken || !lower.includes(hookToken)) return false;
    return true;
  };

  const isLegacyKawaiiNotifyCommand = (command) => {
    const raw = String(command || '').trim();
    if (!raw) return false;
    const lower = raw.toLowerCase();
    if (!lower.includes('kawaii-notify')) return false;
    if (!lower.includes('--source claude')) return false;
    if (lower.includes('--hook ')) return false;
    return true;
  };

  const pruneHookEntry = (entry, { eventName, desiredCommand } = {}) => {
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (!trimmed) return null;
      if (isLegacyKawaiiNotifyCommand(trimmed)) {
        changed = true;
        return null;
      }
      if (removeSet.has(trimmed)) {
        changed = true;
        return null;
      }
      if (eventName && desiredCommand && isKawaiiNotifyCommandForEvent(trimmed, eventName)) {
        if (trimmed !== desiredCommand.trim()) {
          changed = true;
          return null;
        }
      }
      return commandRule(trimmed);
    }
    if (!entry || typeof entry !== 'object') {
      changed = true;
      return null;
    }
    if (typeof entry.command === 'string') {
      const trimmed = entry.command.trim();
      if (isLegacyKawaiiNotifyCommand(trimmed)) {
        changed = true;
        return null;
      }
      if (removeSet.has(trimmed)) {
        changed = true;
        return null;
      }
      if (eventName && desiredCommand && isKawaiiNotifyCommandForEvent(trimmed, eventName)) {
        if (trimmed !== desiredCommand.trim()) {
          changed = true;
          return null;
        }
      }
    }
    if (Array.isArray(entry.hooks)) {
      const nextHooks = entry.hooks.filter((hook) => {
        if (!hook || typeof hook !== 'object') return false;
        const hookType = hook.type ? String(hook.type).toLowerCase() : '';
        if (hookType && hookType !== 'command') return true;
        const cmd = typeof hook.command === 'string' ? hook.command.trim() : '';
        if (cmd && isLegacyKawaiiNotifyCommand(cmd)) {
          changed = true;
          return false;
        }
        if (cmd && removeSet.has(cmd)) {
          changed = true;
          return false;
        }
        if (cmd && eventName && desiredCommand && isKawaiiNotifyCommandForEvent(cmd, eventName)) {
          if (cmd !== desiredCommand.trim()) {
            changed = true;
            return false;
          }
        }
        return true;
      });
      if (nextHooks.length === 0) {
        changed = true;
        return null;
      }
      if (nextHooks.length !== entry.hooks.length) {
        changed = true;
      }
      return { ...entry, hooks: nextHooks };
    }
    return entry;
  };
  for (const [eventName, command] of Object.entries(commandsByEvent)) {
    if (!command) continue;
    const existing = normalizeHookRules(config.hooks[eventName]);
    let found = false;
    const next = [];
    for (const entry of existing) {
      const pruned = pruneHookEntry(entry, { eventName, desiredCommand: command });
      if (!pruned) continue;
      next.push(pruned);
      if (ruleContainsCommand(pruned, command)) found = true;
    }

    if (!found) {
      next.push(commandRule(command));
      changed = true;
    }

    config.hooks[eventName] = next;
  }

  if (!changed) return { ok: true, changed: false };
  backupOnce(filePath);
  const content = `${JSON.stringify(config, null, 2)}\n`;
  atomicWriteFile(filePath, content);
  return { ok: true, changed: true };
}

function updateCodexConfig() {
  return { ok: true, changed: false, skipped: true, reason: 'codex config not modified' };
}

function removeClaudeCommands(filePath, removeCommands = []) {
  const raw = safeReadFile(filePath);
  let config = {};
  if (raw.trim()) {
    try {
      config = JSON.parse(raw);
    } catch (error) {
      return { ok: false, error: `JSON parse failed: ${error.message}` };
    }
  }
  if (!config || typeof config !== 'object') config = {};
  if (!config.hooks || typeof config.hooks !== 'object') return { ok: true, changed: false };

  const removeSet = new Set(removeCommands.filter(Boolean).map((entry) => String(entry).trim()).filter(Boolean));
  const shouldRemoveCommand = (command) => {
    const trimmed = String(command || '').trim();
    if (!trimmed) return false;
    if (removeSet.has(trimmed)) return true;
    const lower = trimmed.toLowerCase();
    if (!lower.includes('kawaii-notify')) return false;
    if (!lower.includes('--source claude')) return false;
    return true;
  };

  let changed = false;
  const nextHooks = {};
  for (const [eventName, rules] of Object.entries(config.hooks)) {
    const existing = normalizeHookRules(rules);
    const next = [];
    for (const entry of existing) {
      if (typeof entry === 'string') {
        if (shouldRemoveCommand(entry)) {
          changed = true;
          continue;
        }
        next.push(entry);
        continue;
      }
      if (!entry || typeof entry !== 'object') {
        changed = true;
        continue;
      }
      if (typeof entry.command === 'string' && shouldRemoveCommand(entry.command)) {
        changed = true;
        continue;
      }
      if (Array.isArray(entry.hooks)) {
        const filtered = entry.hooks.filter((hook) => {
          if (!hook || typeof hook !== 'object') return false;
          const hookType = hook.type ? String(hook.type).toLowerCase() : '';
          if (hookType && hookType !== 'command') return true;
          const cmd = typeof hook.command === 'string' ? hook.command.trim() : '';
          if (shouldRemoveCommand(cmd)) {
            changed = true;
            return false;
          }
          return true;
        });
        if (filtered.length === 0) {
          changed = true;
          continue;
        }
        if (filtered.length !== entry.hooks.length) {
          changed = true;
        }
        next.push(filtered.length === entry.hooks.length ? entry : { ...entry, hooks: filtered });
        continue;
      }
      next.push(entry);
    }
    if (next.length > 0) {
      nextHooks[eventName] = next;
    } else if (existing.length > 0) {
      changed = true;
    }
  }

  if (!changed) return { ok: true, changed: false };
  config.hooks = nextHooks;
  backupOnce(filePath);
  const content = `${JSON.stringify(config, null, 2)}\n`;
  atomicWriteFile(filePath, content);
  return { ok: true, changed: true };
}

class AutoConfigService {
  constructor({ userHome } = {}) {
    this.userHome = userHome || os.homedir();
    this.sourceScriptsDir = resolveScriptsBase();
    this.installScriptsDir = resolveNotifyInstallDir({
      platform: process.platform,
      home: this.userHome,
      env: process.env,
    });
    this.installScriptPaths = this.getScriptPaths(this.installScriptsDir);
    this.sourceScriptPaths = this.getScriptPaths(this.sourceScriptsDir);
    this.notifySh = this.installScriptPaths.sh;
    this.notifyJs = this.installScriptPaths.js;
    this.notifyPs1 = this.installScriptPaths.ps1;
    this.installReady = false;
  }

  getScriptPaths(baseDir) {
    return {
      sh: path.join(baseDir, 'kawaii-notify.sh'),
      js: path.join(baseDir, 'kawaii-notify.js'),
      ps1: path.join(baseDir, 'kawaii-notify.ps1'),
    };
  }

  ensureNotifyScriptsInstalled() {
    if (this.installReady) return { ok: true, changed: false, path: this.installScriptsDir };
    if (!this.sourceScriptsDir || !this.installScriptsDir) {
      return { ok: false, error: 'notify scripts path missing' };
    }
    try {
      ensureDir(this.installScriptsDir);
    } catch (error) {
      return { ok: false, error: error?.message || 'failed to create notify dir' };
    }
    const source = this.sourceScriptPaths || {};
    const target = this.installScriptPaths || {};
    const scripts = [
      { src: source.sh, dest: target.sh, chmod: true },
      { src: source.js, dest: target.js, chmod: false },
      { src: source.ps1, dest: target.ps1, chmod: false },
    ];
    let changed = false;
    for (const script of scripts) {
      const result = copyFileIfChanged(script.src, script.dest);
      if (!result.ok) return result;
      if (result.changed) changed = true;
      if (script.chmod && process.platform !== 'win32') {
        try {
          fs.chmodSync(script.dest, 0o755);
        } catch (_) {
          // Ignore chmod failures on non-posix filesystems.
        }
      }
    }
    this.installReady = true;
    return { ok: true, changed, path: this.installScriptsDir };
  }

  buildClaudeCommands({ platform, useWsl, useCscript, scriptPaths } = {}) {
    const scripts = scriptPaths || this.installScriptPaths || {};
    const notifySh = scripts.sh || this.notifySh;
    const notifyJs = scripts.js || this.notifyJs;
    const notifyPs1 = scripts.ps1 || this.notifyPs1;
    const isWindows = platform === 'win32';
    let base = '';
    if (useWsl) {
      const scriptPath = toWslPath(notifySh);
      const script = quotePosix(scriptPath);
      base = `sh ${script}`;
    } else if (isWindows) {
      if (useCscript) {
        const script = quotePowerShell(notifyJs);
        base = `cscript //nologo ${script}`;
      } else {
        const script = quotePowerShell(notifyPs1);
        base = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${script}`;
      }
    } else {
      const script = quotePosix(notifySh);
      base = `sh ${script}`;
    }
    return {
      SessionStart: `${base} --source claude --event completed --hook SessionStart`,
      UserPromptSubmit: `${base} --source claude --event working --hook UserPromptSubmit`,
      PermissionRequest: `${base} --source claude --event waiting_user --hook PermissionRequest`,
      Notification: `${base} --source claude --event auto --hook Notification`,
      Stop: `${base} --source claude --event completed --hook Stop`,
      SessionEnd: `${base} --source claude --event stopped --hook SessionEnd`,
    };
  }

  buildCommands({ platform, useWsl } = {}) {
    const isWindows = platform === 'win32';
    const claude = this.buildClaudeCommands({
      platform,
      useWsl,
      useCscript: false,
      scriptPaths: this.installScriptPaths,
    });
    const removeCommands = [];
    const stripHook = (cmd) => String(cmd || '').replace(/\s+--hook\s+\S+/g, '').trim();
    const pushLegacy = (cmds) => {
      const legacy = Object.values(cmds).map(stripHook).filter(Boolean);
      removeCommands.push(...legacy);
    };
    const pushCommands = (cmds) => {
      removeCommands.push(...Object.values(cmds).filter(Boolean));
    };
    const hasLegacyScripts = this.sourceScriptsDir && this.sourceScriptsDir !== this.installScriptsDir;

    pushLegacy(claude);
    if (hasLegacyScripts) {
      const legacyClaude = this.buildClaudeCommands({
        platform,
        useWsl,
        useCscript: false,
        scriptPaths: this.sourceScriptPaths,
      });
      pushLegacy(legacyClaude);
    }

    if (useWsl) {
      const winPs = this.buildClaudeCommands({
        platform: 'win32',
        useWsl: false,
        useCscript: false,
        scriptPaths: this.installScriptPaths,
      });
      const winJs = this.buildClaudeCommands({
        platform: 'win32',
        useWsl: false,
        useCscript: true,
        scriptPaths: this.installScriptPaths,
      });
      pushCommands(winPs);
      pushCommands(winJs);
      if (hasLegacyScripts) {
        const legacyWinPs = this.buildClaudeCommands({
          platform: 'win32',
          useWsl: false,
          useCscript: false,
          scriptPaths: this.sourceScriptPaths,
        });
        const legacyWinJs = this.buildClaudeCommands({
          platform: 'win32',
          useWsl: false,
          useCscript: true,
          scriptPaths: this.sourceScriptPaths,
        });
        pushCommands(legacyWinPs);
        pushCommands(legacyWinJs);
      }
    } else if (isWindows) {
      const wsl = this.buildClaudeCommands({
        platform: 'win32',
        useWsl: true,
        useCscript: false,
        scriptPaths: this.installScriptPaths,
      });
      pushCommands(wsl);
      if (hasLegacyScripts) {
        const legacyWsl = this.buildClaudeCommands({
          platform: 'win32',
          useWsl: true,
          useCscript: false,
          scriptPaths: this.sourceScriptPaths,
        });
        pushCommands(legacyWsl);
      }
    }

    return { claude, removeCommands };
  }

  resolveClaudePath(homePath, { env } = {}) {
    return resolveClaudeSettingsPath({
      home: homePath,
      env: env || process.env,
    });
  }

  resolveCodexPath(homePath, { env } = {}) {
    return resolveCodexConfigPath({
      home: homePath,
      env: env || process.env,
    });
  }

  applyForHome(homePath, { useWsl } = {}) {
    const env = useWsl ? {} : process.env;
    const commands = this.buildCommands({ platform: process.platform, useWsl });
    const claudePath = this.resolveClaudePath(homePath, { env });
    const claudeResult = updateClaudeConfig(claudePath, commands.claude, {
      removeCommands: commands.removeCommands || [],
    });
    return {
      claude: { path: claudePath, ...claudeResult },
      codex: { ...updateCodexConfig() },
    };
  }

  async apply({ enableWsl = true } = {}) {
    const results = {
      claude: null,
      codex: null,
      wsl: { applied: 0, errors: [] },
    };
    const installResult = this.ensureNotifyScriptsInstalled();
    if (!installResult.ok) {
      return {
        ok: false,
        results,
        warnings: null,
        error: installResult.error || 'notify install failed',
      };
    }
    const local = this.applyForHome(this.userHome, { useWsl: false });
    results.claude = local.claude;
    results.codex = local.codex;

    if (enableWsl && process.platform === 'win32') {
      try {
        const homes = await listWslHomes();
        const isRootHome = (value) => /[\\/]+root$/i.test(String(value || '').trim());
        const filteredHomes = homes.filter((home) => !isRootHome(home));
        for (const home of filteredHomes) {
          if (!home) continue;
          const res = this.applyForHome(home, { useWsl: true });
          results.wsl.applied += 1;
          if (!res.claude?.ok) {
            results.wsl.errors.push({ home, target: 'claude', error: res.claude?.error || 'unknown' });
          }
          if (!res.codex?.ok) {
            results.wsl.errors.push({ home, target: 'codex', error: res.codex?.error || 'unknown' });
          }
        }
      } catch (error) {
        results.wsl.errors.push({ home: 'wsl', target: 'all', error: error?.message || 'wsl failed' });
      }
    }

    const localOk = results.claude?.ok !== false && results.codex?.ok !== false;
    const wslErrors = Array.isArray(results.wsl.errors) ? results.wsl.errors.length : 0;
    const errorParts = [];
    if (results.claude?.ok === false) {
      errorParts.push(`Claude: ${results.claude?.error || 'failed'}`);
    }
    if (results.codex?.ok === false) {
      errorParts.push(`Codex: ${results.codex?.error || 'failed'}`);
    }
    const error = errorParts.join(' | ');
    const warnings = wslErrors > 0 ? { wsl: results.wsl.errors } : null;

    return { ok: localOk, results, warnings, error };
  }

  rollbackForHome(homePath, { useWsl } = {}) {
    const env = useWsl ? {} : process.env;
    const { claude, removeCommands } = this.buildCommands({ platform: process.platform, useWsl });
    const removeList = [
      ...Object.values(claude || {}).filter(Boolean),
      ...Array.isArray(removeCommands) ? removeCommands : [],
    ];
    const claudePath = this.resolveClaudePath(homePath, { env });
    const claudeResult = removeClaudeCommands(claudePath, removeList);
    return {
      claude: { path: claudePath, ...claudeResult },
      codex: { ok: true, changed: false, skipped: true, reason: 'codex config not modified' },
    };
  }

  async rollback({ enableWsl = true } = {}) {
    const results = {
      claude: null,
      codex: null,
      wsl: { applied: 0, errors: [] },
    };
    const local = this.rollbackForHome(this.userHome, { useWsl: false });
    results.claude = local.claude;
    results.codex = local.codex;

    if (enableWsl && process.platform === 'win32') {
      try {
        const homes = await listWslHomes();
        const isRootHome = (value) => /[\\/]+root$/i.test(String(value || '').trim());
        const filteredHomes = homes.filter((home) => !isRootHome(home));
        for (const home of filteredHomes) {
          if (!home) continue;
          const res = this.rollbackForHome(home, { useWsl: true });
          results.wsl.applied += 1;
          if (!res.claude?.ok) {
            results.wsl.errors.push({ home, target: 'claude', error: res.claude?.error || 'unknown' });
          }
          if (!res.codex?.ok) {
            results.wsl.errors.push({ home, target: 'codex', error: res.codex?.error || 'unknown' });
          }
        }
      } catch (error) {
        results.wsl.errors.push({ home: 'wsl', target: 'all', error: error?.message || 'wsl failed' });
      }
    }

    const localOk = results.claude?.ok !== false && results.codex?.ok !== false;
    const wslErrors = Array.isArray(results.wsl.errors) ? results.wsl.errors.length : 0;
    const errorParts = [];
    if (results.claude?.ok === false) {
      errorParts.push(`Claude: ${results.claude?.error || 'failed'}`);
    }
    if (results.codex?.ok === false) {
      errorParts.push(`Codex: ${results.codex?.error || 'failed'}`);
    }
    const error = errorParts.join(' | ');
    const warnings = wslErrors > 0 ? { wsl: results.wsl.errors } : null;

    return { ok: localOk, results, warnings, error };
  }
}

module.exports = AutoConfigService;
