(function () {
  'use strict';

  const FALLBACK_CAPTURE_LINES = 200;

  function isAltBuffer(terminal) {
    const type = terminal?.buffer?.active?.type;
    return type === 'alternate';
  }

  function hasCursorEdit(data) {
    if (!data) return false;
    if (data.includes('\r')) return true;
    // eslint-disable-next-line no-control-regex
    const csiEdit = /\x1b\[[0-9;]*[A-DGKHJ]/;
    return csiEdit.test(data);
  }

  function classifyOutput(data, terminal, state) {
    const buffer = terminal?.buffer?.active;
    const baseY = Number(buffer?.baseY) || 0;
    const length = Number(buffer?.length) || 0;
    const scrollMoved = baseY > (state.lastBaseY || 0) || length > (state.lastLength || 0);
    state.lastBaseY = baseY;
    state.lastLength = length;

    const cursorEdit = hasCursorEdit(data);
    const hasNewline = data.includes('\n');
    const meaningful = hasNewline || scrollMoved;
    return { meaningful, cursorEdit };
  }

  function hasVisibleOutput(data) {
    if (!data || typeof data !== 'string') return false;
    // Convert C1 control codes (8-bit) to 7-bit ESC sequences
    let text = data
      .replace(/\x90/g, '\x1bP')   // DCS
      .replace(/\x98/g, '\x1bX')   // SOS
      .replace(/\x9b/g, '\x1b[')   // CSI
      .replace(/\x9d/g, '\x1b]')   // OSC
      .replace(/\x9e/g, '\x1b^')   // PM
      .replace(/\x9f/g, '\x1b_')   // APC
      .replace(/\x9c/g, '\x1b\\'); // ST
    text = text
      // OSC sequences: \x1b] ... (BEL or ST)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
      // DCS sequences: \x1bP ... ST
      // eslint-disable-next-line no-control-regex
      .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
      // SOS sequences: \x1bX ... ST
      // eslint-disable-next-line no-control-regex
      .replace(/\x1bX[\s\S]*?\x1b\\/g, '')
      // PM sequences: \x1b^ ... ST
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\^[\s\S]*?\x1b\\/g, '')
      // APC sequences: \x1b_ ... ST
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b_[\s\S]*?\x1b\\/g, '')
      // CSI sequences: \x1b[ params intermediate final
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      // Fe sequences (single-char after ESC)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[@-Z\\-_]/g, '')
      // Remaining control characters
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, '');
    return /[^\s]/u.test(text);
  }

  function shouldCountOutputForIdle(terminalManager, state, data) {
    if (!terminalManager || !state) return false;
    if (!hasVisibleOutput(data)) return false;
    const currentBaseY = terminalManager.getScrollbackY?.() ?? 0;
    const prevBaseY = terminalManager.lastScrollbackY ?? 0;
    const currentViewportHash = terminalManager.getViewportHash?.() ?? 0;
    const prevViewportHash = terminalManager.lastViewportHash ?? 0;
    terminalManager.lastScrollbackY = currentBaseY;
    terminalManager.lastViewportHash = currentViewportHash;
    const shouldCount = currentBaseY > prevBaseY || currentViewportHash !== prevViewportHash;
    if (shouldCount && (!state.outputRunning || !state.outputBaseline)) {
      state.outputBaseline = {
        baseY: prevBaseY,
        viewportHash: prevViewportHash,
        terminalManager,
      };
    }
    return shouldCount;
  }

  function hasNetOutputChange(baseline) {
    if (!baseline) return true;
    const terminal = baseline.terminalManager;
    if (!terminal) return true;
    const currentBaseY = terminal.getScrollbackY?.() ?? 0;
    const currentViewportHash = terminal.getViewportHash?.() ?? 0;
    return currentBaseY !== baseline.baseY || currentViewportHash !== baseline.viewportHash;
  }

  function captureOutputFromMarker(terminal, marker, endMarker = null, store = null) {
    const buffer = terminal?.buffer?.active;
    if (!buffer) return '';

    let startLine = -1;
    if (marker && !marker.isDisposed && marker.line >= 0) {
      startLine = marker.line + 1;
    }
    if (startLine < 0 || startLine >= buffer.length) {
      startLine = Math.max(0, buffer.length - FALLBACK_CAPTURE_LINES);
    }

    let endLine = buffer.length;
    if (endMarker && !endMarker.isDisposed && endMarker.line >= 0 && endMarker.line <= buffer.length) {
      endLine = Math.max(startLine, Math.min(endLine, endMarker.line));
    }

    const lines = [];
    for (let y = startLine; y < endLine; y += 1) {
      const line = buffer.getLine(y);
      if (!line) continue;

      const text = line.translateToString(true);
      lines.push(text);
    }

    const raw = lines.join('\n');
    return store?.normalizeOutputText ? store.normalizeOutputText(raw) : String(raw || '').trimEnd();
  }

  window.HistoryOutputUtils = {
    isAltBuffer,
    classifyOutput,
    shouldCountOutputForIdle,
    hasNetOutputChange,
    captureOutputFromMarker,
  };
})();
