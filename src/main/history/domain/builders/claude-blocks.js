const {
  extractClaudeMessageText,
  resolveClaudeRole,
} = require('../../utils/claude-utils');

function parseClaudeTimestampMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function createClaudeBlockBuilder({
  buildFallbackId,
  buildSourceBlockId,
  attachWslMetadata,
  extractModelFromEntry,
} = {}) {
  if (typeof buildFallbackId !== 'function') {
    throw new Error('buildFallbackId is required');
  }
  if (typeof buildSourceBlockId !== 'function') {
    throw new Error('buildSourceBlockId is required');
  }

  const buildClaudeBlockFromTurn = ({
    userUuid,
    sessionId,
    userText,
    outputText,
    createdAt,
    lastOutputAt,
    projectKey,
    paneLabel,
    cwd,
    sourcePath,
    model,
    allowEmptyOutput = false,
  }) => {
    const safeUserText = String(userText || '').trim();
    const output = String(outputText || '').trimEnd();
    if (!safeUserText && !output) return null;
    if (!allowEmptyOutput && !output.trim()) return null;

    const rawUuid = String(userUuid || '').trim();
    const fallbackId = buildFallbackId('claude', safeUserText, output, createdAt || Date.now());
    const rawId = rawUuid || fallbackId;
    const id = buildSourceBlockId('claude', rawId);
    if (!id) return null;

    const safeCreatedAt = createdAt || 0;
    const safeLastOutputAt = lastOutputAt || safeCreatedAt || 0;
    const block = {
      id,
      source: 'claude',
      source_id: rawUuid || rawId,
      session_id: sessionId || 'claude',
      session_label: sessionId ? sessionId.slice(-6) : 'claude',
      pane_id: projectKey,
      pane_label: paneLabel || 'Claude',
      inputs: safeUserText ? [safeUserText] : [],
      input: userText || '',
      output_raw: '',
      output_text: output,
      output_head: output.slice(0, 400),
      output_tail: output.length > 400 ? output.slice(-400) : output,
      created_at: safeCreatedAt,
      last_output_at: safeLastOutputAt,
      has_output: Boolean(output.trim()),
      is_tui: false,
      cwd: typeof cwd === 'string' ? cwd : '',
      model: typeof model === 'string' ? model : '',
    };
    if (typeof attachWslMetadata === 'function') {
      attachWslMetadata(block, { sourcePath, projectDir: projectKey });
    }
    return block;
  };

  const extractClaudeBlocksFromEntries = (entries, { projectKey, paneLabel, cwd, sourcePath } = {}) => {
    const blocks = [];
    if (!Array.isArray(entries)) return blocks;

    let currentUserUuid = '';
    let currentSessionId = '';
    let currentUserText = '';
    let currentCreatedAt = 0;
    let currentLastOutputAt = 0;
    let assistantTexts = [];
    let currentCwd = typeof cwd === 'string' ? cwd : '';
    let currentModel = '';

    const flush = () => {
      if (!currentUserUuid && !currentUserText) return;
      const block = buildClaudeBlockFromTurn({
        userUuid: currentUserUuid,
        sessionId: currentSessionId,
        userText: currentUserText,
        outputText: assistantTexts.filter(Boolean).join('\n').trimEnd(),
        createdAt: currentCreatedAt,
        lastOutputAt: currentLastOutputAt || currentCreatedAt,
        projectKey,
        paneLabel,
        cwd: currentCwd,
        sourcePath,
        model: currentModel,
        allowEmptyOutput: true,
      });
      if (block) blocks.push(block);
    };

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.isSidechain === true) continue;
      const role = resolveClaudeRole(entry);
      if (!role) continue;

      if (role === 'user') {
        const userText = extractClaudeMessageText(entry);
        if (!userText) continue;
        flush();
        currentUserUuid = String(entry.uuid || '').trim();
        currentSessionId = String(entry.sessionId || '').trim();
        currentUserText = userText;
        currentCreatedAt = parseClaudeTimestampMs(entry.timestamp);
        currentLastOutputAt = currentCreatedAt;
        assistantTexts = [];
        currentModel = '';
        continue;
      }

      if (role === 'assistant' && (currentUserUuid || currentUserText)) {
        if (typeof extractModelFromEntry === 'function') {
          const model = extractModelFromEntry(entry);
          if (model) currentModel = model;
        }
        const text = extractClaudeMessageText(entry);
        if (text) assistantTexts.push(text);
        const ts = parseClaudeTimestampMs(entry.timestamp);
        if (ts) currentLastOutputAt = ts;
      }
    }

    flush();
    return blocks;
  };

  return {
    buildClaudeBlockFromTurn,
    extractClaudeBlocksFromEntries,
  };
}

module.exports = {
  createClaudeBlockBuilder,
  parseClaudeTimestampMs,
};
