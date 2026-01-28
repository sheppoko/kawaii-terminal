const HistorySource = require('./base');
const JsonlSource = require('./jsonl-source');
const { ClaudeJsonlSource, resolveClaudeProjectDir } = require('./claude-jsonl-source');
const { CodexJsonlSource } = require('./codex-jsonl-source');

function createDefaultSources({ logger } = {}) {
  const sources = new Map();
  const claude = new ClaudeJsonlSource({ logger });
  const codex = new CodexJsonlSource({ logger });
  sources.set(claude.id, claude);
  sources.set(codex.id, codex);
  return sources;
}

module.exports = {
  createDefaultSources,
  ClaudeJsonlSource,
  CodexJsonlSource,
  HistorySource,
  JsonlSource,
  resolveClaudeProjectDir,
};
