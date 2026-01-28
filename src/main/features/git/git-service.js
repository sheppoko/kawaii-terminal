const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 8000;
const COMMIT_TIMEOUT_MS = 15000;
const PUSH_TIMEOUT_MS = 20000;

function execFileText(command, args, { cwd = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd: cwd || undefined, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          ok: false,
          error,
          stdout: String(stdout || ''),
          stderr: String(stderr || error.message || ''),
        });
        return;
      }
      resolve({ ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function normalizeCwd(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  if (process.platform === 'win32' && trimmed.startsWith('/')) {
    const match = trimmed.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
    if (match) {
      const drive = match[1].toUpperCase();
      const rest = match[2] ? match[2].replace(/\//g, '\\') : '';
      return `${drive}:\\${rest}`;
    }
  }
  return trimmed;
}

function normalizeGitPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

class GitService {
  constructor() {
    this.repoCache = new Map();
    this.cacheMs = 4000;
  }

  getCachedRepo(cwd) {
    const entry = this.repoCache.get(cwd);
    if (!entry) return null;
    if (Date.now() - entry.at > this.cacheMs) {
      this.repoCache.delete(cwd);
      return null;
    }
    return entry;
  }

  setCachedRepo(cwd, repoRoot) {
    if (!cwd || !repoRoot) return;
    this.repoCache.set(cwd, { root: repoRoot, at: Date.now() });
  }

  async resolveRepoRoot(cwd) {
    const cached = this.getCachedRepo(cwd);
    if (cached?.root) return cached.root;
    const result = await execFileText('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { cwd });
    if (!result.ok) return '';
    const root = String(result.stdout || '').trim().split(/\r?\n/)[0] || '';
    if (!root) return '';
    this.setCachedRepo(cwd, root);
    return root;
  }

  buildScopedPath(repoRoot, cwd) {
    const relPath = path.relative(repoRoot, cwd);
    if (!relPath) return { relPath: '', argPath: '' };
    if (relPath.startsWith('..') || path.isAbsolute(relPath)) return null;
    return {
      relPath,
      argPath: relPath || '',
    };
  }

  async checkRepo({ cwd, wslDistro } = {}) {
    const safeCwd = normalizeCwd(cwd);
    if (!safeCwd || wslDistro) return { ok: true, available: false, reason: wslDistro ? 'wsl' : 'cwd' };
    if (!fs.existsSync(safeCwd)) return { ok: true, available: false, reason: 'missing' };
    const repoRoot = await this.resolveRepoRoot(safeCwd);
    if (!repoRoot) return { ok: true, available: false, reason: 'not-git' };
    const scoped = this.buildScopedPath(repoRoot, safeCwd);
    if (!scoped) return { ok: true, available: false, reason: 'outside' };
    return {
      ok: true,
      available: true,
      repoRoot,
      relPath: scoped.relPath,
      cwd: safeCwd,
    };
  }

  parseStatus(stdout) {
    const lines = String(stdout || '').split(/\r?\n/).filter(Boolean);
    let branch = '';
    let ahead = 0;
    let behind = 0;
    if (lines.length > 0 && lines[0].startsWith('##')) {
      const head = lines.shift().replace(/^##\s*/, '').trim();
      branch = head;
      const match = head.match(/\[ahead (\d+)\]/i);
      if (match) ahead = Number(match[1]) || 0;
      const behindMatch = head.match(/\[behind (\d+)\]/i);
      if (behindMatch) behind = Number(behindMatch[1]) || 0;
    }

    const files = lines.map((line) => {
      const status = line.slice(0, 2);
      const file = line.slice(3).trim();
      const indexStatus = status[0] || ' ';
      const workTreeStatus = status[1] || ' ';
      const untracked = status === '??';
      return {
        path: file,
        status,
        indexStatus,
        workTreeStatus,
        staged: indexStatus !== ' ' && !untracked,
        unstaged: workTreeStatus !== ' ' && !untracked,
        untracked,
      };
    });

    const counts = {
      total: files.length,
      staged: files.filter(f => f.staged).length,
      unstaged: files.filter(f => f.unstaged).length,
      untracked: files.filter(f => f.untracked).length,
    };

    return { branch, ahead, behind, files, counts };
  }

  async getStatus({ cwd, wslDistro } = {}) {
    const repo = await this.checkRepo({ cwd, wslDistro });
    if (!repo.available) return { ok: false, error: repo.reason || 'not-git' };
    const relArg = repo.relPath ? repo.relPath : '.';
    const result = await execFileText(
      'git',
      ['-C', repo.repoRoot, 'status', '--porcelain=v1', '-sb', '--', relArg],
      { cwd: repo.cwd },
    );
    if (!result.ok) {
      return { ok: false, error: result.stderr || 'status-failed', stdout: result.stdout, stderr: result.stderr };
    }
    const parsed = this.parseStatus(result.stdout);
    return {
      ok: true,
      repoRoot: repo.repoRoot,
      relPath: repo.relPath,
      cwd: repo.cwd,
      ...parsed,
    };
  }

  async getDiff({ cwd, wslDistro, file, staged = false, base = '' } = {}) {
    const repo = await this.checkRepo({ cwd, wslDistro });
    if (!repo.available) return { ok: false, error: repo.reason || 'not-git' };
    const filePath = String(file || '').trim();
    if (!filePath) return { ok: false, error: 'missing-file' };
    const relBase = normalizeGitPath(repo.relPath || '');
    const target = normalizeGitPath(filePath);
    if (relBase && relBase !== '.' && !target.startsWith(`${relBase}/`)) {
      return { ok: false, error: 'outside-scope' };
    }
    const args = ['-C', repo.repoRoot, 'diff'];
    const baseArg = String(base || '').trim();
    if (baseArg) {
      args.push(baseArg);
    } else if (staged) {
      args.push('--staged');
    }
    args.push('--', filePath);
    const result = await execFileText('git', args, { cwd: repo.cwd });
    if (!result.ok) {
      return { ok: false, error: result.stderr || 'diff-failed', stdout: result.stdout, stderr: result.stderr };
    }
    return { ok: true, diff: result.stdout || '' };
  }

  async getScopeDiff({ cwd, wslDistro, stat = false } = {}) {
    const repo = await this.checkRepo({ cwd, wslDistro });
    if (!repo.available) return { ok: false, error: repo.reason || 'not-git' };
    const relArg = repo.relPath ? repo.relPath : '.';
    const args = ['-C', repo.repoRoot, 'diff'];
    if (stat) args.push('--stat');
    args.push('HEAD', '--', relArg);
    const result = await execFileText('git', args, { cwd: repo.cwd });
    if (!result.ok) {
      return { ok: false, error: result.stderr || 'diff-failed', stdout: result.stdout, stderr: result.stderr };
    }
    return { ok: true, diff: result.stdout || '' };
  }

  async commit({ cwd, wslDistro, message } = {}) {
    const repo = await this.checkRepo({ cwd, wslDistro });
    if (!repo.available) return { ok: false, error: repo.reason || 'not-git' };
    const msg = String(message || '').trim();
    if (!msg) return { ok: false, error: 'missing-message' };
    const relArg = repo.relPath ? repo.relPath : '.';
    const addResult = await execFileText(
      'git',
      ['-C', repo.repoRoot, 'add', '-A', '--', relArg],
      { cwd: repo.cwd },
    );
    if (!addResult.ok) {
      return { ok: false, error: addResult.stderr || 'add-failed', stdout: addResult.stdout, stderr: addResult.stderr };
    }
    const commitResult = await execFileText(
      'git',
      ['-C', repo.repoRoot, 'commit', '-m', msg, '--', relArg],
      { cwd: repo.cwd, timeoutMs: COMMIT_TIMEOUT_MS },
    );
    if (!commitResult.ok) {
      return { ok: false, error: commitResult.stderr || 'commit-failed', stdout: commitResult.stdout, stderr: commitResult.stderr };
    }
    const hashResult = await execFileText(
      'git',
      ['-C', repo.repoRoot, 'rev-parse', 'HEAD'],
      { cwd: repo.cwd },
    );
    const hash = hashResult.ok ? String(hashResult.stdout || '').trim().split(/\r?\n/)[0] : '';
    return {
      ok: true,
      hash,
      stdout: commitResult.stdout || '',
      stderr: commitResult.stderr || '',
    };
  }

  async push({ cwd, wslDistro } = {}) {
    const repo = await this.checkRepo({ cwd, wslDistro });
    if (!repo.available) return { ok: false, error: repo.reason || 'not-git' };
    const result = await execFileText(
      'git',
      ['-C', repo.repoRoot, 'push'],
      { cwd: repo.cwd, timeoutMs: PUSH_TIMEOUT_MS },
    );
    if (!result.ok) {
      return { ok: false, error: result.stderr || 'push-failed', stdout: result.stdout, stderr: result.stderr };
    }
    return { ok: true, stdout: result.stdout || '', stderr: result.stderr || '' };
  }
}

module.exports = {
  GitService,
};
