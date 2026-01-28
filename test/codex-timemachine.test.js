const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HistoryService = require('../src/main/history/app/history-service');

const writeJsonl = (filePath, lines) => {
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
};

const buildMessage = (role, text, ts) => ({
  type: 'response_item',
  timestamp: ts,
  payload: {
    type: 'message',
    role,
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
  },
});

const prevCodexHome = process.env.CODEX_HOME;
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kawaii-codex-'));
const sessionsDir = path.join(tempHome, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
process.env.CODEX_HOME = tempHome;

after(() => {
  if (prevCodexHome == null) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = prevCodexHome;
  }
  fs.rmSync(tempHome, { recursive: true, force: true });
});

test('codex timemachine', async (t) => {
  await t.test('source_id match stops at next user', async () => {
    const sessionId = 'c6547424-675d-4487-a7f4-d84e7b4f8d70';
    const ts1 = 1710000000000;
    const userText = 'hello world';
    const rawId = `${sessionId}:${ts1}:${Math.abs(hashString(userText))}`;
    const sourceId = `codex:${rawId}`;

    const filePath = path.join(sessionsDir, `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: 'session_meta', payload: { id: sessionId } }),
      JSON.stringify(buildMessage('user', userText, ts1)),
      JSON.stringify(buildMessage('assistant', 'reply-1', ts1 + 1000)),
      JSON.stringify(buildMessage('assistant', 'reply-2', ts1 + 2000)),
      JSON.stringify(buildMessage('user', 'next user', ts1 + 3000)),
      JSON.stringify(buildMessage('assistant', 'reply-3', ts1 + 4000)),
    ];
    writeJsonl(filePath, lines);

    const service = new HistoryService({ userDataDir: tempHome });
    const result = await service.repository.createTimeMachine({
      block: {
        source: 'codex',
        source_id: sourceId,
        session_id: sessionId,
        source_path: filePath,
        input: userText,
        created_at: ts1,
      },
    });

    assert.ok(result.success, result.error || 'expected success');
    assert.equal(result.source, 'codex');
    assert.ok(result.session_id);
    assert.ok(fs.existsSync(result.file_path));

    const outLines = fs.readFileSync(result.file_path, 'utf8').trim().split('\n');
    assert.ok(outLines.length >= 4);
    const outEntries = outLines.map((line) => JSON.parse(line));
    assert.equal(outEntries[0].type, 'session_meta');
    assert.equal(outEntries[0].payload.id, result.session_id);

    const outMessages = outEntries.filter((entry) => entry.type === 'response_item');
    assert.equal(outMessages.length, 3);
    assert.equal(outMessages[0].payload.role, 'user');
    assert.equal(outMessages[0].payload.content[0].text, userText);
    assert.equal(outMessages[2].payload.role, 'assistant');
    assert.equal(outMessages[2].payload.content[0].text, 'reply-2');
  });

  await t.test('source_id mismatch fails even if input matches', async () => {
    const sessionId = 'c6547424-675d-4487-a7f4-d84e7b4f8d70';
    const ts1 = 1710002000000;
    const userText = 'hello';

    const filePath = path.join(sessionsDir, `rollout-2026-01-01T00-00-02-${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: 'session_meta', payload: { id: sessionId } }),
      JSON.stringify(buildMessage('user', userText, ts1)),
      JSON.stringify(buildMessage('assistant', 'reply', ts1 + 1000)),
    ];
    writeJsonl(filePath, lines);

    const service = new HistoryService({ userDataDir: tempHome });
    const result = await service.repository.createTimeMachine({
      block: {
        source: 'codex',
        session_id: sessionId,
        source_path: filePath,
        source_id: 'codex:wrong',
        input: userText,
        created_at: ts1,
      },
    });

    assert.equal(result.success, false);
    assert.equal(result.error, 'Target not found in Codex session');

    const jsonls = fs.readdirSync(sessionsDir).filter((name) => name.endsWith('.jsonl'));
    assert.ok(jsonls.includes(path.basename(filePath)));
  });
});

function hashString(value) {
  const text = String(value || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return hash;
}
