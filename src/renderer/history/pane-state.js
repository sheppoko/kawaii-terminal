(function () {
  'use strict';

  function createPaneState() {
    return {
      pendingQueue: [],
      liveBlock: null,
      bufferedOutput: '',
      lastOutputAt: 0,
      lastActivityAt: 0,
      idleTimer: null,
      outputIdle: false,
      outputIdleTimer: null,
      outputRunning: false,
      outputBaseline: null,
      lastBaseY: 0,
      lastLength: 0,
      paneLabel: '',
      altBuffer: false,
      terminalManager: null,
      cursorEditCount: 0,
      meaningfulCount: 0,
      likelyTui: false,
      lastCommandText: '',
      lastCommandAt: 0,
      lastCodexCommand: '',
      lastCodexCommandAt: 0,
      cwdEventCount: 0,
      cwd: '',
      sessionTag: '',
      sessionLabel: '',
    };
  }

  window.HistoryPaneState = {
    createPaneState,
  };
})();
