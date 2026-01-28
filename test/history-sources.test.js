const test = require('node:test');
const assert = require('node:assert/strict');

const { createDefaultSources, ClaudeJsonlSource, CodexJsonlSource, JsonlSource } = require('../src/main/history/domain/sources');

test('createDefaultSources builds map with expected ids', () => {
  const sources = createDefaultSources();
  const ids = Array.from(sources.keys()).sort();
  assert.deepEqual(ids, ['claude', 'codex']);
});

test('default sources are JsonlSource implementations with capabilities', () => {
  const sources = createDefaultSources();
  const claude = sources.get('claude');
  const codex = sources.get('codex');

  assert.ok(claude instanceof JsonlSource);
  assert.ok(codex instanceof JsonlSource);
  assert.ok(claude instanceof ClaudeJsonlSource);
  assert.ok(codex instanceof CodexJsonlSource);
  assert.equal(claude.capabilities.timeMachine, true);
  assert.equal(codex.capabilities.timeMachine, true);
});
