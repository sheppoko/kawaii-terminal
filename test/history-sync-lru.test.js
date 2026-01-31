const test = require('node:test');
const assert = require('node:assert/strict');

const { HistorySyncService } = require('../src/main/history/app/history-sync-service');

function buildSummary(id, createdAt) {
  return {
    source: 'codex',
    session_id: id,
    created_at: createdAt,
    last_output_at: createdAt,
    input: 'hi',
  };
}

test('history sync LRU evicts oldest sessions beyond limit', () => {
  const service = new HistorySyncService({ sessionStateLimit: 2 });

  service.applySummary('codex', buildSummary('a', 1), { filePath: 'a', fileMtime: 1 });
  service.applySummary('codex', buildSummary('b', 2), { filePath: 'b', fileMtime: 2 });
  service.applySummary('codex', buildSummary('c', 3), { filePath: 'c', fileMtime: 3 });

  const state = service.getState('codex');
  assert.equal(state.sessions.size, 2);
  assert.ok(!state.sessions.has('codex:a'));
  assert.ok(state.sessions.has('codex:b'));
  assert.ok(state.sessions.has('codex:c'));
});

test('history sync LRU keeps newest sessions regardless of insert order', () => {
  const service = new HistorySyncService({ sessionStateLimit: 2 });

  service.applySummary('codex', buildSummary('c', 3), { filePath: 'c', fileMtime: 3 });
  service.applySummary('codex', buildSummary('b', 2), { filePath: 'b', fileMtime: 2 });
  service.applySummary('codex', buildSummary('a', 1), { filePath: 'a', fileMtime: 1 });

  const state = service.getState('codex');
  assert.equal(state.sessions.size, 2);
  assert.ok(!state.sessions.has('codex:a'));
  assert.ok(state.sessions.has('codex:b'));
  assert.ok(state.sessions.has('codex:c'));
});
