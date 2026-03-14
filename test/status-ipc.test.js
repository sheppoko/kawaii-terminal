const test = require('node:test');
const assert = require('node:assert/strict');

const { extractTabIdFromPaneId } = require('../src/main/status/status-ipc');

test('extractTabIdFromPaneId reads standard pane ids', () => {
  assert.equal(
    extractTabIdFromPaneId('pane-tab-window-1-1700000000000-2'),
    'tab-window-1-1700000000000'
  );
});

test('extractTabIdFromPaneId ignores detached custom pane ids', () => {
  assert.equal(extractTabIdFromPaneId('pane-1742012345678-abcd12'), '');
});
