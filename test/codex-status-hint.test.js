const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CodexJsonlSource } = require('../src/main/history/domain/sources/codex-jsonl-source');

function buildMessage({ role, text, timestamp, phase } = {}) {
  const payload = {
    type: 'message',
    role,
    content: [{
      type: role === 'assistant' ? 'output_text' : 'input_text',
      text,
    }],
  };
  if (phase) payload.phase = phase;
  return {
    type: 'response_item',
    timestamp,
    payload,
  };
}

async function readStatusHint(entries) {
  const sessionId = '11111111-1111-1111-1111-111111111111';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawaii-codex-status-'));
  const filePath = path.join(dir, `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`);
  try {
    const lines = [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-01-01T00:00:00.000Z',
        payload: { id: sessionId },
      }),
      ...entries.map(entry => JSON.stringify(entry)),
    ];
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
    const source = new CodexJsonlSource();
    const summary = await source.buildSummaryFromFile(filePath, { trustedPath: true });
    assert.ok(summary, 'summary should be produced');
    return summary.status_hint || '';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('codex status hint keeps commentary-only assistant turns as working', async () => {
  const hint = await readStatusHint([
    buildMessage({
      role: 'user',
      text: '調査して',
      timestamp: '2026-01-01T00:00:01.000Z',
    }),
    buildMessage({
      role: 'assistant',
      text: '今から見ます',
      phase: 'commentary',
      timestamp: '2026-01-01T00:00:02.000Z',
    }),
  ]);
  assert.equal(hint, 'working');
});

test('codex status hint marks final_answer as completed', async () => {
  const hint = await readStatusHint([
    buildMessage({
      role: 'user',
      text: '実装して',
      timestamp: '2026-01-01T00:00:01.000Z',
    }),
    buildMessage({
      role: 'assistant',
      text: 'まず確認します',
      phase: 'commentary',
      timestamp: '2026-01-01T00:00:02.000Z',
    }),
    buildMessage({
      role: 'assistant',
      text: '完了しました',
      phase: 'final_answer',
      timestamp: '2026-01-01T00:00:03.000Z',
    }),
  ]);
  assert.equal(hint, 'completed');
});

test('codex status hint keeps legacy no-phase assistant behavior', async () => {
  const hint = await readStatusHint([
    buildMessage({
      role: 'user',
      text: '古いログ',
      timestamp: '2026-01-01T00:00:01.000Z',
    }),
    buildMessage({
      role: 'assistant',
      text: '完了',
      timestamp: '2026-01-01T00:00:02.000Z',
    }),
  ]);
  assert.equal(hint, 'completed');
});

test('codex status hint returns waiting_user for pending request_user_input', async () => {
  const hint = await readStatusHint([
    buildMessage({
      role: 'user',
      text: '選択肢を出して',
      timestamp: '2026-01-01T00:00:01.000Z',
    }),
    {
      type: 'response_item',
      timestamp: '2026-01-01T00:00:02.000Z',
      payload: {
        type: 'function_call',
        name: 'request_user_input',
        id: 'call-1',
      },
    },
  ]);
  assert.equal(hint, 'waiting_user');
});
