const path = require('path');

const { extractTextFromContent, normalizeRole } = require('../../utils/text-utils');
const { extractCodexCwd, isUuidLike } = require('../../utils/codex-utils');
const {
  buildFallbackId,
  buildSourceBlockId,
  hashString,
  parseTimestampMs,
} = require('../../utils/block-utils');
const { attachWslMetadata, normalizeDedupPaneId } = require('../../infra/wsl-utils');
const { readJsonlFile } = require('../../infra/jsonl-reader');

const CODEX_USER_INSTRUCTIONS_PREFIX = '# AGENTS.md instructions for ';
const CODEX_USER_INSTRUCTIONS_OPEN_TAG_LEGACY = '<user_instructions>';
const CODEX_SKILL_INSTRUCTIONS_PREFIX = '<skill';
const CODEX_SESSION_PREFIX = '<environment_context>';
const CODEX_USER_SHELL_COMMAND_OPEN = '<user_shell_command>';

function isCodexSessionPrefixText(text) {
  const raw = String(text || '').trimStart().toLowerCase();
  return raw.startsWith(CODEX_SESSION_PREFIX);
}

function isCodexUserShellCommandText(text) {
  const raw = String(text || '').trimStart().toLowerCase();
  return raw.startsWith(CODEX_USER_SHELL_COMMAND_OPEN);
}

function isCodexUserInstructionMessage(content) {
  if (!Array.isArray(content) || content.length !== 1) return false;
  const item = content[0];
  if (!item || typeof item !== 'object') return false;
  const type = String(item.type || '').toLowerCase();
  if (type !== 'input_text') return false;
  const text = String(item.text || '');
  return text.startsWith(CODEX_USER_INSTRUCTIONS_PREFIX)
    || text.startsWith(CODEX_USER_INSTRUCTIONS_OPEN_TAG_LEGACY)
    || text.startsWith(CODEX_SKILL_INSTRUCTIONS_PREFIX);
}

function shouldSkipCodexUserMessage(content) {
  if (!Array.isArray(content)) return false;
  if (isCodexUserInstructionMessage(content)) return true;
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const type = String(item.type || '').toLowerCase();
    const text = typeof item.text === 'string' ? item.text : '';
    if (!text) continue;
    if (type === 'input_text') {
      if (isCodexSessionPrefixText(text) || isCodexUserShellCommandText(text)) return true;
    } else if (type === 'output_text') {
      if (isCodexSessionPrefixText(text)) return true;
    }
  }
  return false;
}

function extractCodexContentText(content, role) {
  if (content == null) return '';
  if (Array.isArray(content)) {
    const allowed = role === 'assistant'
      ? new Set(['output_text', 'text'])
      : new Set(['input_text', 'text']);
    const parts = [];
    for (const item of content) {
      if (typeof item === 'string') {
        if (item.trim()) parts.push(item);
        continue;
      }
      if (item && typeof item === 'object') {
        const type = String(item.type || '').toLowerCase();
        if (type && !allowed.has(type)) continue;
        if (typeof item.text === 'string') {
          if (item.text.trim()) parts.push(item.text);
        } else {
          const text = extractTextFromContent(item);
          if (text) parts.push(text);
        }
        continue;
      }
      const text = extractTextFromContent(item);
      if (text) parts.push(text);
    }
    return parts.join('\n').trim();
  }
  return extractTextFromContent(content).trim();
}

function collectMessagesFromArray(messages, userTexts, assistantTexts, roleHint = '') {
  if (!Array.isArray(messages)) return;
  const hint = normalizeRole(roleHint);
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = normalizeRole(message.role || message.sender || message.type || hint);
    const content = message.content ?? message.text ?? message.message ?? message.input ?? message.output;
    const text = extractTextFromContent(content);
    if (!text) continue;
    if (role === 'user') {
      userTexts.push(text);
    } else if (role === 'assistant') {
      assistantTexts.push(text);
    } else if (hint === 'assistant') {
      assistantTexts.push(text);
    } else if (hint === 'user') {
      userTexts.push(text);
    }
  }
}

function extractCodexSessionId(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const meta = entry.meta || entry.metadata || entry.context || {};
  const candidates = [
    entry.session_id,
    entry.sessionId,
    entry.thread_id,
    entry.threadId,
    entry.conversation_id,
    entry.conversationId,
    entry.session,
    entry.thread,
    entry.trace_id,
    entry.request_id,
    meta.session_id,
    meta.sessionId,
    meta.thread_id,
    meta.threadId,
    meta.conversation_id,
    meta.conversationId,
  ];
  for (const candidate of candidates) {
    const raw = String(candidate || '').trim();
    if (raw) return raw;
  }
  return '';
}

function extractCodexForkedFromId(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const payload = entry.payload || entry;
  const meta = payload.meta || payload.metadata || payload.context || {};
  const candidates = [
    payload.forked_from_id,
    payload.forkedFromId,
    entry.forked_from_id,
    entry.forkedFromId,
    meta.forked_from_id,
    meta.forkedFromId,
  ];
  for (const candidate of candidates) {
    const raw = String(candidate || '').trim();
    if (raw) return raw;
  }
  return '';
}

function extractCodexModel(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const meta = entry.meta || entry.metadata || entry.context || {};
  const candidates = [
    entry.model,
    entry.model_name,
    entry.modelName,
    entry.model_id,
    entry.modelId,
    entry.model_slug,
    entry.modelSlug,
    meta.model,
    meta.model_name,
    meta.modelName,
    meta.model_id,
    meta.modelId,
    meta.model_slug,
    meta.modelSlug,
  ];
  for (const candidate of candidates) {
    const raw = String(candidate || '').trim();
    if (raw) return raw;
  }
  return '';
}

function extractCodexTexts(entry) {
  const userTexts = [];
  const assistantTexts = [];

  if (!entry || typeof entry !== 'object') {
    return { userText: '', outputText: '' };
  }

  collectMessagesFromArray(entry.messages, userTexts, assistantTexts);
  collectMessagesFromArray(entry.input, userTexts, assistantTexts, 'user');
  collectMessagesFromArray(entry.output, userTexts, assistantTexts, 'assistant');

  const request = entry.request || entry.req || null;
  if (request) {
    collectMessagesFromArray(request.messages, userTexts, assistantTexts);
    collectMessagesFromArray(request.input, userTexts, assistantTexts, 'user');
  }

  const response = entry.response || entry.res || null;
  if (response) {
    collectMessagesFromArray(response.output, userTexts, assistantTexts, 'assistant');
    collectMessagesFromArray(response.messages, userTexts, assistantTexts, 'assistant');
    if (Array.isArray(response.choices)) {
      for (const choice of response.choices) {
        if (!choice || typeof choice !== 'object') continue;
        const msg = choice.message || choice.delta || choice;
        collectMessagesFromArray([msg], userTexts, assistantTexts, 'assistant');
      }
    }
  }

  if (entry.role && (entry.content || entry.text)) {
    collectMessagesFromArray([entry], userTexts, assistantTexts);
  }

  if (entry.message) {
    const msg = entry.message;
    const role = normalizeRole(msg.role || entry.role || entry.type || entry.event_type || entry.event);
    collectMessagesFromArray([
      { role, content: msg.content ?? msg.text ?? msg.message ?? msg },
    ], userTexts, assistantTexts, role);
  }

  if (entry.content && !entry.role) {
    const roleHint = normalizeRole(entry.type || entry.event_type || entry.event);
    if (roleHint === 'user' || roleHint === 'assistant') {
      collectMessagesFromArray([{ role: roleHint, content: entry.content }], userTexts, assistantTexts, roleHint);
    }
  }

  const inputMessages = entry.input_messages ?? entry.inputMessages ?? entry['input-messages'];
  if (Array.isArray(inputMessages)) {
    collectMessagesFromArray(inputMessages, userTexts, assistantTexts);
  }
  const lastAssistant = entry.last_assistant_message ?? entry.lastAssistantMessage ?? entry['last-assistant-message'];
  if (lastAssistant) {
    collectMessagesFromArray([lastAssistant], userTexts, assistantTexts, 'assistant');
  }

  const extraContainers = [entry.data, entry.payload, entry.record, entry.event, entry.item];
  for (const container of extraContainers) {
    if (!container || container === entry) continue;
    if (typeof container !== 'object') continue;
    const nested = extractCodexTexts(container);
    if (nested.userText) userTexts.push(nested.userText);
    if (nested.outputText) assistantTexts.push(nested.outputText);
  }

  if (userTexts.length === 0) {
    const rawInput = entry.prompt ?? entry.input_text ?? entry.user_input ?? entry.query ?? entry.input ?? entry.request_text ?? entry.command;
    const text = extractTextFromContent(rawInput);
    if (text) userTexts.push(text);
  }

  if (assistantTexts.length === 0) {
    const rawOutput = entry.output_text ?? entry.response_text ?? entry.result ?? entry.output ?? entry.text ?? entry.completion ?? entry.answer ?? entry.response;
    const text = extractTextFromContent(rawOutput);
    if (text) assistantTexts.push(text);
  }

  return {
    userText: userTexts.filter(Boolean).join('\n').trim(),
    outputText: assistantTexts.filter(Boolean).join('\n').trim(),
  };
}

function extractCodexBlockFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const { userText, outputText } = extractCodexTexts(entry);
  if (!userText && !outputText) return null;

  const createdAt = parseTimestampMs(
    entry.created_at
    ?? entry.createdAt
    ?? entry.created_at_ms
    ?? entry.createdAtMs
    ?? entry.timestamp
    ?? entry.timestamp_ms
    ?? entry.time
    ?? entry.ts
    ?? entry.started_at
    ?? entry.startedAt
    ?? entry.start_time
    ?? entry.startTime
    ?? entry.event_time
    ?? entry.eventTime
  );
  const lastOutputAt = parseTimestampMs(
    entry.last_output_at
    ?? entry.updated_at
    ?? entry.completed_at
    ?? entry.end_time
    ?? entry.ended_at
    ?? entry.endTime
    ?? entry.completedAt
  ) || createdAt;

  const safeCreatedAt = createdAt || 0;
  const safeLastOutputAt = lastOutputAt || safeCreatedAt || 0;

  const sourceId = entry.id
    ?? entry.uuid
    ?? entry.request_id
    ?? entry.response_id
    ?? entry.turn_id
    ?? entry.event_id
    ?? entry.trace_id
    ?? entry.message_id
    ?? '';
  const fallbackId = buildFallbackId('codex', userText, outputText, createdAt || Date.now());
  const normalizedId = buildSourceBlockId('codex', sourceId || fallbackId);

  const sessionId = extractCodexSessionId(entry) || 'codex';
  const cwd = extractCodexCwd(entry);
  const paneLabel = cwd ? (path.basename(cwd) || cwd) : 'Codex';
  const model = extractCodexModel(entry);

  const outputSafe = outputText || '';
  const outputHead = outputSafe.slice(0, 400);
  const outputTail = outputSafe.length > 400 ? outputSafe.slice(-400) : outputSafe;

  return {
    id: normalizedId,
    source: 'codex',
    source_id: sourceId || fallbackId,
    session_id: sessionId,
    session_label: sessionId ? sessionId.slice(-6) : 'codex',
    pane_id: cwd || '',
    pane_label: paneLabel,
    inputs: userText ? [userText] : [],
    input: userText || '',
    output_raw: '',
    output_text: outputSafe,
    output_head: outputHead,
    output_tail: outputTail,
    created_at: safeCreatedAt,
    last_output_at: safeLastOutputAt,
    has_output: Boolean(outputSafe.trim()),
    is_tui: false,
    cwd: typeof cwd === 'string' ? cwd : '',
    model: typeof model === 'string' ? model : '',
  };
}

function extractCodexSessionIdFromFilename(filePath) {
  if (!filePath) return '';
  const name = path.basename(filePath);
  const base = name.replace(/\.jsonl$/i, '');
  const uuidMatches = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig);
  if (uuidMatches && uuidMatches.length > 0) {
    return uuidMatches[uuidMatches.length - 1];
  }
  const hexMatches = base.match(/[0-9a-f]{32}/ig);
  if (hexMatches && hexMatches.length > 0) {
    return hexMatches[hexMatches.length - 1];
  }
  const idx = base.lastIndexOf('-');
  if (idx >= 0 && idx < base.length - 1) {
    return base.slice(idx + 1);
  }
  return base || '';
}

function extractCodexMessageEvent(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const timestamp = parseTimestampMs(entry.timestamp ?? entry.ts ?? entry.time);

  if (entry.type !== 'response_item') return null;
  const payload = entry.payload || entry.item || {};
  if (!payload || typeof payload !== 'object' || payload.type !== 'message') return null;
  const role = normalizeRole(payload.role);
  if (role === 'system') return null;
  const payloadContent = payload.content ?? payload.message ?? payload.text;
  if (role === 'user' && shouldSkipCodexUserMessage(payloadContent)) return null;
  const text = extractCodexContentText(payloadContent, role);
  if (!role || !text) return null;
  return { role, text, timestamp };
}

function buildCodexBlockFromTurn({
  sessionId,
  cwd,
  userText,
  assistantTexts,
  createdAt,
  lastOutputAt,
  forkedFromId,
  model,
  allowEmptyOutput = false,
}) {
  const safeUserText = String(userText || '').trim();
  if (!safeUserText) return null;
  const outputText = assistantTexts.filter(Boolean).join('\n').trim();
  if (!allowEmptyOutput && !outputText) return null;
  const fallbackId = buildFallbackId('codex', safeUserText, outputText, createdAt || Date.now());
  const rawId = sessionId ? `${sessionId}:${createdAt || 0}:${hashString(safeUserText)}` : fallbackId;
  const normalizedId = buildSourceBlockId('codex', rawId);
  const paneLabel = cwd ? (path.basename(cwd) || cwd) : 'Codex';

  return {
    id: normalizedId,
    source: 'codex',
    source_id: rawId,
    session_id: sessionId || 'codex',
    session_label: sessionId ? sessionId.slice(-6) : 'codex',
    forked_from_id: forkedFromId || '',
    pane_id: cwd || '',
    pane_label: paneLabel,
    inputs: safeUserText ? [safeUserText] : [],
    input: safeUserText || '',
    output_raw: '',
    output_text: outputText,
    output_head: outputText.slice(0, 400),
    output_tail: outputText.length > 400 ? outputText.slice(-400) : outputText,
    created_at: createdAt || 0,
    last_output_at: lastOutputAt || createdAt || 0,
    has_output: Boolean(outputText.trim()),
    is_tui: false,
    cwd: typeof cwd === 'string' ? cwd : '',
    model: typeof model === 'string' ? model : '',
  };
}

function parseCodexSessionEntries(entries, fileInfo = {}, options = {}) {
  const blocks = [];
  let sessionId = extractCodexSessionIdFromFilename(fileInfo.path) || '';
  let forkedFromId = '';
  let cwd = typeof options.initialCwd === 'string' ? options.initialCwd.trim() : '';
  let model = '';
  let current = null;
  let lastMessageKey = '';
  let lastMessageAt = 0;

  const flush = () => {
    if (!current) return;
    const block = buildCodexBlockFromTurn(current);
    if (block) {
      attachWslMetadata(block, { sourcePath: fileInfo?.path });
      blocks.push(block);
    }
    current = null;
  };

  for (const entry of entries || []) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'session_meta') {
      const payload = entry.payload || {};
      if (!sessionId && payload.id) sessionId = String(payload.id || '').trim();
      if (payload.id && isUuidLike(payload.id)) {
        sessionId = String(payload.id || '').trim();
      }
      const forked = extractCodexForkedFromId(entry);
      if (forked) {
        forkedFromId = forked;
        if (current) current.forkedFromId = forkedFromId;
      }
      const metaCwd = extractCodexCwd(payload);
      if (metaCwd && !cwd) {
        cwd = metaCwd;
        if (current) current.cwd = cwd;
      }
      const metaModel = extractCodexModel(payload);
      if (metaModel) {
        model = metaModel;
        if (current) current.model = model;
      }
    }
    if (entry.type === 'turn_context') {
      const payload = entry.payload || {};
      const metaCwd = extractCodexCwd(payload);
      if (metaCwd && !cwd) {
        cwd = metaCwd;
        if (current) current.cwd = cwd;
      }
      const metaModel = extractCodexModel(payload);
      if (metaModel) {
        model = metaModel;
        if (current) current.model = model;
      }
    }

    const msg = extractCodexMessageEvent(entry);
    if (!msg) continue;
    const key = `${msg.role}:${msg.text}`;
    if (key === lastMessageKey && msg.timestamp && lastMessageAt && Math.abs(msg.timestamp - lastMessageAt) < 2000) {
      continue;
    }
    lastMessageKey = key;
    lastMessageAt = msg.timestamp || lastMessageAt;

    if (msg.role === 'user') {
      flush();
      current = {
        sessionId,
        cwd,
        userText: msg.text,
        assistantTexts: [],
        createdAt: msg.timestamp || 0,
        lastOutputAt: msg.timestamp || 0,
        forkedFromId,
        model,
        allowEmptyOutput: true,
      };
      continue;
    }

    if (msg.role === 'assistant') {
      if (!current) {
        current = {
          sessionId,
          cwd,
          userText: '',
          assistantTexts: [],
          createdAt: msg.timestamp || 0,
          lastOutputAt: msg.timestamp || 0,
          forkedFromId,
          model,
          allowEmptyOutput: true,
        };
      }
      current.assistantTexts.push(msg.text);
      if (msg.timestamp) current.lastOutputAt = msg.timestamp;
    }
  }

  flush();
  return blocks;
}

async function scanCodexSessionFile(filePath, onBlock) {
  let sessionId = extractCodexSessionIdFromFilename(filePath) || '';
  let forkedFromId = '';
  let cwd = '';
  let model = '';
  let current = null;
  let lastMessageKey = '';
  let lastMessageAt = 0;

  const flush = () => {
    if (!current) return;
    const block = buildCodexBlockFromTurn(current);
    if (block) {
      attachWslMetadata(block, { sourcePath: filePath });
      onBlock(block);
    }
    current = null;
  };

  await readJsonlFile(filePath, (entry) => {
    if (!entry || typeof entry !== 'object') return;
    if (entry.type === 'session_meta') {
      const payload = entry.payload || {};
      if (!sessionId && payload.id) sessionId = String(payload.id || '').trim();
      if (payload.id && isUuidLike(payload.id)) {
        sessionId = String(payload.id || '').trim();
      }
      const forked = extractCodexForkedFromId(entry);
      if (forked) {
        forkedFromId = forked;
        if (current) current.forkedFromId = forkedFromId;
      }
      const metaCwd = extractCodexCwd(payload);
      if (metaCwd && !cwd) {
        cwd = metaCwd;
        if (current) current.cwd = cwd;
      }
      const metaModel = extractCodexModel(payload);
      if (metaModel) {
        model = metaModel;
        if (current) current.model = model;
      }
    }
    if (entry.type === 'turn_context') {
      const payload = entry.payload || {};
      const metaCwd = extractCodexCwd(payload);
      if (metaCwd && !cwd) {
        cwd = metaCwd;
        if (current) current.cwd = cwd;
      }
      const metaModel = extractCodexModel(payload);
      if (metaModel) {
        model = metaModel;
        if (current) current.model = model;
      }
    }

    const msg = extractCodexMessageEvent(entry);
    if (!msg) return;
    const key = `${msg.role}:${msg.text}`;
    if (key === lastMessageKey && msg.timestamp && lastMessageAt && Math.abs(msg.timestamp - lastMessageAt) < 2000) {
      return;
    }
    lastMessageKey = key;
    lastMessageAt = msg.timestamp || lastMessageAt;

    if (msg.role === 'user') {
      flush();
      current = {
        sessionId,
        cwd,
        userText: msg.text,
        assistantTexts: [],
        createdAt: msg.timestamp || 0,
        lastOutputAt: msg.timestamp || 0,
        forkedFromId,
        model,
        allowEmptyOutput: true,
      };
      return;
    }
    if (msg.role === 'assistant') {
      if (!current) {
        current = {
          sessionId,
          cwd,
          userText: '',
          assistantTexts: [],
          createdAt: msg.timestamp || 0,
          lastOutputAt: msg.timestamp || 0,
          forkedFromId,
          model,
          allowEmptyOutput: true,
        };
      }
      current.assistantTexts.push(msg.text);
      if (msg.timestamp) current.lastOutputAt = msg.timestamp;
    }
  });

  flush();
}

function resolveCodexSessionIdFromEntries(entries) {
  if (!Array.isArray(entries)) return '';
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'session_meta') {
      const payload = entry.payload || {};
      const candidate = String(payload.id || '').trim();
      if (candidate) return candidate;
    }
    const candidate = extractCodexSessionId(entry);
    if (candidate) return candidate;
  }
  return '';
}

function buildCodexDedupKey(block, { bucketMs = 60 * 1000 } = {}) {
  if (!block) return '';
  const createdAt = Number(block.created_at || block.last_output_at || 0);
  const bucket = createdAt ? Math.floor(createdAt / bucketMs) : 0;
  const paneKey = normalizeDedupPaneId(block.pane_id || block.pane_label || '');
  const input = normalizeDedupText(block.input || (Array.isArray(block.inputs) ? block.inputs[0] : ''));
  const output = normalizeDedupText(block.output_text || '');
  const forked = String(block.forked_from_id || '').trim();
  const sessionKey = forked ? String(block.session_id || '').trim() : '';
  return `${paneKey}|${bucket}|${input}|${output}|${sessionKey}`;
}

function normalizeDedupText(value, maxLen = 200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

module.exports = {
  buildCodexBlockFromTurn,
  buildCodexDedupKey,
  extractCodexBlockFromEntry,
  extractCodexContentText,
  extractCodexForkedFromId,
  extractCodexMessageEvent,
  extractCodexModel,
  extractCodexSessionId,
  extractCodexSessionIdFromFilename,
  extractCodexTexts,
  isCodexSessionPrefixText,
  isCodexUserInstructionMessage,
  isCodexUserShellCommandText,
  parseCodexSessionEntries,
  resolveCodexSessionIdFromEntries,
  scanCodexSessionFile,
  shouldSkipCodexUserMessage,
};
