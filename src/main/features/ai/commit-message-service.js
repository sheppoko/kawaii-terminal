const { ClaudeCliRunner } = require('../../infra/agents/claude-cli');

const MAX_DIFF_CHARS = 6000;
const DEFAULT_MODEL = 'claude-haiku-4-5';

function clampText(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function buildPrompt({ language, status, diffStat, diff, forceLanguage = false } = {}) {
  const isJa = language !== 'en';
  const header = isJa
    ? 'あなたはgitのコミットメッセージを作るアシスタントです。'
    : 'You are an assistant that writes git commit messages.';
  const rules = isJa
    ? [
      '必ず日本語で書く',
      '1行だけ（通常運用のサブジェクト）',
      '命令形で簡潔に',
      '末尾に句点やクォートを付けない',
      `50文字以内を目安`,
      'コードブロックや説明は不要',
      '結果はメッセージ本文のみ',
    ]
    : [
      'Write a single-line subject only',
      'Use imperative mood and be concise',
      'No trailing period or quotes',
      'Keep the subject line <= 72 characters',
      'No code blocks or explanations',
      'Return only the message',
    ];
  if (forceLanguage && isJa) {
    rules.unshift('英語は不可');
  }
  const parts = [
    header,
    rules.join(isJa ? ' / ' : ' / '),
    '',
    '## Status',
    status || '(empty)',
    '',
    '## Diffstat',
    diffStat || '(empty)',
    '',
    '## Diff',
    diff || '(empty)',
  ];
  return parts.join('\n');
}

function normalizeLanguage(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw === 'en' ? 'en' : 'ja';
}

function extractFirstLine(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function sanitizeMessage(value, { maxLength = 0, singleLine = true } = {}) {
  const raw = String(value || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return '';
  const fenced = raw.match(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/);
  let text = fenced ? fenced[1] : raw;
  text = text.replace(/^["'`]+/, '').replace(/["'`]+$/, '');
  text = text.replace(/^(commit message|message|コミットメッセージ)[:：]\s*/i, '');
  text = text.replace(/^\s*\n+/, '').replace(/\n+\s*$/, '');
  text = singleLine ? extractFirstLine(text) : text.trim();
  if (!text) return '';
  if (maxLength > 0 && text.length > maxLength) {
    text = text.slice(0, maxLength).trim();
  }
  return text.trim();
}

function containsJapanese(text) {
  return /[ぁ-んァ-ン一-龥]/.test(String(text || ''));
}

class CommitMessageService {
  constructor({ settingsStore, capabilityService, gitService, cliRunner } = {}) {
    this.settingsStore = settingsStore || null;
    this.capabilityService = capabilityService || null;
    this.gitService = gitService || null;
    this.cliRunner = cliRunner || new ClaudeCliRunner();
  }

  getLanguage() {
    const settings = this.settingsStore?.get?.() || {};
    const language = settings?.summaries?.language || settings?.cheer?.language || 'en';
    return normalizeLanguage(language);
  }

  getClaudeModel() {
    const settings = this.settingsStore?.get?.() || {};
    const model = settings?.summaries?.claude?.model;
    if (typeof model === 'string' && model.trim()) return model.trim();
    return DEFAULT_MODEL;
  }

  async ensureAvailable() {
    if (!this.capabilityService?.checkFeature) return { ok: false, error: 'Capability unavailable' };
    const result = await this.capabilityService.checkFeature('commitMessage');
    if (!result?.available || result?.provider !== 'claude') {
      return { ok: false, unavailable: true, missing: ['claude'] };
    }
    return { ok: true, provider: 'claude' };
  }

  async buildDiffPayload({ cwd, wslDistro } = {}) {
    if (!this.gitService?.checkRepo) return null;
    const repo = await this.gitService.checkRepo({ cwd, wslDistro });
    if (!repo.available) return null;
    const statusResult = await this.gitService.getStatus({ cwd, wslDistro });
    const statusText = statusResult.ok
      ? [
        `branch: ${statusResult.branch || ''}`.trim(),
        `changed: ${statusResult.counts?.total || 0}`,
        `staged: ${statusResult.counts?.staged || 0}`,
        `unstaged: ${statusResult.counts?.unstaged || 0}`,
        `untracked: ${statusResult.counts?.untracked || 0}`,
      ].filter(Boolean).join('\n')
      : '';
    const diffStat = await this.gitService.getScopeDiff({
      cwd,
      wslDistro,
      stat: true,
    });
    const diff = await this.gitService.getScopeDiff({
      cwd,
      wslDistro,
      stat: false,
    });
    const statText = diffStat?.ok ? diffStat.diff : '';
    const diffText = diff?.ok ? diff.diff : '';
    return {
      status: statusText,
      diffStat: statText,
      diff: clampText(diffText, MAX_DIFF_CHARS),
    };
  }

  async generate({ cwd, wslDistro } = {}) {
    const availability = await this.ensureAvailable();
    if (!availability.ok) return availability;
    const payload = await this.buildDiffPayload({ cwd, wslDistro });
    if (!payload) {
      return { ok: false, error: 'Git repo not available' };
    }
    const language = this.getLanguage();
    let prompt = buildPrompt({ language, ...payload });
    const model = this.getClaudeModel();
    const result = await this.cliRunner.run({
      prompt,
      model,
      allowTools: false,
      disallowedTools: '*',
      entrypoint: 'kawaii-terminal',
    });
    if (!result?.ok) {
      return { ok: false, error: result?.error || 'Claude failed' };
    }
    let message = sanitizeMessage(result.text || result.output || result.message || '', {
      singleLine: true,
    });
    if (language !== 'en' && message && !containsJapanese(message)) {
      prompt = buildPrompt({ language, ...payload, forceLanguage: true });
      const retry = await this.cliRunner.run({
        prompt,
        model,
        allowTools: false,
        disallowedTools: '*',
        entrypoint: 'kawaii-terminal',
      });
      if (retry?.ok) {
        message = sanitizeMessage(retry.text || retry.output || retry.message || '', {
          singleLine: true,
        });
      }
    }
    if (!message) return { ok: false, error: 'Empty message' };
    return { ok: true, message, provider: 'claude' };
  }
}

module.exports = {
  CommitMessageService,
};
