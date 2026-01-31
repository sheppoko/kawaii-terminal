const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSyntheticCodexSessionMeta,
  buildTimeMachineSessionId,
  isTargetCodexUserMessage,
} = require('../src/main/history/utils/codex-utils');

test('buildTimeMachineSessionId returns UUID v7 format', () => {
  const id = buildTimeMachineSessionId();
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
});

test('buildSyntheticCodexSessionMeta sets defaults and filters invalid forked_from_id', () => {
  const now = 1769136000000; // 2026-01-23T00:00:00.000Z
  const entries = [
    {
      type: 'session_meta',
      payload: {
        id: 'deadbeef-dead-beef-dead-beefdeadbeef',
        originator: '',
        cli_version: '',
        source: '',
        forked_from_id: 'not-a-uuid',
      },
    },
    {
      type: 'turn_context',
      payload: {
        cwd: '/tmp/project',
      },
    },
  ];

  const newSessionId = '01234567-89ab-7cde-8f01-23456789abcd';
  const meta = buildSyntheticCodexSessionMeta({
    entries,
    newSessionId,
    forkedFromId: 'invalid',
    now,
  });

  assert.equal(meta.type, 'session_meta');
  assert.equal(meta.payload.id, newSessionId);
  assert.equal(meta.payload.timestamp, new Date(now).toISOString());
  assert.equal(meta.payload.originator, 'codex_cli_rs');
  assert.equal(meta.payload.cli_version, '0.0.0');
  assert.equal(meta.payload.source, 'cli');
  assert.equal(meta.payload.cwd, '/tmp/project');
  assert.equal(Object.prototype.hasOwnProperty.call(meta.payload, 'forked_from_id'), false);
});

test('buildSyntheticCodexSessionMeta keeps valid forked_from_id', () => {
  const now = 1769136000000;
  const entries = [
    {
      type: 'session_meta',
      payload: {
        id: 'deadbeef-dead-beef-dead-beefdeadbeef',
      },
    },
  ];
  const newSessionId = '01234567-89ab-7cde-8f01-23456789abcd';
  const forkedFromId = '12345678-1234-7123-8123-1234567890ab';

  const meta = buildSyntheticCodexSessionMeta({
    entries,
    newSessionId,
    forkedFromId,
    now,
  });

  assert.equal(meta.payload.forked_from_id, forkedFromId);
});

test('isTargetCodexUserMessage matches by text and timestamp', () => {
  const msg = { role: 'user', text: 'hello', timestamp: 1710000000000 };
  assert.equal(isTargetCodexUserMessage(msg, 'hello', 0), true);
  assert.equal(isTargetCodexUserMessage(msg, 'nope', 1710000000000), true);
  assert.equal(isTargetCodexUserMessage(msg, 'nope', 1710000005000), false);
});
