const { spawn } = require('child_process');
const os = require('os');

const { AgentCliDetector, getClaudeFallbackPaths } = require('./agent-cli');

const DEFAULT_TIMEOUT_MS = 35000;

class ClaudeCliRunner {
  constructor({ cliDetector = null } = {}) {
    this.cliDetector = cliDetector || new AgentCliDetector();
    this.cachedPath = null;
  }

  async resolveCliPath({ refresh = false } = {}) {
    const pathValue = await this.cliDetector.resolveLocal('claude', {
      fallbackPaths: getClaudeFallbackPaths(),
      refresh,
      allowWindowsAppStub: false,
    });
    this.cachedPath = pathValue || null;
    return this.cachedPath;
  }

  async run({
    prompt,
    model,
    resumeSessionId = null,
    allowTools = false,
    addDirs = [],
    disallowedTools = '*',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    entrypoint = 'sdk-js',
    cwd = null,
    cliPath = null,
  } = {}) {
    const resolvedCliPath = cliPath || this.cachedPath || await this.resolveCliPath();
    if (!resolvedCliPath) {
      return { ok: false, error: 'Claude CLI not found' };
    }

    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--model', model,
      '--verbose',
      '--print', '',
    ];

    if (allowTools && Array.isArray(addDirs) && addDirs.length > 0) {
      args.push('--add-dir', ...addDirs);
    }
    if (!allowTools && disallowedTools) {
      args.push('--disallowedTools', disallowedTools);
    }
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    }

    const env = {
      ...process.env,
      CLAUDE_CODE_ENTRYPOINT: entrypoint,
    };
    delete env.ANTHROPIC_API_KEY;
    delete env.KAWAII_PANE_ID;
    delete env.KAWAII_NOTIFY_PATH;
    delete env.KAWAII_NOTIFY_DEBUG_PATH;
    delete env.KAWAII_TERMINAL_INSTANCE_ID;

    const options = {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: cwd || os.tmpdir(),
    };

    if (process.platform === 'win32') {
      options.windowsHide = true;
    }
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolvedCliPath)) {
      options.shell = true;
    }

    return new Promise((resolve) => {
      let settled = false;
      let timeoutId = null;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        resolve(result);
      };

      let proc;
      try {
        proc = spawn(resolvedCliPath, args, options);
      } catch (e) {
        settle({ ok: false, error: e?.message || 'Failed to start Claude CLI' });
        return;
      }

      let stdoutBuffer = '';
      let stdout = '';
      let stderr = '';
      let fullText = '';
      let errorText = '';
      let resultSessionId = null;

      const handleLine = (line) => {
        const trimmed = String(line || '').trim();
        if (!trimmed) return;
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch (_) {
          return;
        }
        const eventType = event?.type;
        if (eventType === 'assistant') {
          const message = event.message || {};
          const content = Array.isArray(message.content) ? message.content : [];
          for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              fullText += block.text;
            }
          }
          return;
        }
        if (eventType === 'result') {
          if (event.is_error) {
            errorText = event.result || event.error || '';
            return;
          }
          if (!fullText && typeof event.result === 'string') {
            fullText = event.result;
          }
          if (event.session_id) {
            resultSessionId = event.session_id;
          }
        }
      };

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || '';
        for (const line of lines) {
          handleLine(line);
        }
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (stdoutBuffer.trim()) {
          handleLine(stdoutBuffer);
        }

        const trimmedStdout = stdout.trim();

        if (code !== 0) {
          const cleanedStderr = stderr.trim();
          const message = errorText || cleanedStderr || trimmedStdout || 'CLI error';
          settle({ ok: false, error: `CLI error: ${message}` });
          return;
        }

        const message = fullText.trim();
        if (!message && errorText) {
          settle({ ok: false, error: `CLI error: ${errorText}` });
          return;
        }
        const result = { ok: true, text: message };
        if (resultSessionId) {
          result.session_id = resultSessionId;
        }
        settle(result);
      });

      proc.on('error', (error) => {
        settle({ ok: false, error: error?.message || 'Spawn error' });
      });

      const inputData = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: prompt,
        },
      });

      try {
        proc.stdin?.write?.(`${inputData}\n`);
        proc.stdin?.end?.();
      } catch (e) {
        try { proc.kill(); } catch (_) { /* noop */ }
        settle({ ok: false, error: e?.message || 'Failed to write stdin' });
        return;
      }

      timeoutId = setTimeout(() => {
        try {
          if (proc && proc.exitCode == null && !proc.killed) {
            proc.kill();
          }
        } catch (_) { /* noop */ }
        settle({ ok: false, error: 'Timeout' });
      }, timeoutMs);
    });
  }
}

module.exports = {
  ClaudeCliRunner,
};
