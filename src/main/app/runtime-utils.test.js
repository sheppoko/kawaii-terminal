const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clampInt,
  getResetOptionsFromArgs,
  normalizeTabId,
  stripResetArgs,
} = require('./runtime-utils');

test('getResetOptionsFromArgs returns options when reset flags present', () => {
  assert.deepEqual(getResetOptionsFromArgs(['--kawaii-reset']), { rollbackClaude: false });
  assert.deepEqual(getResetOptionsFromArgs(['--kawaii-reset=1']), { rollbackClaude: false });
  assert.deepEqual(getResetOptionsFromArgs(['--kawaii-reset-claude']), { rollbackClaude: true });
  assert.deepEqual(getResetOptionsFromArgs(['--kawaii-reset-claude=1']), { rollbackClaude: true });
  assert.equal(getResetOptionsFromArgs(['--other']), null);
});

test('stripResetArgs removes reset flags', () => {
  const args = ['--foo', '--kawaii-reset', '--bar', '--kawaii-reset-claude=1'];
  assert.deepEqual(stripResetArgs(args), ['--foo', '--bar']);
});

test('clampInt clamps and floors numeric input', () => {
  assert.equal(clampInt(3.9, 1, 5, 2), 3);
  assert.equal(clampInt(-10, 1, 5, 2), 1);
  assert.equal(clampInt(10, 1, 5, 2), 5);
  assert.equal(clampInt('nope', 1, 5, 2), 2);
});

test('normalizeTabId trims and rejects invalid values', () => {
  assert.equal(normalizeTabId(' tab-1 '), 'tab-1');
  assert.equal(normalizeTabId('tab id'), null);
  assert.equal(normalizeTabId(''), null);
  assert.equal(normalizeTabId('a'.repeat(161)), null);
  assert.equal(normalizeTabId('tab\nid'), null);
});
