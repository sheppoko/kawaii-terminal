const test = require('node:test');
const assert = require('node:assert/strict');

function setupWindow() {
  global.window = {};
  delete require.cache[require.resolve('../src/renderer/history/output-utils.js')];
  delete require.cache[require.resolve('../src/renderer/history/pane-state.js')];
  delete require.cache[require.resolve('../src/renderer/history/history-session-tracker.js')];
  require('../src/renderer/history/output-utils.js');
  require('../src/renderer/history/pane-state.js');
  window.statusAPI = { sendOutput: () => {} };
  require('../src/renderer/history/history-session-tracker.js');
}

test('HistorySessionTracker does not alter status based on output idle', () => {
  setupWindow();

  const tracker = new window.HistorySessionTracker({
    sessionId: 'test',
    historySource: 'codex',
  });

  tracker.setStatusProvider({
    getStatus: () => ({
      source: 'codex',
      session_id: 's1',
      session_key: 'codex:s1',
      status: 'working',
      pane_id: 'pane-1',
      updated_at: Date.now(),
      flags: {},
    }),
    entries: new Map(),
  });

  const state = tracker.ensurePaneState('pane-1');
  state.outputIdle = true;

  const result = tracker.getSessionStatus({ sessionId: 's1', source: 'codex' });
  assert.ok(result);
  assert.equal(result.status, 'working');
});

test('HistorySessionTracker tracks pane tab bindings for custom pane ids', () => {
  setupWindow();

  const tracker = new window.HistorySessionTracker({
    sessionId: 'test',
    historySource: 'all',
  });

  tracker.bindPaneToTab('pane-1742012345678-abcd12', 'tab-window-1');

  assert.equal(tracker.getPaneTabId('pane-1742012345678-abcd12'), 'tab-window-1');
});

test('HistorySessionTracker includes tracked tab_id in output idle events', () => {
  setupWindow();

  const payloads = [];
  window.statusAPI = {
    sendOutput: (payload) => payloads.push(payload),
  };

  const tracker = new window.HistorySessionTracker({
    sessionId: 'test',
    historySource: 'all',
  });

  tracker.bindPaneToTab('pane-1742012345678-abcd12', 'tab-window-1');
  tracker.setPaneOutputIdle('pane-1742012345678-abcd12', true);

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].pane_id, 'pane-1742012345678-abcd12');
  assert.equal(payloads[0].tab_id, 'tab-window-1');
  assert.equal(payloads[0].idle, true);
});

test('HistorySessionTracker closes custom pane ids passed to handleTabClose', () => {
  setupWindow();

  const tracker = new window.HistorySessionTracker({
    sessionId: 'test',
    historySource: 'all',
  });

  tracker.bindPaneToTab('pane-1742012345678-abcd12', 'tab-window-1');

  const state = tracker.ensurePaneState('pane-1742012345678-abcd12');
  state.outputIdleTimer = setTimeout(() => {}, 1000);

  tracker.handleTabClose('tab-window-1', ['pane-1742012345678-abcd12']);

  assert.equal(tracker.panes.has('pane-1742012345678-abcd12'), false);
});
