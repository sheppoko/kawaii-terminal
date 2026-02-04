const test = require('node:test');
const assert = require('node:assert/strict');

const { StatusService } = require('../src/main/status/status-service');

function obs(id, ts) {
  return {
    source: 'codex',
    session_id: id,
    status: 'working',
    timestamp: ts,
  };
}

test('status service prunes by maxEntries', () => {
  const service = new StatusService({ maxEntries: 2 });

  service.applyObservation(obs('a', 1));
  service.applyObservation(obs('b', 2));
  service.applyObservation(obs('c', 3));

  assert.equal(service.statusBySession.size, 2);
  assert.ok(!service.statusBySession.has('codex:a'));
  assert.ok(service.statusBySession.has('codex:b'));
  assert.ok(service.statusBySession.has('codex:c'));
});
