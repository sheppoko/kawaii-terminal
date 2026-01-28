const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractClaudeMessageText,
  filterClaudeToolBlocks,
  forEachClaudeToolBlock,
  getClaudeMessageContentSlot,
  isClaudeUserPromptEntry,
} = require('../src/main/history/utils/claude-utils');

test('extractClaudeMessageText skips tool blocks and keeps text', () => {
  const entry = {
    role: 'user',
    content: [
      { type: 'tool_use', id: 't1' },
      { type: 'text', text: 'hello' },
      { type: 'tool_result', tool_use_id: 't1', content: 'ignored' },
    ],
  };
  assert.equal(extractClaudeMessageText(entry), 'hello');
});

test('getClaudeMessageContentSlot prefers message payload content', () => {
  const entry = {
    payload: {
      role: 'assistant',
      content: 'payload-text',
    },
  };
  const slot = getClaudeMessageContentSlot(entry);
  assert.equal(slot?.content, 'payload-text');
  assert.equal(slot?.key, 'content');
});

test('forEachClaudeToolBlock visits nested tool_use and tool_result', () => {
  const content = [
    { type: 'text', text: 'a' },
    [{ type: 'tool_use', id: 'u1' }],
    { type: 'tool_result', tool_use_id: 'u1' },
  ];
  const seen = [];
  forEachClaudeToolBlock(content, (block, type) => {
    seen.push(`${type}:${block.id || block.tool_use_id}`);
  });
  assert.deepEqual(seen.sort(), ['tool_result:u1', 'tool_use:u1']);
});

test('filterClaudeToolBlocks drops orphaned tool_result and unknown tool_use', () => {
  const allowedToolUseIds = new Set(['u1']);
  const allowedToolResultIds = new Set(['u1']);
  const seenToolUses = new Set();
  const content = [
    { type: 'tool_result', tool_use_id: 'u1', content: 'first' },
    { type: 'tool_use', id: 'u1', name: 'tool' },
    { type: 'tool_result', tool_use_id: 'u1', content: 'second' },
    { type: 'tool_use', id: 'u2', name: 'unknown' },
  ];
  const result = filterClaudeToolBlocks(content, { allowedToolUseIds, allowedToolResultIds, seenToolUses });
  const types = result.content.map(item => item.type);
  assert.equal(result.removedAny, true);
  assert.deepEqual(types, ['tool_use', 'tool_result']);
});

test('isClaudeUserPromptEntry returns true for user text entry', () => {
  const entry = { role: 'user', content: 'hello' };
  assert.equal(isClaudeUserPromptEntry(entry), true);
});

test('extractClaudeMessageText ignores local command transcript tags', () => {
  const entry = {
    role: 'user',
    content: '<local-command-stdout>Set model to Default</local-command-stdout>',
  };
  assert.equal(extractClaudeMessageText(entry), '');
});
