const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createClaudeBlockBuilder,
  parseClaudeTimestampMs,
} = require('../src/main/history/domain/builders/claude-blocks');

test('parseClaudeTimestampMs returns 0 for empty and parses ISO timestamps', () => {
  assert.equal(parseClaudeTimestampMs(''), 0);
  const iso = '2024-01-02T03:04:05Z';
  assert.equal(parseClaudeTimestampMs(iso), Date.parse(iso));
});

test('createClaudeBlockBuilder requires fallback and source id builders', () => {
  assert.throws(
    () => createClaudeBlockBuilder({ buildSourceBlockId: () => 'id' }),
    /buildFallbackId/,
  );
  assert.throws(
    () => createClaudeBlockBuilder({ buildFallbackId: () => 'fallback' }),
    /buildSourceBlockId/,
  );
});

test('buildClaudeBlockFromTurn constructs block and attaches metadata', () => {
  const attached = [];
  const builder = createClaudeBlockBuilder({
    buildFallbackId: () => 'fallback',
    buildSourceBlockId: (source, id) => `${source}:${id}`,
    attachWslMetadata: (block, meta) => {
      attached.push(meta);
      block._attached = true;
    },
  });

  const block = builder.buildClaudeBlockFromTurn({
    userUuid: 'u1',
    sessionId: 's1',
    userText: 'hi',
    outputText: 'out',
    createdAt: 100,
    lastOutputAt: 200,
    projectKey: '/tmp/project',
    paneLabel: 'Claude',
    cwd: '/tmp/project',
    sourcePath: '/tmp/project/abc.jsonl',
    model: 'claude-3',
  });

  assert.equal(block.id, 'claude:u1');
  assert.equal(block.source_id, 'u1');
  assert.equal(block.session_id, 's1');
  assert.equal(block.input, 'hi');
  assert.equal(block.output_text, 'out');
  assert.equal(block.created_at, 100);
  assert.equal(block.last_output_at, 200);
  assert.equal(block.model, 'claude-3');
  assert.equal(block._attached, true);
  assert.equal(attached.length, 1);
});

test('extractClaudeBlocksFromEntries merges user/assistant turns', () => {
  const builder = createClaudeBlockBuilder({
    buildFallbackId: () => 'fallback',
    buildSourceBlockId: (source, id) => `${source}:${id}`,
    attachWslMetadata: (block) => {
      block._attached = true;
    },
    extractModelFromEntry: (entry) => entry.model,
  });

  const entries = [
    {
      role: 'user',
      uuid: 'u1',
      sessionId: 's1',
      timestamp: '2024-01-01T00:00:00Z',
      content: [{ type: 'text', text: 'hello' }],
    },
    {
      role: 'assistant',
      timestamp: '2024-01-01T00:00:05Z',
      model: 'claude-3-opus',
      content: [{ type: 'text', text: 'world' }],
    },
    {
      isSidechain: true,
      role: 'assistant',
      content: 'ignored',
    },
  ];

  const blocks = builder.extractClaudeBlocksFromEntries(entries, {
    projectKey: '/tmp/project',
    paneLabel: 'Claude',
    cwd: '/tmp/project',
    sourcePath: '/tmp/project/abc.jsonl',
  });

  assert.equal(blocks.length, 1);
  const block = blocks[0];
  assert.equal(block.input, 'hello');
  assert.equal(block.output_text, 'world');
  assert.equal(block.model, 'claude-3-opus');
  assert.equal(block._attached, true);
  assert.ok(block.last_output_at >= block.created_at);
});
