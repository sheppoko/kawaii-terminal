const pty = require('node-pty');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { execFile, spawn } = require('child_process');

function execFileText(command, args, { timeout = 1000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error && error.code === 'ENOENT') {
        reject(error);
        return;
      }
      resolve(typeof stdout === 'string' ? stdout : '');
    });
  });
}

const SHELL_ENV_TIMEOUT_MS = 10000;
const shellEnvCache = new Map();

function buildShellEnvCommand(mark) {
  const nodePath = String(process.execPath || '').replace(/'/g, "'\\''");
  return `'${nodePath}' -p '"${mark}" + JSON.stringify(process.env) + "${mark}"'`;
}

function buildShellEnvArgs(shellPath) {
  const name = path.basename(shellPath || '').toLowerCase();
  if (name === 'tcsh' || name === 'csh') {
    return ['-ic'];
  }
  if (name === 'nu') {
    return ['-i', '-l', '-c'];
  }
  if (name === 'fish') {
    return ['-i', '-l', '-c'];
  }
  return ['-i', '-l', '-c'];
}

function stripTransientKawaiiEnv(env) {
  if (!env) return;
  delete env.KAWAII_ZSHRC_LOADED;
}

async function resolveShellEnv(shellPath) {
  if (!shellPath) return {};
  const cacheKey = String(shellPath);
  const cached = shellEnvCache.get(cacheKey);
  if (cached?.env) return cached.env;
  if (cached?.promise) return cached.promise;

  const promise = new Promise((resolve) => {
    const mark = `__KAWAII_ENV_${Date.now().toString(16)}${Math.random().toString(16).slice(2)}__`;
    const regex = new RegExp(mark + '([\\s\\S]*)' + mark);
    const shellArgs = buildShellEnvArgs(shellPath);
    const command = buildShellEnvCommand(mark);
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      KAWAII_RESOLVING_ENV: '1',
    };
    stripTransientKawaiiEnv(env);

    const child = spawn(shellPath, [...shellArgs, command], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    const stdout = [];
    const stderr = [];
    let finished = false;
    const done = (value) => {
      if (finished) return;
      finished = true;
      resolve(value || {});
    };

    const timeout = setTimeout(() => {
      try { child.kill(); } catch (_) { /* noop */ }
      done({});
    }, SHELL_ENV_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', () => {
      clearTimeout(timeout);
      done({});
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (code || signal) {
        return done({});
      }
      const raw = Buffer.concat(stdout).toString('utf8');
      const match = regex.exec(raw);
      const payload = match ? match[1] : '';
      try {
        const resolved = JSON.parse(payload || '{}');
        delete resolved.ELECTRON_RUN_AS_NODE;
        delete resolved.ELECTRON_NO_ATTACH_CONSOLE;
        delete resolved.KAWAII_RESOLVING_ENV;
        done(resolved);
      } catch (_) {
        done({});
      }
    });
  });

  shellEnvCache.set(cacheKey, { promise, env: null });
  const result = await promise;
  shellEnvCache.set(cacheKey, { promise: null, env: result });
  return result;
}

function resolveLoginShell() {
  try {
    const info = os.userInfo();
    const shell = String(info?.shell || '').trim();
    if (shell) return shell;
  } catch (_) {
    // ignore
  }

  try {
    const username = os.userInfo().username;
    const passwd = fs.readFileSync('/etc/passwd', 'utf8');
    const line = passwd.split('\n').find((row) => row.startsWith(`${username}:`));
    if (line) {
      const parts = line.split(':');
      const shell = (parts[parts.length - 1] || '').trim();
      if (shell) return shell;
    }
  } catch (_) {
    // ignore
  }

  const envShell = typeof process.env.SHELL === 'string' ? process.env.SHELL.trim() : '';
  if (envShell) return envShell;

  return '/bin/zsh';
}

function encodePowerShellCommand(script) {
  return Buffer.from(String(script || ''), 'utf16le').toString('base64');
}

const WSL_PROFILE_PREFIX = 'wsl:';
const WSLENV_PARTS = [
  'KAWAII_PANE_ID/u',
  'KAWAII_NOTIFY_PATH/p',
  'KAWAII_NOTIFY_DEBUG_PATH/p',
  'KAWAII_TERMINAL_INSTANCE_ID/u',
  'KAWAII_WSL_ZDOTDIR/p',
  'KAWAII_WSL_BASHRC/p',
  'KAWAII_WSL_FISH/p',
  'KAWAII_WSL_START_CWD/u',
];

function normalizeProfileId(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return '';
  return trimmed.slice(0, 200);
}

function extractWslDistro(profileId) {
  if (!profileId) return '';
  const trimmed = String(profileId).trim();
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith(WSL_PROFILE_PREFIX)) return '';
  const name = trimmed.slice(WSL_PROFILE_PREFIX.length).trim();
  if (!name) return '';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) return '';
  return name.slice(0, 120);
}

function mergeWslEnv(existing) {
  const items = String(existing || '').split(':').filter(Boolean);
  const normalized = new Set(items.map(entry => entry.split('/')[0]));
  const next = items.slice();
  for (const part of WSLENV_PARTS) {
    const key = part.split('/')[0];
    if (normalized.has(key)) continue;
    normalized.add(key);
    next.push(part);
  }
  return next.join(':');
}

function toWslPath(winPath) {
  const raw = String(winPath || '').trim();
  const match = raw.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (!match) return raw.replace(/\\/g, '/');
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
}

function toWslStartCwd(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/')) return raw;
  if (/^[a-zA-Z]:[\\/]/.test(raw)) return toWslPath(raw);
  return raw;
}

function readEnvValue(env, key) {
  if (!env || !key) return '';
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
}

function isUtf8Locale(value) {
  return /utf-?8/i.test(String(value || ''));
}

function ensureUtf8Locale(env) {
  const lcAll = readEnvValue(env, 'LC_ALL');
  if (lcAll) return;

  const lang = readEnvValue(env, 'LANG');
  const lcCtype = readEnvValue(env, 'LC_CTYPE');
  if (isUtf8Locale(lang) || isUtf8Locale(lcCtype)) return;

  const fallback = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
  if (!lang) env.LANG = fallback;
  if (!lcCtype) env.LC_CTYPE = fallback;
}

function safeMkdir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (_) {
    // ignore
  }
}

function writeFileIfChanged(filePath, content) {
  try {
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, 'utf8');
      if (existing === content) return;
    }
    fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o644 });
  } catch (_) {
    // ignore
  }
}

function getIntegrationRoot() {
  try {
    return path.join(app.getPath('userData'), 'shell-integration');
  } catch (_) {
    return path.join(os.tmpdir(), 'kawaii-terminal-shell-integration');
  }
}

function getDefaultNotifyPath() {
  const instanceId = process.env.KAWAII_TERMINAL_INSTANCE_ID || 'instance';
  const safeId = String(instanceId).replace(/[^A-Za-z0-9._-]/g, '_');
  let baseDir = '';
  try {
    baseDir = app.getPath('userData');
  } catch (_) {
    baseDir = os.tmpdir();
  }
  const dir = path.join(baseDir, 'notify');
  return path.join(dir, `notify-${safeId}.jsonl`);
}

function getDefaultNotifyDebugPath() {
  const instanceId = process.env.KAWAII_TERMINAL_INSTANCE_ID || 'instance';
  const safeId = String(instanceId).replace(/[^A-Za-z0-9._-]/g, '_');
  let baseDir = '';
  try {
    baseDir = app.getPath('userData');
  } catch (_) {
    baseDir = os.tmpdir();
  }
  const dir = path.join(baseDir, 'notify');
  return path.join(dir, `notify-debug-${safeId}.jsonl`);
}

function ensureShellIntegrationFiles() {
  const root = getIntegrationRoot();
  safeMkdir(root);

  const zshDir = path.join(root, 'zsh');
  const bashDir = path.join(root, 'bash');
  const fishDir = path.join(root, 'fish');
  safeMkdir(zshDir);
  safeMkdir(bashDir);
  safeMkdir(fishDir);

  const zshrcPath = path.join(zshDir, '.zshrc');
  const zprofilePath = path.join(zshDir, '.zprofile');
  const zloginPath = path.join(zshDir, '.zlogin');
  const zlogoutPath = path.join(zshDir, '.zlogout');
  const bashRcPath = path.join(bashDir, 'kawaii_bashrc');
  const fishConfigPath = path.join(fishDir, 'config.fish');

  const zshenv = [
    '# Generated by Kawaii Terminal',
    'if [ -z "${KAWAII_ZDOTDIR_SELF:-}" ]; then',
    `  export KAWAII_ZDOTDIR_SELF='${zshDir.replace(/'/g, "'\\''")}'`,
    'fi',
    'KAWAII_ZDOTDIR="${KAWAII_ORIG_ZDOTDIR:-$HOME}"',
    'if [ -n "${KAWAII_ZDOTDIR_SELF:-}" ] && [ "$KAWAII_ZDOTDIR" = "$KAWAII_ZDOTDIR_SELF" ]; then',
    '  KAWAII_ZDOTDIR="$HOME"',
    'fi',
    'if [ -r "${KAWAII_ZDOTDIR}/.zshenv" ]; then',
    '  __kawaii_saved_zdotdir="${ZDOTDIR:-}"',
    '  export ZDOTDIR="$KAWAII_ZDOTDIR"',
    '  source "${KAWAII_ZDOTDIR}/.zshenv"',
    '  if [ -n "${KAWAII_ZDOTDIR_SELF:-}" ]; then',
    '    export ZDOTDIR="$KAWAII_ZDOTDIR_SELF"',
    '  else',
    '    export ZDOTDIR="$__kawaii_saved_zdotdir"',
    '  fi',
    '  unset __kawaii_saved_zdotdir',
    'fi',
    'if [ -n "${KAWAII_ZDOTDIR_SELF:-}" ]; then',
    '  export ZDOTDIR="$KAWAII_ZDOTDIR_SELF"',
    'fi',
    '',
  ].join('\n');

  const zshrc = [
    '# Generated by Kawaii Terminal',
    'if [ -n "${KAWAII_ZSHRC_LOADED:-}" ]; then',
    '  return',
    'fi',
    'export KAWAII_ZSHRC_LOADED=1',
    'KAWAII_ZDOTDIR="${KAWAII_ORIG_ZDOTDIR:-$HOME}"',
    'if [ -n "${KAWAII_ZDOTDIR_SELF:-}" ] && [ "$KAWAII_ZDOTDIR" = "$KAWAII_ZDOTDIR_SELF" ]; then',
    '  KAWAII_ZDOTDIR="$HOME"',
    'fi',
    'if [ -r "${KAWAII_ZDOTDIR}/.zshrc" ]; then',
    '  __kawaii_saved_zdotdir="${ZDOTDIR:-}"',
    '  export ZDOTDIR="$KAWAII_ZDOTDIR"',
    '  source "${KAWAII_ZDOTDIR}/.zshrc"',
    '  if [ -n "${KAWAII_ZDOTDIR_SELF:-}" ]; then',
    '    export ZDOTDIR="$KAWAII_ZDOTDIR_SELF"',
    '  else',
    '    export ZDOTDIR="$__kawaii_saved_zdotdir"',
    '  fi',
    '  unset __kawaii_saved_zdotdir',
    'fi',
    'if [[ -o interactive ]]; then',
    '  __kawaii_emit_shell() {',
    '    local name=""',
    '    if command -v ps >/dev/null 2>&1; then',
    '      name="$(ps -p $$ -o comm= 2>/dev/null | head -n1)"',
    '    fi',
    '    [[ -z "$name" ]] && name="${ZSH_NAME:-zsh}"',
    '    export KAWAII_LAUNCH_SHELL="$name"',
    '    if [[ -z "${SHELL:-}" ]]; then',
    '      export SHELL="$name"',
    '    fi',
    '    local info="shell=${name} env=${SHELL:-}"',
    '    if command -v base64 >/dev/null 2>&1; then',
    '      local b64',
    '      b64="$(printf \'%s\' "$info" | base64 | tr -d \'\\n\')"',
    '      if [[ -n "$b64" ]]; then',
    '        printf \'\\033]1337;KawaiiShell64=%s\\007\' "$b64"',
    '        return',
    '      fi',
    '    fi',
    '    printf \'\\033]1337;KawaiiShell=%s\\007\' "$info"',
    '  }',
    '  __kawaii_emit_shell',
    '  __kawaii_emit_cwd() {',
    '    printf \'\\033]1337;CurrentDir=%s\\007\' "$PWD"',
    '  }',
    '  __kawaii_emit_cmd() {',
    '    local cmd="$1"',
    '    if [[ -z "$cmd" ]]; then',
    '      cmd="$(fc -ln -1)"',
    '    fi',
    '    cmd="${cmd//$\'\\n\'/ }"',
    '    [[ -z "$cmd" ]] && return',
    '    if command -v base64 >/dev/null 2>&1; then',
    '      local b64',
    '      b64="$(printf \'%s\' "$cmd" | base64 | tr -d \'\\n\')"',
    '      if [[ -n "$b64" ]]; then',
    '        printf \'\\033]1337;KawaiiCmd64=%s\\007\' "$b64"',
    '        return',
    '      fi',
    '    fi',
    '    local safe',
    '    safe="${cmd//[^A-Za-z0-9._:@\\/+=-]/ }"',
    '    printf \'\\033]1337;KawaiiCmd=%s\\007\' "$safe"',
    '  }',
    '  __kawaii_precmd() {',
    '    __kawaii_emit_cwd',
    '  }',
    '  __kawaii_preexec() {',
    '    __kawaii_emit_cmd "$1"',
    '  }',
    '  (( ${precmd_functions[(Ie)__kawaii_precmd]} )) || precmd_functions+=(__kawaii_precmd)',
    '  (( ${preexec_functions[(Ie)__kawaii_preexec]} )) || preexec_functions+=(__kawaii_preexec)',
    'fi',
    '',
  ].join('\n');

  const zprofile = [
    '# Generated by Kawaii Terminal',
    'KAWAII_ZDOTDIR="${KAWAII_ORIG_ZDOTDIR:-$HOME}"',
    'if [ -n "${KAWAII_ZDOTDIR_SELF:-}" ] && [ "$KAWAII_ZDOTDIR" = "$KAWAII_ZDOTDIR_SELF" ]; then',
    '  KAWAII_ZDOTDIR="$HOME"',
    'fi',
    'if [ -r "${KAWAII_ZDOTDIR}/.zprofile" ]; then',
    '  __kawaii_saved_zdotdir="${ZDOTDIR:-}"',
    '  export ZDOTDIR="$KAWAII_ZDOTDIR"',
    '  source "${KAWAII_ZDOTDIR}/.zprofile"',
    '  if [ -n "${KAWAII_ZDOTDIR_SELF:-}" ]; then',
    '    export ZDOTDIR="$KAWAII_ZDOTDIR_SELF"',
    '  else',
    '    export ZDOTDIR="$__kawaii_saved_zdotdir"',
    '  fi',
    '  unset __kawaii_saved_zdotdir',
    'fi',
    'if [ -n "${KAWAII_ZDOTDIR_SELF:-}" ]; then',
    '  export ZDOTDIR="$KAWAII_ZDOTDIR_SELF"',
    'fi',
    '',
  ].join('\n');

  const zlogin = [
    '# Generated by Kawaii Terminal',
    'KAWAII_ZDOTDIR="${KAWAII_ORIG_ZDOTDIR:-$HOME}"',
    'if [ -n "${KAWAII_ZDOTDIR_SELF:-}" ] && [ "$KAWAII_ZDOTDIR" = "$KAWAII_ZDOTDIR_SELF" ]; then',
    '  KAWAII_ZDOTDIR="$HOME"',
    'fi',
    'if [ -r "${KAWAII_ZDOTDIR}/.zlogin" ]; then',
    '  __kawaii_saved_zdotdir="${ZDOTDIR:-}"',
    '  export ZDOTDIR="$KAWAII_ZDOTDIR"',
    '  source "${KAWAII_ZDOTDIR}/.zlogin"',
    '  if [ -n "${KAWAII_ZDOTDIR_SELF:-}" ]; then',
    '    export ZDOTDIR="$KAWAII_ZDOTDIR_SELF"',
    '  else',
    '    export ZDOTDIR="$__kawaii_saved_zdotdir"',
    '  fi',
    '  unset __kawaii_saved_zdotdir',
    'fi',
    'if [ -n "${KAWAII_ZDOTDIR_SELF:-}" ]; then',
    '  export ZDOTDIR="$KAWAII_ZDOTDIR_SELF"',
    'fi',
    '',
  ].join('\n');

  const zlogout = [
    '# Generated by Kawaii Terminal',
    'KAWAII_ZDOTDIR="${KAWAII_ORIG_ZDOTDIR:-$HOME}"',
    'if [ -n "${KAWAII_ZDOTDIR_SELF:-}" ] && [ "$KAWAII_ZDOTDIR" = "$KAWAII_ZDOTDIR_SELF" ]; then',
    '  KAWAII_ZDOTDIR="$HOME"',
    'fi',
    'if [ -r "${KAWAII_ZDOTDIR}/.zlogout" ]; then',
    '  __kawaii_saved_zdotdir="${ZDOTDIR:-}"',
    '  export ZDOTDIR="$KAWAII_ZDOTDIR"',
    '  source "${KAWAII_ZDOTDIR}/.zlogout"',
    '  if [ -n "${KAWAII_ZDOTDIR_SELF:-}" ]; then',
    '    export ZDOTDIR="$KAWAII_ZDOTDIR_SELF"',
    '  else',
    '    export ZDOTDIR="$__kawaii_saved_zdotdir"',
    '  fi',
    '  unset __kawaii_saved_zdotdir',
    'fi',
    '',
  ].join('\n');

  const bashrc = [
    '# Generated by Kawaii Terminal',
    'case $- in',
    '  *i*) ;;',
    '  *) return ;;',
    'esac',
    'if [ -r /etc/profile ]; then . /etc/profile; fi',
    'if [ -r "$HOME/.bash_profile" ]; then',
    '  . "$HOME/.bash_profile"',
    'elif [ -r "$HOME/.bash_login" ]; then',
    '  . "$HOME/.bash_login"',
    'elif [ -r "$HOME/.profile" ]; then',
    '  . "$HOME/.profile"',
    'elif [ -r "$HOME/.bashrc" ]; then',
    '  . "$HOME/.bashrc"',
    'fi',
    '__kawaii_last_histcmd=0',
    '__kawaii_histcmd_ready=0',
    '__kawaii_in_prompt=0',
    '__kawaii_ready=0',
    '__kawaii_last_cmd=""',
    '__kawaii_emitted=0',
    '__kawaii_emit_shell() {',
    '  local name=""',
    '  if command -v ps >/dev/null 2>&1; then',
    '    name="$(ps -p $$ -o comm= 2>/dev/null | head -n1)"',
    '  fi',
    '  [[ -z "$name" ]] && name="${0##*/}"',
    '  export KAWAII_LAUNCH_SHELL="$name"',
    '  if [[ -z "${SHELL:-}" ]]; then',
    '    export SHELL="$name"',
    '  fi',
    '  local info="shell=${name} env=${SHELL:-}"',
    '  if command -v base64 >/dev/null 2>&1; then',
    '    local b64',
    '    b64="$(printf \'%s\' "$info" | base64 | tr -d \'\\n\')"',
    '    if [[ -n "$b64" ]]; then',
    '      printf \'\\033]1337;KawaiiShell64=%s\\007\' "$b64"',
    '      return',
    '    fi',
    '  fi',
    '  printf \'\\033]1337;KawaiiShell=%s\\007\' "$info"',
    '}',
    '__kawaii_emit_shell',
    '__kawaii_emit_cwd() {',
    '  printf \'\\033]1337;CurrentDir=%s\\007\' "$PWD"',
    '}',
    '__kawaii_emit_cmd() {',
    '  local cmd="$1"',
    '  if [[ -z "$cmd" ]]; then',
    '    cmd="$(fc -ln -1)"',
    '  fi',
    '  cmd="${cmd//$\'\\n\'/ }"',
    '  [[ -z "$cmd" ]] && return',
    '  __kawaii_last_cmd="$cmd"',
    '  __kawaii_emitted=1',
    '  if command -v base64 >/dev/null 2>&1; then',
    '    local b64',
    '    b64="$(printf \'%s\' "$cmd" | base64 | tr -d \'\\n\')"',
    '    if [[ -n "$b64" ]]; then',
    '      printf \'\\033]1337;KawaiiCmd64=%s\\007\' "$b64"',
    '      return',
    '    fi',
    '  fi',
    '  local safe',
    '  safe="${cmd//[^A-Za-z0-9._:@\\/+=-]/ }"',
    '  printf \'\\033]1337;KawaiiCmd=%s\\007\' "$safe"',
    '}',
    '__kawaii_preexec() {',
    '  local cmd="$BASH_COMMAND"',
    '  [[ -z "$cmd" ]] && return',
    '  [[ "$__kawaii_in_prompt" == "1" ]] && return',
    '  [[ "$__kawaii_ready" == "1" ]] || return',
    '  case "$cmd" in',
    '    __kawaii_*|history*|fc*|trap*) return ;;',
    '  esac',
    '  if [[ "$HISTCMD" =~ ^[0-9]+$ ]] && [[ "$HISTCMD" -gt 0 ]]; then',
    '    if [[ "$HISTCMD" == "$__kawaii_last_histcmd" ]] && [[ "$cmd" == "$__kawaii_last_cmd" ]]; then',
    '      return',
    '    fi',
    '    __kawaii_last_histcmd="$HISTCMD"',
    '    __kawaii_histcmd_ready=1',
    '  fi',
    '  __kawaii_emit_cmd "$cmd"',
    '}',
    'trap "__kawaii_preexec" DEBUG',
    '__kawaii_prompt_command() {',
    '  __kawaii_in_prompt=1',
    '  __kawaii_emit_cwd',
    '  if [[ "$__kawaii_ready" != "1" ]]; then',
    '    __kawaii_ready=1',
    '    if [[ "$HISTCMD" =~ ^[0-9]+$ ]] && [[ "$HISTCMD" -gt 0 ]]; then',
    '      __kawaii_last_histcmd="$HISTCMD"',
    '    fi',
    '    __kawaii_in_prompt=0',
    '    return',
    '  fi',
    '  if [[ "$__kawaii_emitted" == "1" ]]; then',
    '    __kawaii_emitted=0',
    '    __kawaii_in_prompt=0',
    '    return',
    '  fi',
    '  if [[ "$__kawaii_histcmd_ready" == "1" ]] && [[ "$HISTCMD" != "$__kawaii_last_histcmd" ]]; then',
    '    __kawaii_emit_cmd',
    '    __kawaii_last_histcmd="$HISTCMD"',
    '  fi',
    '  __kawaii_in_prompt=0',
    '}',
    'if [[ -n "$PROMPT_COMMAND" ]]; then',
    '  PROMPT_COMMAND="__kawaii_prompt_command; $PROMPT_COMMAND"',
    'else',
    '  PROMPT_COMMAND="__kawaii_prompt_command"',
    'fi',
    '',
  ].join('\n');

  const fishConfig = [
    '# Generated by Kawaii Terminal',
    'function __kawaii_emit_shell',
    '  set -l name ""',
    '  if type -q ps',
    '    set name (ps -p $fish_pid -o comm= 2>/dev/null | head -n1)',
    '  end',
    '  if test -z "$name"',
    '    set name "fish"',
    '  end',
    '  set -gx KAWAII_LAUNCH_SHELL "$name"',
    '  if test -z "$SHELL"',
    '    set -gx SHELL "$name"',
    '  end',
    '  set -l info "shell=$name env=$SHELL"',
    '  if type -q base64',
    '    set -l b64 (printf \'%s\' "$info" | base64 | tr -d \'\\n\')',
    '    if test -n "$b64"',
    '      printf \'\\e]1337;KawaiiShell64=%s\\a\' "$b64"',
    '      return',
    '    end',
    '  end',
    '  printf \'\\e]1337;KawaiiShell=%s\\a\' "$info"',
    'end',
    '__kawaii_emit_shell',
    'function __kawaii_emit_cwd',
    '  printf \'\\e]1337;CurrentDir=%s\\a\' (pwd)',
    'end',
    'function __kawaii_emit_cmd --on-event fish_preexec',
    '  set -l cmd (string join \' \' -- $argv)',
    '  if test -z "$cmd"',
    '    return',
    '  end',
    '  if type -q base64',
    '    set -l b64 (printf \'%s\' "$cmd" | base64 | tr -d \'\\n\')',
    '    if test -n "$b64"',
    '      printf \'\\e]1337;KawaiiCmd64=%s\\a\' "$b64"',
    '      return',
    '    end',
    '  end',
    '  set -l safe (string replace -ar \'[^A-Za-z0-9._:@/+=-]\' \' \' -- "$cmd")',
    '  printf \'\\e]1337;KawaiiCmd=%s\\a\' "$safe"',
    'end',
    'if functions -q fish_prompt',
    '  functions -c fish_prompt __kawaii_fish_prompt_orig',
    'end',
    'function fish_prompt',
    '  __kawaii_emit_cwd',
    '  if functions -q __kawaii_fish_prompt_orig',
    '    __kawaii_fish_prompt_orig',
    '  end',
    'end',
    '',
  ].join('\n');

  const zshenvPath = path.join(zshDir, '.zshenv');
  writeFileIfChanged(zshenvPath, zshenv);
  writeFileIfChanged(zshrcPath, zshrc);
  writeFileIfChanged(zprofilePath, zprofile);
  writeFileIfChanged(zloginPath, zlogin);
  writeFileIfChanged(zlogoutPath, zlogout);
  writeFileIfChanged(bashRcPath, bashrc);
  writeFileIfChanged(fishConfigPath, fishConfig);

  return { zshDir, bashRcPath, fishConfigPath };
}

class PtyManager {
  constructor() {
    this.sessions = new Map();
  }

  has(tabId) {
    return this.sessions.has(tabId);
  }

  /**
   * Get the current working directory of the PTY process
   * @param {string} tabId - The tab ID
   * @returns {string|null} - The current working directory or null if not available
   */
  async getCwd(tabId) {
    const proc = this.sessions.get(tabId);
    if (!proc || !proc.pid) return null;

    const pid = proc.pid;

    try {
      if (process.platform === 'linux') {
        // Linux: read /proc/{pid}/cwd symlink
        return fs.readlinkSync(`/proc/${pid}/cwd`);
      } else if (process.platform === 'darwin') {
        // macOS: use lsof to get cwd
        const args = ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'];
        let result = '';
        try {
          result = await execFileText('/usr/sbin/lsof', args, { timeout: 1000 });
        } catch (_) {
          try {
            result = await execFileText('lsof', args, { timeout: 1000 });
          } catch (_) {
            result = '';
          }
        }
        const match = String(result || '').match(/^n(.+)$/m);
        return match ? match[1] : null;
      } else if (process.platform === 'win32') {
        // Windows CWD detection is unreliable without native code.
        return null;
      }
    } catch (_) {
      // Silently fail - CWD detection is best-effort
      return null;
    }

    return null;
  }

  async spawn(tabId, cols, rows, onData, options = {}) {
    const id = tabId || 'default';
    const profileId = normalizeProfileId(options.profileId);
    const isWindows = process.platform === 'win32';
    const wslDistro = isWindows ? extractWslDistro(profileId) : '';
    const desiredCwd = typeof options.cwd === 'string' ? options.cwd.trim() : '';

    // 既存プロセスがあれば終了
    if (this.sessions.has(id)) {
      this.kill(id);
    }

    // Windows: PowerShell (default) or WSL, それ以外: デフォルトシェル
    let shell = isWindows ? 'powershell.exe' : resolveLoginShell();
    let baseEnv = process.env;
    if (!isWindows && shell && !process.env.KAWAII_RESOLVING_ENV) {
      const resolved = await resolveShellEnv(shell);
      if (resolved && Object.keys(resolved).length > 0) {
        baseEnv = resolved;
      }
    }
    const env = { ...baseEnv };
    stripTransientKawaiiEnv(env);
    ensureUtf8Locale(env);
    env.KAWAII_PANE_ID = id;
    const notifyPath = process.env.KAWAII_NOTIFY_PATH || getDefaultNotifyPath();
    if (notifyPath) {
      env.KAWAII_NOTIFY_PATH = notifyPath;
      if (!process.env.KAWAII_NOTIFY_PATH) {
        process.env.KAWAII_NOTIFY_PATH = notifyPath;
      }
    }
    const debugPath = process.env.KAWAII_NOTIFY_DEBUG_PATH || getDefaultNotifyDebugPath();
    if (debugPath) {
      env.KAWAII_NOTIFY_DEBUG_PATH = debugPath;
      if (!process.env.KAWAII_NOTIFY_DEBUG_PATH) {
        process.env.KAWAII_NOTIFY_DEBUG_PATH = debugPath;
      }
    }
    if (process.env.KAWAII_TERMINAL_INSTANCE_ID) {
      env.KAWAII_TERMINAL_INSTANCE_ID = process.env.KAWAII_TERMINAL_INSTANCE_ID;
    }
    let shellArgs;
    if (isWindows && wslDistro) {
      shell = 'wsl.exe';
      const { zshDir, bashRcPath, fishConfigPath } = ensureShellIntegrationFiles();
      env.KAWAII_WSL_ZDOTDIR = zshDir;
      env.KAWAII_WSL_BASHRC = bashRcPath;
      env.KAWAII_WSL_FISH = fishConfigPath;
      if (desiredCwd) {
        const wslStartCwd = toWslStartCwd(desiredCwd);
        if (wslStartCwd) {
          env.KAWAII_WSL_START_CWD = wslStartCwd;
        }
      }
      env.WSLENV = mergeWslEnv(env.WSLENV);
      const wslZshDir = toWslPath(zshDir);
      const wslBashRc = toWslPath(bashRcPath);
      const wslFish = toWslPath(fishConfigPath);
      const esc = (value) => String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const args = [];
      if (wslDistro !== 'default') {
        args.push('-d', wslDistro);
      }
      const launchScript = [
        'set -eu',
        `export KAWAII_WSL_ZDOTDIR="${esc(wslZshDir)}"`,
        `export KAWAII_WSL_BASHRC="${esc(wslBashRc)}"`,
        `export KAWAII_WSL_FISH="${esc(wslFish)}"`,
        `export KAWAII_ZDOTDIR_SELF="${esc(wslZshDir)}"`,
        'KAWAII_SHELL=""',
        'KAWAII_USER="${USER:-}"',
        'if [ -z "$KAWAII_USER" ]; then',
        '  KAWAII_USER="$(id -un 2>/dev/null || true)"',
        'fi',
        'KAWAII_LOGIN_SHELL=""',
        'if [ -n "$KAWAII_USER" ] && command -v getent >/dev/null 2>&1; then',
        '  KAWAII_LOGIN_SHELL="$(getent passwd "$KAWAII_USER" | cut -d: -f7 2>/dev/null || true)"',
        'fi',
        'if [ -z "$KAWAII_LOGIN_SHELL" ] && [ -n "$KAWAII_USER" ] && [ -r /etc/passwd ]; then',
        '  KAWAII_LOGIN_SHELL="$(grep -m1 "^${KAWAII_USER}:" /etc/passwd | cut -d: -f7 2>/dev/null || true)"',
        'fi',
        'KAWAII_LOGIN_SHELL="${KAWAII_LOGIN_SHELL%$\'\\r\'}"',
        'if [ -n "$KAWAII_LOGIN_SHELL" ] && [ -x "$KAWAII_LOGIN_SHELL" ]; then',
        '  KAWAII_SHELL="$KAWAII_LOGIN_SHELL"',
        'elif [ -n "${SHELL:-}" ] && [ -x "$SHELL" ]; then',
        '  KAWAII_SHELL="$SHELL"',
        'elif [ -x /bin/bash ]; then',
        '  KAWAII_SHELL="/bin/bash"',
        'elif [ -x /bin/sh ]; then',
        '  KAWAII_SHELL="/bin/sh"',
        'fi',
        'export KAWAII_LOGIN_SHELL="$KAWAII_LOGIN_SHELL"',
        'export KAWAII_USER="$KAWAII_USER"',
        'export KAWAII_SHELL="$KAWAII_SHELL"',
        'if [ -n "$KAWAII_SHELL" ]; then',
        '  export SHELL="$KAWAII_SHELL"',
        'fi',
        'export KAWAII_LAUNCH_SHELL="$KAWAII_SHELL"',
        'if [ -n "${KAWAII_WSL_START_CWD:-}" ]; then',
        '  KAWAII_WSL_START_CWD="${KAWAII_WSL_START_CWD%$\'\\r\'}"',
        '  if [ -d "$KAWAII_WSL_START_CWD" ]; then',
        '    cd "$KAWAII_WSL_START_CWD" 2>/dev/null || true',
        '  fi',
        'fi',
        '__kawaii_shell_debug="shell=${KAWAII_SHELL} login=${KAWAII_LOGIN_SHELL} env=${SHELL:-} user=${KAWAII_USER}"',
        'if command -v base64 >/dev/null 2>&1; then',
        '  __kawaii_shell_b64="$(printf "%s" "$__kawaii_shell_debug" | base64 | tr -d "\\n")"',
        '  if [ -n "$__kawaii_shell_b64" ]; then',
        '    printf "\\033]1337;KawaiiShell64=%s\\007" "$__kawaii_shell_b64"',
        '  fi',
        'else',
        '  printf "\\033]1337;KawaiiShell=%s\\007" "$__kawaii_shell_debug"',
        'fi',
        'case "$KAWAII_SHELL" in',
        '  *zsh)',
        '    export KAWAII_ORIG_ZDOTDIR="${ZDOTDIR:-}"',
        '    export ZDOTDIR="${KAWAII_WSL_ZDOTDIR:-$HOME}"',
        '    exec "$KAWAII_SHELL" -i',
        '    ;;',
        '  *fish)',
        '    if [ -n "${KAWAII_WSL_FISH:-}" ]; then',
        '      exec "$KAWAII_SHELL" --init-command "source ${KAWAII_WSL_FISH}"',
        '    fi',
        '    exec "$KAWAII_SHELL"',
        '    ;;',
        '  *bash|*sh|"")',
        '    if [ -n "${KAWAII_WSL_BASHRC:-}" ]; then',
        '      exec "${KAWAII_SHELL:-/bin/bash}" --rcfile "${KAWAII_WSL_BASHRC}" -i',
        '    fi',
        '    exec "${KAWAII_SHELL:-/bin/bash}" -i',
        '    ;;',
        '  *)',
        '    exec "$KAWAII_SHELL" -i',
        '    ;;',
        'esac',
      ].join('\n');
      shellArgs = args.concat(['--', 'sh', '-lc', launchScript]);
    } else {
      const shellName = path.basename(shell).toLowerCase();
      if (!isWindows && shell) {
        env.SHELL = shell;
      } else if (!env.SHELL) {
        env.SHELL = shell;
      }

      if (isWindows) {
        const psScript = [
          '$esc=[char]27',
          '$bel=[char]7',
          '$global:__KawaiiLastHistoryId = 0',
          '$global:__KawaiiLastCmd = $null',
          '$global:__KawaiiUseHistory = $true',
          'function global:__KawaiiEmitCwd { ' +
            '$loc = $executionContext.SessionState.Path.CurrentLocation; ' +
            'if ($loc.Provider.Name -eq "FileSystem") { ' +
            'Write-Host -NoNewline "$esc]9;9;$($loc.ProviderPath)$bel" ' +
            '} ' +
          '}',
          'function global:__KawaiiEmitCmdLine { param([string]$cmd) ' +
            'if ([string]::IsNullOrWhiteSpace($cmd)) { return } ' +
            '$global:__KawaiiLastCmd = $cmd; ' +
            '$bytes = [Text.Encoding]::UTF8.GetBytes($cmd); ' +
            '$b64 = [Convert]::ToBase64String($bytes); ' +
            'Write-Host -NoNewline "$esc]1337;KawaiiCmd64=$b64$bel" ' +
          '}',
          'function global:__KawaiiEmitCmdHistory { ' +
            'try { $h = Get-History -Count 1 } catch { $h = $null } ' +
            'if ($h -and $h.Id -ne $global:__KawaiiLastHistoryId) { ' +
              '$global:__KawaiiLastHistoryId = $h.Id; ' +
              '$cmd = $h.CommandLine; ' +
              'if ($cmd) { __KawaiiEmitCmdLine $cmd } ' +
            '} ' +
          '}',
          'try { Import-Module PSReadLine -ErrorAction SilentlyContinue } catch {}',
          'try { ' +
            'if (Get-Command -Name Get-PSReadLineOption -ErrorAction SilentlyContinue) { ' +
              '$global:__KawaiiUseHistory = $false; ' +
              'Set-PSReadLineKeyHandler -Key Enter -ScriptBlock { ' +
                'param($key, $arg) ' +
                '$line = $null; $cursor = $null; ' +
                'try { [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor) } catch {} ' +
                'if ($line) { __KawaiiEmitCmdLine $line } ' +
                '[Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine() ' +
              '} ' +
            '} ' +
          '} catch {}',
          'function global:prompt { ' +
            '__KawaiiEmitCwd; ' +
            'if ($global:__KawaiiUseHistory) { __KawaiiEmitCmdHistory } ' +
            '$loc = $executionContext.SessionState.Path.CurrentLocation; ' +
            'return "PS $loc> " ' +
          '}',
        ].join('; ');
        const encoded = encodePowerShellCommand(psScript);
        shellArgs = ['-NoLogo', '-NoExit', '-EncodedCommand', encoded];
      } else if (shellName.includes('zsh')) {
        const { zshDir } = ensureShellIntegrationFiles();
        const origZdotdir = typeof env.ZDOTDIR === 'string' ? env.ZDOTDIR : '';
        env.KAWAII_ORIG_ZDOTDIR = origZdotdir;
        if (env.KAWAII_ORIG_ZDOTDIR === zshDir) {
          env.KAWAII_ORIG_ZDOTDIR = '';
        }
        env.ZDOTDIR = zshDir;
        shellArgs = ['-i', '--login'];
      } else if (shellName.includes('bash')) {
        const { bashRcPath } = ensureShellIntegrationFiles();
        shellArgs = ['--rcfile', bashRcPath, '-i'];
      } else if (shellName.includes('fish')) {
        const { fishConfigPath } = ensureShellIntegrationFiles();
        shellArgs = ['--init-command', `source "${fishConfigPath.replace(/"/g, '\\"')}"`];
      } else {
        shellArgs = ['--login'];
      }
    }

    let cwd = os.homedir();
    if (desiredCwd && !(isWindows && wslDistro)) {
      try {
        if (fs.existsSync(desiredCwd) && fs.statSync(desiredCwd).isDirectory()) {
          cwd = desiredCwd;
        }
      } catch (_) {
        // ignore
      }
    }

    const proc = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd,
      env,
    });

    proc.onData((data) => {
      onData(id, data);
    });

    proc.onExit(({ exitCode: _exitCode }) => {
      this.sessions.delete(id);
    });

    this.sessions.set(id, proc);
  }

  write(tabId, data) {
    const proc = this.sessions.get(tabId);
    if (proc) {
      proc.write(data);
    }
  }

  resize(tabId, cols, rows) {
    const proc = this.sessions.get(tabId);
    if (proc) {
      try {
        proc.resize(cols, rows);
      } catch (e) {
        console.error('Resize error:', e);
      }
    }
  }

  kill(tabId) {
    if (!tabId) {
      this.killAll();
      return;
    }
    const proc = this.sessions.get(tabId);
    if (proc) {
      try {
        proc.kill();
      } catch (_) {
        // プロセスが既に終了している場合は無視
      }
      this.sessions.delete(tabId);
    }
  }

  killAll() {
    for (const proc of this.sessions.values()) {
      try {
        proc.kill();
      } catch (_) {
        // プロセスが既に終了している場合は無視
      }
    }
    this.sessions.clear();
  }
}

module.exports = PtyManager;
