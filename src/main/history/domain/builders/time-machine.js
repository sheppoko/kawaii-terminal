const fs = require('fs');
const readline = require('readline');

const { readJsonlHead } = require('../../infra/jsonl-reader');
const {
  filterClaudeToolBlocks,
  forEachClaudeToolBlock,
  getClaudeMessageContentSlot,
  getClaudeToolResultId,
  getClaudeToolUseId,
  isClaudeUserPromptEntry,
  resolveClaudeRole,
} = require('../../utils/claude-utils');
const {
  buildSyntheticCodexSessionMeta,
  isTargetCodexUserMessage,
  isUuidLike,
  normalizeCodexText,
} = require('../../utils/codex-utils');
const { extractCodexMessageEvent, resolveCodexSessionIdFromEntries } = require('./codex-blocks');
const { hashString } = require('../../utils/block-utils');
const { CODEX_HEAD_BYTES } = require('../history-constants');

function rewriteSessionIdEntry(entry, newSessionId, { updateMeta = false, forkedFromId = '' } = {}) {
  if (!entry || typeof entry !== 'object') return;
  const updateContainer = (container) => {
    if (!container || typeof container !== 'object') return;
    const keys = [
      'session_id',
      'sessionId',
      'thread_id',
      'threadId',
      'conversation_id',
      'conversationId',
      'session',
      'thread',
      'conversation',
    ];
    for (const key of keys) {
      if (typeof container[key] === 'string') {
        container[key] = newSessionId;
      }
    }
  };

  updateContainer(entry);
  updateContainer(entry.meta);
  updateContainer(entry.metadata);
  updateContainer(entry.context);

  if (entry.payload && typeof entry.payload === 'object') {
    updateContainer(entry.payload);
    updateContainer(entry.payload.meta);
    updateContainer(entry.payload.metadata);
    updateContainer(entry.payload.context);
  }

  if (updateMeta && entry.type === 'session_meta' && entry.payload && typeof entry.payload === 'object') {
    if (typeof entry.payload.id === 'string') entry.payload.id = newSessionId;
    const forked = String(forkedFromId || '').trim();
    if (forked && isUuidLike(forked)) {
      entry.payload.forked_from_id = forked;
    } else if (Object.prototype.hasOwnProperty.call(entry.payload, 'forked_from_id')) {
      delete entry.payload.forked_from_id;
    }
  }
}

async function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch (_) {
    // ignore
  }
}

function parseCodexSessionIdFromSourceId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/^([^:]+):(\d+):(\d+)$/);
  if (!match) return '';
  return match[1] || '';
}

async function buildClaudeTimeMachineFile({ sourcePath, outputPath, targetUuid, newSessionId }) {
  const out = fs.createWriteStream(outputPath, { encoding: 'utf8', flags: 'wx' });
  let input = null;
  let rl = null;

  let foundTarget = false;
  let wroteAny = false;
  let stopped = false;
  let totalLines = 0;
  let parsedEntries = 0;
  let userEntries = 0;
  let matchedUuidEntry = false;
  let matchedUuidUser = false;
  let firstUserUuid = '';
  let lastUserUuid = '';
  let stopReason = '';
  let inputError = null;
  const target = String(targetUuid || '').trim();
  const entries = [];

  try {
    await new Promise((resolve, reject) => {
      out.once('open', resolve);
      out.once('error', reject);
    });
    input = fs.createReadStream(sourcePath, { encoding: 'utf8' });
    rl = readline.createInterface({ input, crlfDelay: Infinity });
    input.on('error', (err) => { inputError = err || inputError; });
    rl.on('error', (err) => { inputError = err || inputError; });
    try {
      for await (const line of rl) {
        if (stopped) break;
        totalLines += 1;
        if (!line || !line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch (_) {
          continue;
        }
        parsedEntries += 1;

        const isUser = isClaudeUserPromptEntry(entry);
        if (isUser) {
          userEntries += 1;
          const entryUuid = String(entry.uuid || '').trim();
          if (!firstUserUuid) firstUserUuid = entryUuid;
          lastUserUuid = entryUuid;
        }
        if (foundTarget && isUser) {
          stopped = true;
          stopReason = 'next-user';
          break;
        }
        const entryUuid = String(entry.uuid || '').trim();
        if (target && entryUuid === target) {
          matchedUuidEntry = true;
        }
        if (isUser && target && entryUuid === target) {
          foundTarget = true;
          matchedUuidUser = true;
        }

        entries.push(entry);
      }
    } catch (err) {
      inputError = err || inputError;
    }
    if (inputError) {
      await safeUnlink(outputPath);
      return {
        success: false,
        error: inputError?.message || 'Failed to read Claude session',
        detail: {
          targetUuid: target,
          totalLines,
          parsedEntries,
          userEntries,
          matchedUuidEntry,
          matchedUuidUser,
          entriesCount: entries.length,
          firstUserUuid,
          lastUserUuid,
          stopped,
          stopReason,
          inputError: String(inputError?.message || 'unknown'),
        },
      };
    }

    if (foundTarget && entries.length > 0) {
      const validToolResultIds = new Set();
      const seenToolUses = new Set();
      for (const entry of entries) {
        const role = resolveClaudeRole(entry);
        if (role !== 'user' && role !== 'assistant') continue;
        const slot = getClaudeMessageContentSlot(entry);
        if (!slot) continue;
        forEachClaudeToolBlock(slot.content, (block, type) => {
          if (type === 'tool_use') {
            const id = getClaudeToolUseId(block);
            if (id) seenToolUses.add(id);
            return;
          }
          if (type === 'tool_result') {
            const id = getClaudeToolResultId(block);
            if (id && seenToolUses.has(id)) validToolResultIds.add(id);
          }
        });
      }

      const allowedToolIds = validToolResultIds;
      const seenAllowedToolUses = new Set();
      for (const entry of entries) {
        const role = resolveClaudeRole(entry);
        if (role === 'user' || role === 'assistant') {
          const slot = getClaudeMessageContentSlot(entry);
          if (slot) {
            const { content, removedAny } = filterClaudeToolBlocks(slot.content, {
              allowedToolUseIds: allowedToolIds,
              allowedToolResultIds: allowedToolIds,
              seenToolUses: seenAllowedToolUses,
            });
            if (removedAny) {
              if (content == null || (Array.isArray(content) && content.length === 0)) {
                continue;
              }
              slot.owner[slot.key] = content;
            }
          }
        }
        rewriteSessionIdEntry(entry, newSessionId);
        out.write(`${JSON.stringify(entry)}\n`);
        wroteAny = true;
      }
    }
  } catch (err) {
    await safeUnlink(outputPath);
    throw err;
  } finally {
    if (rl) {
      try {
        rl.close();
      } catch (_) {
        // ignore
      }
    }
    if (input) {
      try {
        input.destroy();
      } catch (_) {
        // ignore
      }
    }
    await new Promise((resolve) => {
      out.end(resolve);
    });
  }

  if (!foundTarget || !wroteAny) {
    await safeUnlink(outputPath);
    return {
      success: false,
      error: 'Target not found in Claude session',
      detail: {
        targetUuid: target,
        foundTarget,
        wroteAny,
        totalLines,
        parsedEntries,
        userEntries,
        matchedUuidEntry,
        matchedUuidUser,
        entriesCount: entries.length,
        firstUserUuid,
        lastUserUuid,
        stopped,
        stopReason,
      },
    };
  }
  return { success: true };
}

async function buildCodexTimeMachineFile({
  sourcePath,
  outputPath,
  targetInput,
  targetTimestamp,
  targetSourceId,
  sourceSessionId,
  newSessionId,
  forkedFromId,
  headBytes = CODEX_HEAD_BYTES,
}) {
  const headEntries = await readJsonlHead(sourcePath, headBytes);
  const headSessionId = resolveCodexSessionIdFromEntries(headEntries);
  const syntheticMeta = buildSyntheticCodexSessionMeta({
    entries: headEntries,
    newSessionId,
    forkedFromId: headSessionId || forkedFromId,
  });
  const out = fs.createWriteStream(outputPath, { encoding: 'utf8', flags: 'wx' });
  let input = null;
  let rl = null;

  let foundTarget = false;
  let matchedKey = '';
  let wroteAny = false;
  let currentSessionId = String(headSessionId || sourceSessionId || '').trim();
  const targetSource = String(targetSourceId || '').trim();
  const requireSourceMatch = Boolean(targetSource);

  try {
    await new Promise((resolve, reject) => {
      out.once('open', resolve);
      out.once('error', reject);
    });
    input = fs.createReadStream(sourcePath, { encoding: 'utf8' });
    rl = readline.createInterface({ input, crlfDelay: Infinity });
    if (syntheticMeta) {
      out.write(`${JSON.stringify(syntheticMeta)}\n`);
      wroteAny = true;
    }
    for await (const line of rl) {
      if (!line || !line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (_) {
        continue;
      }

      if (entry.type === 'session_meta') {
        const payload = entry.payload || {};
        const candidate = String(payload.id || '').trim();
        if (candidate) currentSessionId = candidate;
      }

      const msg = extractCodexMessageEvent(entry);
      if (msg && msg.role === 'user') {
        const rawText = normalizeCodexText(msg.text);
        const ts = Number(msg.timestamp || 0);
        const rawId = currentSessionId ? `${currentSessionId}:${ts || 0}:${hashString(rawText)}` : '';
        const key = rawId || `${rawText}|${ts || 0}`;
        const sourceMatches = targetSource && rawId && targetSource === rawId;
        if (!foundTarget) {
          if ((requireSourceMatch && sourceMatches)
            || (!requireSourceMatch && (sourceMatches || isTargetCodexUserMessage(msg, targetInput, targetTimestamp)))) {
            foundTarget = true;
            matchedKey = key;
          }
        } else if (key !== matchedKey) {
          break;
        }
      }

      out.write(`${JSON.stringify(entry)}\n`);
      wroteAny = true;
    }
  } catch (err) {
    await safeUnlink(outputPath);
    throw err;
  } finally {
    if (rl) {
      try {
        rl.close();
      } catch (_) {
        // ignore
      }
    }
    if (input) {
      try {
        input.destroy();
      } catch (_) {
        // ignore
      }
    }
    await new Promise((resolve) => {
      out.end(resolve);
    });
  }

  if (!foundTarget || !wroteAny) {
    await safeUnlink(outputPath);
    return { success: false, error: 'Target not found in Codex session' };
  }
  return { success: true };
}

module.exports = {
  buildClaudeTimeMachineFile,
  buildCodexTimeMachineFile,
  parseCodexSessionIdFromSourceId,
  rewriteSessionIdEntry,
};
