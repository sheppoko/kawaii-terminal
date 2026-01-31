(function () {
  'use strict';

  const STYLE_STORAGE_KEY = 'kawaii-terminal-style';
  let resizeFocusHandler = null;
  let statusDebugToggle = null;

  const isMac = () => window.windowAPI?.platform === 'darwin';

  function getSystemStyle() {
    const platform = window.windowAPI?.platform;
    return platform === 'darwin' ? 'mac' : 'win';
  }

  function getCurrentStyle() {
    const saved = localStorage.getItem(STYLE_STORAGE_KEY);
    if (saved && saved !== 'auto') {
      return saved;
    }
    return getSystemStyle();
  }

  function applyTitlebarStyle(style) {
    const titlebar = document.getElementById('titlebar');
    if (!titlebar) return;
    titlebar.classList.remove('win', 'mac');
    titlebar.classList.add(style);

    const savedStyle = localStorage.getItem(STYLE_STORAGE_KEY) || 'auto';
    document.querySelectorAll('.debug-menu-item').forEach(item => {
      item.classList.toggle('active', item.dataset.style === savedStyle);
    });
  }

  function syncMacTitlebarOffsets() {
    if (!isMac()) {
      document.body.style.removeProperty('--left-shell-top-offset');
      return;
    }
    const titlebar = document.getElementById('titlebar');
    if (!titlebar) return;
    const height = Math.ceil(titlebar.getBoundingClientRect().height || 0);
    if (height > 0) {
      document.body.style.setProperty('--left-shell-top-offset', `${height}px`);
    }
  }

  function initTitlebarStyle() {
    const style = getCurrentStyle();
    applyTitlebarStyle(style);
    document.body.classList.toggle('platform-mac', isMac());
    syncMacTitlebarOffsets();

    const titlebar = document.getElementById('titlebar');
    titlebar?.addEventListener('dblclick', (e) => {
      if (e.target.closest('.tab, button, .window-controls')) return;
      window.windowAPI?.titlebarDoubleClick?.();
    });

    window.windowAPI?.onMaximizedChange?.(({ isMaximized }) => {
      document.body.classList.toggle('window-maximized', isMaximized);
    });

    window.windowAPI?.onFullscreenChange?.(({ isFullscreen }) => {
      document.body.classList.toggle('window-fullscreen', isFullscreen);
    });
  }

  function initDebugMenu() {
    const debugMenu = document.getElementById('debug-menu');
    if (!debugMenu) {
      return {
        toggle: () => {},
        hide: () => {},
      };
    }

    const toggle = () => {
      debugMenu.classList.toggle('show');
    };

    document.addEventListener('click', (e) => {
      if (!debugMenu.contains(e.target)) {
        debugMenu.classList.remove('show');
      }
    });

    document.querySelectorAll('.debug-menu-item[data-style]').forEach(item => {
      item.addEventListener('click', () => {
        const style = item.dataset.style;
        localStorage.setItem(STYLE_STORAGE_KEY, style);

        const effectiveStyle = style === 'auto' ? getSystemStyle() : style;
        applyTitlebarStyle(effectiveStyle);

        debugMenu.classList.remove('show');
      });
    });

    document.getElementById('toggle-devtools')?.addEventListener('click', () => {
      window.windowAPI?.toggleDevTools?.();
      debugMenu.classList.remove('show');
    });

    document.getElementById('cheer-boost')?.addEventListener('click', () => {
      if (window.cheerUIUpdateInterval) {
        window.cheerUIUpdateInterval(60);
        window.kawaiiDebugLog('[Debug] Cheer Boost mode enabled (1m interval)');
      }
      debugMenu.classList.remove('show');
    });

    document.getElementById('toggle-status-debug')?.addEventListener('click', () => {
      statusDebugToggle?.();
      debugMenu.classList.remove('show');
    });

    const requestReset = async ({ rollbackClaude = false } = {}) => {
      if (!window.resetAPI?.requestReset) return;
      const message = rollbackClaude
        ? 'Full reset: app data + temp + rollback Claude hooks. The app will restart. Continue?'
        : 'Full reset: app data + temp. The app will restart. Continue?';
      if (!window.confirm(message)) {
        debugMenu.classList.remove('show');
        return;
      }
      debugMenu.classList.remove('show');
      try {
        await window.resetAPI.requestReset({ rollbackClaude: Boolean(rollbackClaude) });
      } catch (_) {
        // ignore
      }
    };

    document.getElementById('reset-app-data')?.addEventListener('click', () => {
      void requestReset({ rollbackClaude: false });
    });

    document.getElementById('reset-app-data-claude')?.addEventListener('click', () => {
      void requestReset({ rollbackClaude: true });
    });

    return {
      toggle,
      hide: () => debugMenu.classList.remove('show'),
    };
  }

  function initStatusDebugPanel(historyManager) {
    if (!historyManager) return;
    const existing = document.querySelector('.status-debug-overlay');
    if (existing) return;
    const panel = document.createElement('div');
    panel.className = 'status-debug-overlay';
    panel.classList.add('is-hidden');
    panel.innerHTML = `
      <div class="status-debug-title">Status Debug</div>
      <pre class="status-debug-body"></pre>
    `;
    document.body.appendChild(panel);
    const body = panel.querySelector('.status-debug-body');
    let debugVisible = false;
    let updateTimer = null;
    const startUpdate = () => {
      if (updateTimer) return;
      updateTimer = setInterval(update, 800);
    };
    const stopUpdate = () => {
      if (!updateTimer) return;
      clearInterval(updateTimer);
      updateTimer = null;
    };
    const applyVisibility = () => {
      panel.classList.toggle('is-hidden', !debugVisible);
      if (debugVisible) {
        update();
        startUpdate();
      } else {
        stopUpdate();
      }
    };
    const toggleDebug = () => {
      debugVisible = !debugVisible;
      applyVisibility();
    };
    statusDebugToggle = toggleDebug;

    const shortId = (value) => {
      const raw = String(value || '');
      if (!raw) return '-';
      return raw.length > 8 ? raw.slice(-8) : raw;
    };

    const formatEvent = (label, payload) => {
      if (!payload || typeof payload !== 'object') return `${label}: -`;
      const source = payload.source || payload.event || '';
      const event = payload.event ? ` ${payload.event}` : '';
      const session = payload.session_id ? ` sid:${shortId(payload.session_id)}` : '';
      const pane = payload.pane_id ? ` pane:${payload.pane_id}` : '';
      const hook = payload.hook ? ` hook:${payload.hook}` : '';
      return `${label}: ${source}${event}${session}${pane}${hook}`;
    };

    const update = () => {
      const snapshot = historyManager.getDebugSnapshot?.();
      if (!snapshot || !body) return;
      const lines = [];
      lines.push(`activePane: ${snapshot.active_pane_id || '-'}`);
      const cwdTail = snapshot.last_cwd ? snapshot.last_cwd.split(/[/\\]/).filter(Boolean).slice(-2).join('/') : '';
      lines.push(`panes:${snapshot.pane_count} bindings:${snapshot.binding_count} paneBindings:${snapshot.pane_binding_count} statuses:${snapshot.session_count} pendingCodex:${snapshot.pending_codex}`);
      lines.push(`cwdEvents:${snapshot.cwd_count || 0}${cwdTail ? ` last:${cwdTail}` : ''}`);
      lines.push(formatEvent('notify', snapshot.last_notify));
      lines.push(formatEvent('status', snapshot.last_status));
      const lastCommand = snapshot.last_command;
      if (lastCommand && typeof lastCommand === 'object') {
        const pane = lastCommand.pane_id ? ` pane:${lastCommand.pane_id}` : '';
        const age = lastCommand.timestamp ? Math.max(0, Date.now() - lastCommand.timestamp) : 0;
        const ageSec = age ? `${Math.round(age / 1000)}s` : '';
        const source = lastCommand.source ? ` ${lastCommand.source}` : '';
        lines.push(`cmd:${pane} ${lastCommand.command || '-'}${ageSec ? ` (${ageSec})` : ''}${source ? ` [${source}]` : ''}`);
      } else {
        lines.push('cmd: -');
      }
      const lastShell = snapshot.last_shell;
      if (lastShell && typeof lastShell === 'object') {
        const pane = lastShell.pane_id ? ` pane:${lastShell.pane_id}` : '';
        const age = lastShell.timestamp ? Math.max(0, Date.now() - lastShell.timestamp) : 0;
        const ageSec = age ? `${Math.round(age / 1000)}s` : '';
        const source = lastShell.source ? ` ${lastShell.source}` : '';
        lines.push(`shell:${pane} ${lastShell.info || '-'}${ageSec ? ` (${ageSec})` : ''}${source ? ` [${source}]` : ''}`);
      } else {
        lines.push('shell: -');
      }
      const lastProfile = snapshot.last_profile;
      if (lastProfile && typeof lastProfile === 'object') {
        const pane = lastProfile.pane_id ? ` pane:${lastProfile.pane_id}` : '';
        const age = lastProfile.timestamp ? Math.max(0, Date.now() - lastProfile.timestamp) : 0;
        const ageSec = age ? `${Math.round(age / 1000)}s` : '';
        lines.push(`profile:${pane} ${lastProfile.profile_id || '-'}${ageSec ? ` (${ageSec})` : ''}`);
      } else {
        lines.push('profile: -');
      }
      const oscCount = Number(snapshot.osc_count || 0);
      const oscKawaiiCount = Number(snapshot.osc_kawaii_count || 0);
      const lastOsc = snapshot.last_osc ? ` ${snapshot.last_osc}` : '';
      const lastKawaii = snapshot.last_kawaii_osc ? ` ${snapshot.last_kawaii_osc}` : '';
      lines.push(`osc: ${oscCount} kawaii:${oscKawaiiCount}${lastOsc ? ` last:${lastOsc}` : ''}`);
      if (lastKawaii) {
        lines.push(`oscKawaii:${lastKawaii}`);
      }
      const codexCommand = snapshot.last_codex_command;
      if (codexCommand && typeof codexCommand === 'object') {
        const cmd = codexCommand.command || '';
        const pane = codexCommand.pane_id ? ` pane:${codexCommand.pane_id}` : '';
        lines.push(`codexCmd:${pane} ${cmd || '-'}`);
      } else {
        lines.push('codexCmd: -');
      }
      const codexSummary = snapshot.last_codex_summary;
      if (codexSummary && typeof codexSummary === 'object') {
        const sid = codexSummary.session_id ? ` sid:${shortId(codexSummary.session_id)}` : '';
        const status = codexSummary.status ? ` ${codexSummary.status}` : '';
        lines.push(`codexJsonl:${status}${sid}`);
      } else {
        lines.push('codexJsonl: -');
      }
      body.textContent = lines.join('\n');
    };

    applyVisibility();
  }

  function initWindowResizeHandles() {
    if (!window.windowAPI?.setBounds) return;
    if (window.windowAPI?.platform === 'darwin') return;
    const handleDefs = [
      { dir: 'n' }, { dir: 's' }, { dir: 'e' }, { dir: 'w' },
      { dir: 'ne' }, { dir: 'nw' }, { dir: 'se' }, { dir: 'sw' },
    ];
    const handles = [];
    for (const def of handleDefs) {
      const el = document.createElement('div');
      el.className = `window-resize-handle ${def.dir}`;
      el.dataset.dir = def.dir;
      document.body.appendChild(el);
      handles.push(el);
    }

    const MIN_WIDTH = 800;
    const MIN_HEIGHT = 500;
    let resizeState = null;
    let resizeRaf = null;
    const onVisibilityChange = () => {
      if (document.hidden) {
        stopResize();
      }
    };

    const applyResize = () => {
      resizeRaf = null;
      if (!resizeState?.pending) return;
      const { x, y, width, height } = resizeState.pending;
      window.windowAPI.setBounds({ x, y, width, height });
    };

    const scheduleResize = (bounds) => {
      resizeState.pending = bounds;
      if (resizeRaf) return;
      resizeRaf = window.requestAnimationFrame(applyResize);
    };

    const onPointerMove = (event) => {
      if (!resizeState) return;
      event.preventDefault();
      const { start, dir } = resizeState;
      const dx = event.screenX - start.mouseX;
      const dy = event.screenY - start.mouseY;
      let x = start.x;
      let y = start.y;
      let width = start.width;
      let height = start.height;

      if (dir.includes('e')) {
        width = start.width + dx;
      }
      if (dir.includes('s')) {
        height = start.height + dy;
      }
      if (dir.includes('w')) {
        width = start.width - dx;
        x = start.x + dx;
      }
      if (dir.includes('n')) {
        height = start.height - dy;
        y = start.y + dy;
      }

      if (width < MIN_WIDTH) {
        if (dir.includes('w')) {
          x -= (MIN_WIDTH - width);
        }
        width = MIN_WIDTH;
      }
      if (height < MIN_HEIGHT) {
        if (dir.includes('n')) {
          y -= (MIN_HEIGHT - height);
        }
        height = MIN_HEIGHT;
      }

      scheduleResize({
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
      });
    };

    const stopResize = () => {
      if (!resizeState) return;
      resizeState = null;
      document.body.classList.remove('window-resizing');
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', stopResize, true);
      window.removeEventListener('pointercancel', stopResize, true);
      window.removeEventListener('blur', stopResize, true);
      document.removeEventListener('visibilitychange', onVisibilityChange, true);
      resizeFocusHandler?.();
    };

    const onPointerDown = (event) => {
      if (event.button !== 0) return;
      const dir = event.currentTarget?.dataset?.dir;
      if (!dir) return;
      event.preventDefault();
      event.stopPropagation();
      resizeState = {
        dir,
        start: {
          mouseX: event.screenX,
          mouseY: event.screenY,
          x: window.screenX,
          y: window.screenY,
          width: window.outerWidth,
          height: window.outerHeight,
        },
        pending: null,
      };
      document.body.classList.add('window-resizing');
      window.addEventListener('pointermove', onPointerMove, true);
      window.addEventListener('pointerup', stopResize, true);
      window.addEventListener('pointercancel', stopResize, true);
      window.addEventListener('blur', stopResize, true);
      document.addEventListener('visibilitychange', onVisibilityChange, true);
    };

    handles.forEach((el) => {
      el.addEventListener('pointerdown', onPointerDown);
    });
  }

  function setResizeFocusHandler(handler) {
    resizeFocusHandler = typeof handler === 'function' ? handler : null;
  }

  window.WindowUI = {
    initTitlebarStyle,
    initDebugMenu,
    initStatusDebugPanel,
    initWindowResizeHandles,
    syncTitlebarOffsets: syncMacTitlebarOffsets,
    setResizeFocusHandler,
  };
})();
