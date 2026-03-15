const test = require('node:test');
const assert = require('node:assert/strict');

function setupWindow() {
  global.window = {};
  global.document = {
    getElementById: () => null,
  };
  delete require.cache[require.resolve('../src/renderer/ui/history-sidebar-ui.js')];
  require('../src/renderer/ui/history-sidebar-ui.js');
}

test('HistorySidebarUI treats tracked custom pane ids as part of the active tab', () => {
  setupWindow();

  const ui = new window.HistorySidebarUI({
    tracker: {
      activeTabId: 'tab-window-1',
      activePaneId: 'pane-tab-window-1-2',
      getPaneTabId: (paneId) => (
        paneId === 'pane-1742012345678-abcd12' ? 'tab-window-1' : ''
      ),
    },
  });

  assert.equal(ui.isSessionInCurrentTab('pane-1742012345678-abcd12'), true);
});

test('HistorySidebarUI falls back to the active pane when tab binding is unavailable', () => {
  setupWindow();

  const ui = new window.HistorySidebarUI({
    tracker: {
      activeTabId: 'tab-window-1',
      activePaneId: 'pane-1742012345678-abcd12',
      getPaneTabId: () => '',
    },
  });

  assert.equal(ui.isSessionInCurrentTab('pane-1742012345678-abcd12'), true);
});
