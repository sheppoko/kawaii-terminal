const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseCodexSessionEntries,
  extractCodexBlockFromEntry,
  extractCodexMessageEvent,
} = require('../src/main/history/domain/builders/codex-blocks');

const buildMessage = (role, text, ts) => ({
  type: 'response_item',
  timestamp: ts,
  payload: {
    type: 'message',
    role,
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
  },
});

test('parseCodexSessionEntries builds blocks from user/assistant turns', () => {
  const sessionId = 'deadbeef-dead-beef-dead-beefdeadbeef';
  const entries = [
    { type: 'session_meta', payload: { id: sessionId } },
    buildMessage('user', 'hello', 1700000000000),
    buildMessage('assistant', 'world', 1700000001000),
  ];

  const blocks = parseCodexSessionEntries(entries, { path: '/tmp/session-1.jsonl' }, {});
  assert.equal(blocks.length, 1);
  const block = blocks[0];
  assert.equal(block.session_id, sessionId);
  assert.equal(block.input, 'hello');
  assert.equal(block.output_text, 'world');
  assert.equal(block.source, 'codex');
});

test('extractCodexBlockFromEntry pulls text from generic entry', () => {
  const entry = {
    id: 'turn-1',
    session_id: 's1',
    role: 'user',
    content: 'ping',
    output_text: 'pong',
    created_at: 1710000000000,
  };
  const block = extractCodexBlockFromEntry(entry);
  assert.ok(block);
  assert.equal(block.session_id, 's1');
  assert.equal(block.input, 'ping');
  assert.equal(block.output_text, 'pong');
});

test('extractCodexMessageEvent ignores system and empty payloads', () => {
  const systemEntry = buildMessage('system', 'ignore', 1700);
  assert.equal(extractCodexMessageEvent(systemEntry), null);
  const badEntry = { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } };
  assert.equal(extractCodexMessageEvent(badEntry), null);
});
