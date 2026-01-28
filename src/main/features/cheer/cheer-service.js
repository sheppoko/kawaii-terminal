const { ClaudeCliRunner } = require('../../infra/agents/claude-cli');

const CLAUDE_DEFAULT_MODEL = 'claude-opus-4-5-20251101';

const DEP_CHECK_CACHE_MS = 5000;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function buildCheerPrompt(language, sessionId) {
  const now = new Date();
  const year = now.getFullYear();
  const month = pad2(now.getMonth() + 1);
  const day = pad2(now.getDate());
  const hour = now.getHours();
  const minute = pad2(now.getMinutes());
  const datetimeStr = `${year}-${month}-${day} ${pad2(hour)}:${minute}`;
  const isJa = language === 'ja';

  let timePeriod = 'night';
  if (hour >= 5 && hour < 12) {
    timePeriod = isJa ? '朝' : 'morning';
  } else if (hour >= 12 && hour < 17) {
    timePeriod = isJa ? '昼' : 'afternoon';
  } else if (hour >= 17 && hour < 21) {
    timePeriod = isJa ? '夕方' : 'evening';
  } else {
    timePeriod = isJa ? '夜' : 'night';
  }

  if (sessionId) {
    return isJa
      ? `次（${timePeriod}、${datetimeStr}）`
      : `Next (${timePeriod}, ${datetimeStr})`;
  }

  if (isJa) {
    return `あなたはかわいいアニメ女の子。開発者のそばでずっと見守りながら応援している。100文字程度で1つ応援して。現在: ${datetimeStr}（${timePeriod}）。禁止: 「早く寝て」「休んで」など作業を止めさせる応援。`;
  }

  return `You're a cute anime girl always by the developer's side, watching and cheering them on. Give one encouragement (~30 words). Now: ${datetimeStr} (${timePeriod}). Never say 'go to sleep' or 'take a break' - always encourage working.`;
}

class CheerService {
  constructor() {
    this.isProcessing = false;
    this.cliRunner = new ClaudeCliRunner();
    this.depsCache = null;
    this.depsCheckedAt = 0;
  }

  async checkDependencies({ refresh = false } = {}) {
    const now = Date.now();
    if (!refresh && this.depsCache && now - this.depsCheckedAt < DEP_CHECK_CACHE_MS) {
      return this.depsCache;
    }

    const claudePath = await this.cliRunner.resolveCliPath({ refresh });
    const claudeOk = Boolean(claudePath);
    const missing = [];
    if (!claudeOk) missing.push('claude');

    this.depsCache = {
      available: claudeOk,
      missing,
      claude: claudeOk
        ? { ok: true, path: claudePath }
        : { ok: false, path: null },
    };
    this.depsCheckedAt = now;
    return this.depsCache;
  }

  /**
   * 応援メッセージを生成
   * @param {string} language - 言語 ('ja' | 'en')
   * @param {string} sessionId - セッションID（継続用）
   * @returns {Promise<{message?: string, session_id?: string, error?: string}>}
   */
  async generateCheer(language = 'ja', sessionId = null) {
    if (this.isProcessing) {
      return { error: 'Already processing' };
    }

    this.isProcessing = true;

    try {
      const deps = await this.checkDependencies();
      if (!deps.available) {
        return { unavailable: true, missing: deps.missing };
      }
      const result = await this.runClaude(language, sessionId);
      return result;
    } finally {
      this.isProcessing = false;
    }
  }

  async runClaude(language, sessionId) {
    const prompt = buildCheerPrompt(language, sessionId);
    const model = process.env.CHEER_MODEL || CLAUDE_DEFAULT_MODEL;
    const result = await this.cliRunner.run({
      prompt,
      model,
      resumeSessionId: sessionId || null,
      allowTools: false,
      disallowedTools: '*',
      entrypoint: 'sdk-js',
    });
    if (!result?.ok) {
      return { error: result?.error || 'CLI error' };
    }
    const payload = { message: String(result.text || '').trim() };
    if (result.session_id) {
      payload.session_id = result.session_id;
    }
    return payload;
  }
}

module.exports = CheerService;
