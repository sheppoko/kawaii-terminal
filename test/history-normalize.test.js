const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeSessionSummary } = require('../src/shared/history/normalize');

test('normalizeSessionSummary converts timestamps and sets source', () => {
  const session = {
    created_at: '2025-01-01T00:00:00Z',
    last_output_at: '2025-01-01T00:00:02Z',
  };

  normalizeSessionSummary(session, 'codex');

  assert.equal(session.source, 'codex');
  assert.equal(typeof session.created_at, 'number');
  assert.equal(typeof session.last_output_at, 'number');
  assert.ok(session.last_output_at >= session.created_at);
});
