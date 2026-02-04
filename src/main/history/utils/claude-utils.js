const { extractTextFromContent, normalizeRole } = require('./text-utils');

const CLAUDE_COMMAND_TRANSCRIPT_RE = /^\s*<(?:local-command-(?:stdout|stderr|caveat)|command-(?:name|message|args))\b/i;

function isClaudeCommandTranscriptText(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return CLAUDE_COMMAND_TRANSCRIPT_RE.test(text);
}

function resolveClaudeMessage(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.message && typeof entry.message === 'object') return entry.message;
  const payload = entry.payload;
  if (payload && typeof payload === 'object') {
    if (payload.message && typeof payload.message === 'object') return payload.message;
    if (payload.role || payload.content || payload.text || payload.input || payload.output) return payload;
    return payload;
  }
  const data = entry.data;
  if (data && typeof data === 'object') {
    if (data.message && typeof data.message === 'object') return data.message;
    if (data.role || data.content || data.text || data.input || data.output) return data;
    return data;
  }
  if (entry.role || entry.content || entry.text || entry.input || entry.output) return entry;
  return null;
}

function resolveClaudeRole(entry) {
  const msg = resolveClaudeMessage(entry);
  const role = normalizeRole(msg?.role ?? entry.role ?? entry.sender ?? entry.type);
  if (role === 'user' || role === 'assistant') return role;
  return '';
}

function extractClaudeMessageText(entry) {
  const msg = resolveClaudeMessage(entry);
  if (entry?.isMeta === true || msg?.isMeta === true) return '';
  const content = msg?.content ?? msg?.text ?? msg?.message ?? msg?.input ?? msg?.output
    ?? entry.content ?? entry.text ?? entry.input ?? entry.output;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const type = String(content.type || '').toLowerCase();
    if (type === 'tool_result' || type === 'tool_use') return '';
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (item && typeof item === 'object') {
        const type = String(item.type || '').toLowerCase();
        if (type === 'tool_result' || type === 'tool_use') continue;
      }
      const text = extractTextFromContent(item);
      if (!text) continue;
      if (isClaudeCommandTranscriptText(text)) continue;
      parts.push(text);
    }
    return parts.join('\n').trim();
  }
  const text = extractTextFromContent(content).trim();
  if (!text) return '';
  if (isClaudeCommandTranscriptText(text)) return '';
  return text;
}

const CLAUDE_MESSAGE_CONTENT_KEYS = ['content', 'text', 'message', 'input', 'output'];

function getClaudeMessageContentSlot(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const msg = resolveClaudeMessage(entry);
  if (msg && typeof msg === 'object') {
    for (const key of CLAUDE_MESSAGE_CONTENT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(msg, key)) {
        return { owner: msg, key, content: msg[key] };
      }
    }
  }
  if (msg !== entry) {
    for (const key of CLAUDE_MESSAGE_CONTENT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(entry, key)) {
        return { owner: entry, key, content: entry[key] };
      }
    }
  }
  return null;
}

function getClaudeToolUseId(block) {
  const id = block?.id ?? block?.tool_use_id;
  return String(id || '').trim();
}

function getClaudeToolResultId(block) {
  const id = block?.tool_use_id ?? block?.id;
  return String(id || '').trim();
}

function forEachClaudeToolBlock(content, visitor) {
  if (!content) return;
  if (Array.isArray(content)) {
    for (const item of content) {
      forEachClaudeToolBlock(item, visitor);
    }
    return;
  }
  if (typeof content !== 'object') return;
  const type = String(content.type || '').toLowerCase();
  if (type === 'tool_use' || type === 'tool_result') {
    visitor(content, type);
  }
}

function filterClaudeToolBlocks(content, { allowedToolUseIds, allowedToolResultIds, seenToolUses }) {
  if (!content) return { content, removedAny: false };
  if (Array.isArray(content)) {
    let removedAny = false;
    const next = [];
    for (const item of content) {
      if (item && typeof item === 'object') {
        const type = String(item.type || '').toLowerCase();
        if (type === 'tool_use') {
          const id = getClaudeToolUseId(item);
          if (!id || !allowedToolUseIds.has(id)) {
            removedAny = true;
            continue;
          }
          seenToolUses.add(id);
          next.push(item);
          continue;
        }
        if (type === 'tool_result') {
          const id = getClaudeToolResultId(item);
          if (!id || !allowedToolResultIds.has(id) || !seenToolUses.has(id)) {
            removedAny = true;
            continue;
          }
          next.push(item);
          continue;
        }
      }
      next.push(item);
    }
    return { content: next, removedAny };
  }

  if (typeof content === 'object') {
    const type = String(content.type || '').toLowerCase();
    if (type === 'tool_use') {
      const id = getClaudeToolUseId(content);
      if (!id || !allowedToolUseIds.has(id)) {
        return { content: null, removedAny: true };
      }
      seenToolUses.add(id);
      return { content, removedAny: false };
    }
    if (type === 'tool_result') {
      const id = getClaudeToolResultId(content);
      if (!id || !allowedToolResultIds.has(id) || !seenToolUses.has(id)) {
        return { content: null, removedAny: true };
      }
      return { content, removedAny: false };
    }
  }

  return { content, removedAny: false };
}

function isClaudeMainConversationEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.isSidechain === true) return false;
  const role = resolveClaudeRole(entry);
  if (role !== 'user' && role !== 'assistant') return false;
  return Boolean(extractClaudeMessageText(entry));
}

function isClaudeUserPromptEntry(entry) {
  if (!isClaudeMainConversationEntry(entry)) return false;
  return resolveClaudeRole(entry) === 'user';
}

function extractClaudeUserPromptText(entry) {
  if (!entry || typeof entry !== 'object') return '';
  return extractClaudeMessageText(entry);
}

function extractClaudeAssistantText(entry) {
  if (!isClaudeMainConversationEntry(entry)) return '';
  if (resolveClaudeRole(entry) !== 'assistant') return '';
  return extractClaudeMessageText(entry);
}

function extractClaudeCwd(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const meta = entry.meta || entry.metadata || entry.context || entry.message?.metadata || entry.message?.meta || {};
  const candidates = [
    entry.cwd,
    entry.workdir,
    entry.working_directory,
    entry.project_path,
    entry.projectPath,
    entry.repo_path,
    entry.repoPath,
    entry.base_path,
    entry.basePath,
    entry.path,
    meta.cwd,
    meta.workdir,
    meta.working_directory,
    meta.project_path,
    meta.projectPath,
    meta.repo_path,
    meta.repoPath,
    meta.base_path,
    meta.basePath,
    meta.path,
  ];
  let fallback = '';
  for (const candidate of candidates) {
    const raw = String(candidate || '').trim();
    if (!raw) continue;
    const normalized = raw.replace(/\\/g, '/').toLowerCase();
    if (normalized.includes('/.claude/projects/')) {
      if (!fallback) fallback = raw;
      continue;
    }
    return raw;
  }
  return fallback;
}

function resolveClaudeCwdFromEntries(entries) {
  if (!Array.isArray(entries)) return '';
  for (const entry of entries) {
    const candidate = extractClaudeCwd(entry);
    if (candidate) return candidate;
  }
  return '';
}

module.exports = {
  extractClaudeAssistantText,
  extractClaudeCwd,
  extractClaudeMessageText,
  extractClaudeUserPromptText,
  filterClaudeToolBlocks,
  forEachClaudeToolBlock,
  getClaudeMessageContentSlot,
  getClaudeToolResultId,
  getClaudeToolUseId,
  isClaudeMainConversationEntry,
  isClaudeUserPromptEntry,
  resolveClaudeCwdFromEntries,
  resolveClaudeMessage,
  resolveClaudeRole,
};
