const {
  listLocalClaudeRoots,
  listLocalCodexRoots,
  listWslClaudeRoots,
  listWslCodexRoots,
} = require('./agent-roots');
const { AgentCliDetector, getClaudeFallbackPaths } = require('./agent-cli');

function buildRootsStatus(paths) {
  const list = Array.isArray(paths) ? paths : [];
  return {
    present: list.length > 0,
    paths: list,
  };
}

class AgentPresenceService {
  constructor({
    cacheMs = 5000,
    cliDetector = null,
  } = {}) {
    this.cacheMs = cacheMs;
    this.cliDetector = cliDetector || new AgentCliDetector({ cacheMs });
    this.cached = null;
    this.cachedAt = 0;
  }

  async check({ refresh = false } = {}) {
    const now = Date.now();
    if (!refresh && this.cached && now - this.cachedAt < this.cacheMs) {
      return this.cached;
    }

    const [
      localClaudeRoots,
      localCodexRoots,
      wslClaudeRoots,
      wslCodexRoots,
      localClaudeCli,
      localCodexCli,
      wslClaudeCli,
      wslCodexCli,
    ] = await Promise.all([
      Promise.resolve(listLocalClaudeRoots()),
      Promise.resolve(listLocalCodexRoots()),
      listWslClaudeRoots(),
      listWslCodexRoots(),
      this.cliDetector.detectLocal('claude', {
        fallbackPaths: getClaudeFallbackPaths(),
        refresh,
        allowWindowsAppStub: false,
      }),
      this.cliDetector.detectLocal('codex', {
        refresh,
        allowWindowsAppStub: false,
      }),
      this.cliDetector.detectWsl('claude', { refresh }),
      this.cliDetector.detectWsl('codex', { refresh }),
    ]);

    const value = {
      claude: {
        local: {
          roots: buildRootsStatus(localClaudeRoots),
          cli: localClaudeCli,
        },
        wsl: {
          roots: buildRootsStatus(wslClaudeRoots),
          cli: wslClaudeCli,
        },
      },
      codex: {
        local: {
          roots: buildRootsStatus(localCodexRoots),
          cli: localCodexCli,
        },
        wsl: {
          roots: buildRootsStatus(wslCodexRoots),
          cli: wslCodexCli,
        },
      },
    };

    this.cached = value;
    this.cachedAt = now;
    return value;
  }
}

module.exports = {
  AgentPresenceService,
};
