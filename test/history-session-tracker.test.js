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
