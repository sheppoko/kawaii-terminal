const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HistoryService = require('../src/main/history/app/history-service');

const writeJsonl = (filePath, entries) => {
  const lines = entries.map((entry) => JSON.stringify(entry));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
};

test('createClaudeTimeMachine builds new jsonl and filters tool results', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawaii-claude-'));
  try {
    const sessionId = 'session-123';
    const targetUuid = 'u-target';
    const sourcePath = path.join(tempDir, `${sessionId}.jsonl`);

    writeJsonl(sourcePath, [
      { role: 'user', uuid: 'u1', sessionId, content: 'before' },
      { role: 'assistant', sessionId, content: 'before reply' },
      { role: 'user', uuid: targetUuid, sessionId, content: 'target' },
      {
        role: 'assistant',
        sessionId,
        content: [
          { type: 'tool_use', id: 't1', name: 'tool' },
          { type: 'text', text: 'doing' },
        ],
      },
      {
        role: 'assistant',
        sessionId,
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
          { type: 'tool_result', tool_use_id: 't2', content: 'bad' },
        ],
      },
      { role: 'user', uuid: 'u2', sessionId, content: 'after' },
      { role: 'assistant', sessionId, content: 'after reply' },
    ]);

    const service = new HistoryService({ userDataDir: tempDir });
    const result = await service.repository.createTimeMachine({
      block: {
        source: 'claude',
        session_id: sessionId,
        source_id: targetUuid,
        pane_id: tempDir,
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.source, 'claude');
    assert.ok(result.session_id);
    assert.ok(fs.existsSync(result.file_path));

    const lines = fs.readFileSync(result.file_path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 5);
    const outEntries = lines.map((line) => JSON.parse(line));
    for (const entry of outEntries) {
      assert.equal(entry.sessionId, result.session_id);
    }

    const toolResultEntry = outEntries[4];
    const toolResults = Array.isArray(toolResultEntry.content)
      ? toolResultEntry.content.filter((item) => item?.type === 'tool_result')
      : [];
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].tool_use_id, 't1');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('createClaudeTimeMachine fails when target uuid is missing', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawaii-claude-'));
  try {
    const sessionId = 'session-456';
    const sourcePath = path.join(tempDir, `${sessionId}.jsonl`);
    writeJsonl(sourcePath, [
      { role: 'user', uuid: 'u1', sessionId, content: 'hello' },
      { role: 'assistant', sessionId, content: 'world' },
    ]);

    const service = new HistoryService({ userDataDir: tempDir });
    const result = await service.repository.createTimeMachine({
      block: {
        source: 'claude',
        session_id: sessionId,
        source_id: 'missing-uuid',
        pane_id: tempDir,
      },
    });

    assert.equal(result.success, false);
    assert.equal(result.error, 'Target not found in Claude session');

    const jsonls = fs.readdirSync(tempDir).filter((name) => name.endsWith('.jsonl'));
    assert.deepEqual(jsonls.sort(), [`${sessionId}.jsonl`]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
