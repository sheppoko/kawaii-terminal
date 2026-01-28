const test = require('node:test');
const assert = require('node:assert/strict');

const HistoryRepository = require('../src/main/history/domain/repository');

const makeConnector = () => ({
  id: 'codex',
  capabilities: { meta: false },
  listSessions: async () => ({
    sessions: [
      { source: 'codex', session_id: 's1', input: '', created_at: 1 },
      { source: 'codex', session_id: 's2', input: 'hello', created_at: 2 },
    ],
    maybe_more: false,
    next_cursor: null,
  }),
  loadSession: async () => ({
    blocks: [
      { source: 'codex', id: 'b1', input: '', created_at: 1 },
      { source: 'codex', id: 'b2', input: 'hi', created_at: 2 },
    ],
    maybe_more: false,
  }),
});

test('HistoryRepository filters sessions without input', async () => {
  const connectors = new Map();
  connectors.set('codex', makeConnector());
  const repo = new HistoryRepository({ connectors });

  const result = await repo.listSessions({ source: 'codex', limit: 10 });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].session_id, 's2');
});

test('HistoryRepository filters blocks without input', async () => {
  const connectors = new Map();
  connectors.set('codex', makeConnector());
  const repo = new HistoryRepository({ connectors });

  const result = await repo.loadSession({ source: 'codex', session_id: 's2' });
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].id, 'b2');
});
