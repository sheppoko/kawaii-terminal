(function () {
  'use strict';

  function initTerminalHealthIndicator(getActiveTerminal, debugMenu) {
    const toggle = document.getElementById('terminal-health-toggle');
    const panel = document.getElementById('terminal-health-panel');
    const title = document.getElementById('terminal-health-title');
    const body = document.getElementById('terminal-health-body');
    const refreshBtn = document.getElementById('terminal-health-refresh');
    if (!toggle || !panel || !title || !body || !refreshBtn) return null;

    let refreshInFlight = false;
    let panelOpen = false;

    const formatAgo = (ts) => {
      if (!ts) return '-';
      const diff = Date.now() - ts;
      if (!Number.isFinite(diff) || diff < 0) return '-';
      if (diff < 1000) return `${Math.round(diff)}ms`;
      const sec = Math.floor(diff / 1000);
      if (sec < 60) return `${sec}s`;
      const min = Math.floor(sec / 60);
      if (min < 60) return `${min}m`;
      const hour = Math.floor(min / 60);
      return `${hour}h`;
    };

    const updatePanel = (lines) => {
      body.textContent = lines.join('\n');
    };

    const refresh = async () => {
      if (refreshInFlight) return;
      refreshInFlight = true;
      try {
        const terminal = getActiveTerminal?.();
        if (!terminal) {
          title.querySelector('span').textContent = 'Terminal Health: NO TERM';
          updatePanel(['active: none']);
          return;
        }

        const local = terminal.getHealthSnapshot?.() || {};
        const tabId = local.tabId || terminal.getTabId?.() || null;

        let remote = null;
        if (tabId && window.terminalAPI?.status) {
          try {
            remote = await window.terminalAPI.status(tabId);
          } catch (_) {
            remote = null;
          }
        }

        const hasPty = remote?.ok ? Boolean(remote.hasPty) : null;
        const mappingMismatch = remote?.ok ? Boolean(remote.mappingMismatch) : false;
        const disableStdin = Boolean(local.disableStdin);

        let stateLabel = 'OK';
        if (hasPty === false) {
          stateLabel = 'NO PTY';
        } else if (mappingMismatch) {
          stateLabel = 'ROUTE';
        } else if (disableStdin) {
          stateLabel = 'INPUT';
        }

        title.querySelector('span').textContent = `Terminal Health: ${stateLabel}`;

        const lines = [
          `paneId: ${tabId || '-'}`,
          `hasPty: ${hasPty === null ? 'unknown' : String(hasPty)}`,
          `mappingMismatch: ${mappingMismatch ? 'true' : 'false'}`,
          `disableStdin: ${disableStdin ? 'true' : 'false'}`,
          `lastInputAgo: ${formatAgo(local.lastInputAt)}`,
          `lastOutputAgo: ${formatAgo(local.lastOutputAt)}`,
          `isOpen: ${local.isOpen ? 'true' : 'false'}`,
        ];
        if (remote?.ok) {
          lines.push(`mappedWebContentsId: ${remote.mappedWebContentsId ?? '-'}`);
          lines.push(`callerWebContentsId: ${remote.callerWebContentsId ?? '-'}`);
        }
        updatePanel(lines);
      } finally {
        refreshInFlight = false;
      }
    };

    const showPanel = async () => {
      panelOpen = true;
      panel.classList.add('show');
      panel.setAttribute('aria-hidden', 'false');
      await refresh();
    };

    const hidePanel = () => {
      panelOpen = false;
      panel.classList.remove('show');
      panel.setAttribute('aria-hidden', 'true');
    };

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      debugMenu?.hide?.();
      if (panelOpen) hidePanel();
      else showPanel();
    });

    refreshBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      refresh();
    });

    document.addEventListener('click', (e) => {
      if (!panel.contains(e.target)) {
        hidePanel();
      }
    });

    return {
      refresh,
      hide: hidePanel,
    };
  }

  function initTerminalSearchUI(getActiveTerminal) {
    const searchPanel = document.getElementById('terminal-search');
    const searchInput = document.getElementById('terminal-search-input');
    const searchPrev = document.getElementById('terminal-search-prev');
    const searchNext = document.getElementById('terminal-search-next');
    const searchClose = document.getElementById('terminal-search-close');
    const searchStatus = document.getElementById('terminal-search-status');
    const searchStatusCurrent = document.getElementById('terminal-search-status-current');
    const searchStatusTotal = document.getElementById('terminal-search-status-total');

    const activeTerminal = getActiveTerminal();
    if (activeTerminal && !activeTerminal.searchAddon) {
      console.warn('SearchAddon not loaded. Run npm install to fetch @xterm/addon-search.');
    }

    if (!searchPanel || !searchInput) {
      return {
        show: () => {},
        hide: () => {},
        searchNext: () => {},
        searchPrev: () => {},
      };
    }

    let isComposing = false;
    let lastSearchTerminal = null;
    let resultsTerminal = null;
    let searchResultsDisposable = null;

    const setSearchStatus = (current, total) => {
      if (!searchStatus) return;
      const safeTotal = Number.isFinite(total) ? total : 0;
      const safeCurrent = Number.isFinite(current) ? current : 0;
      if (searchStatusCurrent && searchStatusTotal) {
        searchStatusCurrent.textContent = String(safeCurrent);
        searchStatusTotal.textContent = String(safeTotal);
      } else {
        searchStatus.textContent = `${safeCurrent}/${safeTotal}`;
      }
    };

    const resetSearchStatus = () => {
      setSearchStatus(0, 0);
    };

    const detachSearchResults = () => {
      if (searchResultsDisposable && typeof searchResultsDisposable.dispose === 'function') {
        searchResultsDisposable.dispose();
      }
      searchResultsDisposable = null;
      resultsTerminal = null;
    };

    const attachSearchResults = (terminal) => {
      if (!terminal || terminal === resultsTerminal) return;
      detachSearchResults();
      resultsTerminal = terminal;
      const addon = terminal.searchAddon;
      if (addon?.onDidChangeResults) {
        searchResultsDisposable = addon.onDidChangeResults((event) => {
          const total = Number(event?.resultCount) || 0;
          const rawIndex = Number(event?.resultIndex);
          const current = Number.isFinite(rawIndex) && rawIndex >= 0 ? rawIndex + 1 : 0;
          setSearchStatus(current, total);
        });
      } else {
        resetSearchStatus();
      }
    };

    const clearSearchHighlights = (terminal) => {
      terminal?.searchAddon?.clearDecorations?.();
      terminal?.clearSelection?.();
      resetSearchStatus();
    };

    const runSearch = (direction) => {
      const term = searchInput.value.trim();
      const terminal = getActiveTerminal();
      if (!terminal) return;
      attachSearchResults(terminal);
      lastSearchTerminal = terminal;
      if (!term) {
        clearSearchHighlights(terminal);
        return;
      }
      if (direction === 'prev') {
        terminal.findPrevious(term);
      } else {
        terminal.findNext(term);
      }
    };

    const show = () => {
      searchPanel.classList.add('show');
      document.documentElement.classList.add('terminal-searching');
      window.KawaiiTerminalTheme?.refresh?.();
      attachSearchResults(getActiveTerminal());
      searchInput.focus();
      searchInput.select();
    };

    const hide = () => {
      searchPanel.classList.remove('show');
      document.documentElement.classList.remove('terminal-searching');
      window.KawaiiTerminalTheme?.refresh?.();
      clearSearchHighlights(lastSearchTerminal || getActiveTerminal());
      detachSearchResults();
      lastSearchTerminal = null;
      getActiveTerminal()?.focus?.();
    };

    const doSearchNext = () => {
      runSearch('next');
    };

    const doSearchPrev = () => {
      runSearch('prev');
    };

    searchInput.addEventListener('compositionstart', () => {
      isComposing = true;
    });

    searchInput.addEventListener('compositionend', () => {
      isComposing = false;
      runSearch('next');
    });

    searchInput.addEventListener('input', () => {
      if (isComposing) return;
      runSearch('next');
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          doSearchPrev();
        } else {
          doSearchNext();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hide();
      }
    });

    searchPrev?.addEventListener('click', (e) => {
      e.preventDefault();
      doSearchPrev();
    });

    searchNext?.addEventListener('click', (e) => {
      e.preventDefault();
      doSearchNext();
    });

    searchClose?.addEventListener('click', (e) => {
      e.preventDefault();
      hide();
    });

    return {
      show,
      hide,
      searchNext: doSearchNext,
      searchPrev: doSearchPrev,
    };
  }

  function initTerminalContextMenu(getActiveTerminal, searchUI, tabManager, shortcutManager) {
    const menu = document.getElementById('terminal-context-menu');
    const terminalPanel = document.querySelector('.terminal-panel');
    if (!menu || !terminalPanel) return;

    const copyItem = menu.querySelector('[data-action="copy"]');
    const pasteItem = menu.querySelector('[data-action="paste"]');
    const findItem = menu.querySelector('[data-action="find"]');
    const splitRightItem = menu.querySelector('[data-action="split-right"]');
    const splitDownItem = menu.querySelector('[data-action="split-down"]');
    const closePaneItem = menu.querySelector('[data-action="close-pane"]');
    const clearItem = menu.querySelector('[data-action="clear"]');
    const contextIntentWindowMs = 800;
    let lastPointerContextAt = 0;
    let lastKeyboardContextAt = 0;

    const now = () => (window.performance?.now ? performance.now() : Date.now());
    const isRecent = (timestamp) => timestamp > 0 && now() - timestamp < contextIntentWindowMs;
    const isTerminalStackTarget = (target) => {
      if (!target || typeof target.closest !== 'function') return false;
      return Boolean(target.closest('.terminal-stack'));
    };

    const recordPointerContext = (event) => {
      if (event.button !== 2) return;
      if (!isTerminalStackTarget(event.target)) return;
      lastPointerContextAt = now();
    };

    const recordKeyboardContext = (event) => {
      if (!isTerminalStackTarget(event.target)) return;
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        lastKeyboardContextAt = now();
      }
    };

    terminalPanel.addEventListener('pointerdown', recordPointerContext, true);
    terminalPanel.addEventListener('mousedown', recordPointerContext, true);
    document.addEventListener('keydown', recordKeyboardContext, true);

    const hideMenu = () => {
      menu.classList.remove('show');
    };

    const showMenu = (x, y) => {
      const { innerWidth, innerHeight } = window;
      menu.classList.add('show');
      const rect = menu.getBoundingClientRect();
      const left = Math.min(x, innerWidth - rect.width - 8);
      const top = Math.min(y, innerHeight - rect.height - 8);
      menu.style.left = `${Math.max(8, left)}px`;
      menu.style.top = `${Math.max(8, top)}px`;
    };

    const updateMenuState = () => {
      const terminalManager = getActiveTerminal();
      const hasSelection = terminalManager?.hasSelection() || false;
      copyItem?.classList.toggle('disabled', !hasSelection);
      splitRightItem?.classList.toggle('disabled', !tabManager?.canSplitActivePane?.('row'));
      splitDownItem?.classList.toggle('disabled', !tabManager?.canSplitActivePane?.('col'));
      closePaneItem?.classList.toggle('disabled', !tabManager?.canCloseActivePane?.());
    };

    const updateShortcutHints = () => {
      menu.querySelectorAll('.context-menu-item[data-shortcut]').forEach((item) => {
        const hint = item.querySelector('.context-menu-hint');
        if (!hint) return;
        const commandId = item.dataset.shortcut;
        if (!shortcutManager || !commandId) {
          hint.textContent = '';
          return;
        }
        const binding = shortcutManager.getBindings(commandId)[0] || '';
        hint.textContent = binding
          ? shortcutManager.formatLabel(binding, shortcutManager.platformKey === 'mac')
          : '';
      });
    };

    updateShortcutHints();
    shortcutManager?.onChange?.(updateShortcutHints);

    terminalPanel.addEventListener('contextmenu', (e) => {
      if (!isTerminalStackTarget(e.target)) return;
      const keyboardIntent = isRecent(lastKeyboardContextAt)
        || (e.detail === 0 && e.clientX === 0 && e.clientY === 0);
      const pointerIntent = e.button === 2
        || (typeof e.buttons === 'number' && (e.buttons & 2))
        || isRecent(lastPointerContextAt);
      if (!keyboardIntent && !pointerIntent) return;
      if (keyboardIntent && e.clientX === 0 && e.clientY === 0) return;
      e.preventDefault();
      if (!keyboardIntent) {
        tabManager?.activatePaneAtPoint?.(e.clientX, e.clientY);
      }
      updateMenuState();
      showMenu(e.clientX, e.clientY);
      if (keyboardIntent) lastKeyboardContextAt = 0;
      if (pointerIntent) lastPointerContextAt = 0;
    });

    document.addEventListener('click', () => hideMenu());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        hideMenu();
      }
    });

    copyItem?.addEventListener('click', () => {
      const terminalManager = getActiveTerminal();
      if (!terminalManager) return;
      if (!terminalManager.hasSelection()) return;
      window.ClipboardUtils?.writeText?.(terminalManager.getSelection());
      hideMenu();
    });

    pasteItem?.addEventListener('click', async () => {
      const terminalManager = getActiveTerminal();
      if (!terminalManager) return;
      const text = await window.ClipboardUtils?.readText?.();
      terminalManager.paste(text);
      hideMenu();
    });

    findItem?.addEventListener('click', () => {
      searchUI.show();
      hideMenu();
    });

    splitRightItem?.addEventListener('click', () => {
      if (splitRightItem.classList.contains('disabled')) return;
      tabManager?.splitActivePane?.('row', 'after');
      hideMenu();
    });

    splitDownItem?.addEventListener('click', () => {
      if (splitDownItem.classList.contains('disabled')) return;
      tabManager?.splitActivePane?.('col', 'after');
      hideMenu();
    });

    closePaneItem?.addEventListener('click', () => {
      if (closePaneItem.classList.contains('disabled')) return;
      tabManager?.closeActivePane?.();
      hideMenu();
    });

    clearItem?.addEventListener('click', () => {
      const terminalManager = getActiveTerminal();
      if (!terminalManager) return;
      terminalManager.clear();
      hideMenu();
    });
  }

  window.TerminalUI = {
    initTerminalHealthIndicator,
    initTerminalSearchUI,
    initTerminalContextMenu,
  };
})();
