(function () {
  'use strict';

  function createActionDispatcher(options = {}) {
    const {
      getActiveTerminal,
      searchUI,
      tabManager,
      pinManager,
      getShortcutSheet,
      isEditableTarget,
      getEditableSelectionText,
      pasteIntoEditableTarget,
      readClipboardText,
      writeClipboardText,
    } = options;

    const isEditable = typeof isEditableTarget === 'function' ? isEditableTarget : () => false;
    const getSelectionText = typeof getEditableSelectionText === 'function' ? getEditableSelectionText : () => '';
    const pasteInto = typeof pasteIntoEditableTarget === 'function' ? pasteIntoEditableTarget : () => false;
    const readClipboard = typeof readClipboardText === 'function' ? readClipboardText : async () => '';
    const writeClipboard = typeof writeClipboardText === 'function' ? writeClipboardText : async () => false;

    return async (action) => {
      if (!action) return;

      const terminalManager = getActiveTerminal?.();
      const shortcutSheet = typeof getShortcutSheet === 'function' ? getShortcutSheet() : null;

      switch (action) {
        case 'tab:new':
          tabManager?.newTab?.();
          break;
        case 'tab:close':
          tabManager?.closeActiveTab?.();
          break;
        case 'pane:split-right':
          tabManager?.splitActivePane?.('row', 'after');
          break;
        case 'pane:split-down':
          tabManager?.splitActivePane?.('col', 'after');
          break;
        case 'pane:close':
          tabManager?.closeActivePane?.();
          break;
        case 'terminal:find':
          searchUI?.show?.();
          break;
        case 'terminal:clear':
          terminalManager?.clear?.();
          break;
        case 'terminal:copy':
          {
            const active = document.activeElement;
            if (isEditable(active)) {
              const selected = getSelectionText(active);
              if (selected) {
                await writeClipboard(selected);
                break;
              }
            }
            if (terminalManager?.hasSelection?.()) {
              await writeClipboard(terminalManager.getSelection());
            }
          }
          break;
        case 'terminal:cut':
          {
            const active = document.activeElement;
            if (isEditable(active)) {
              const selected = getSelectionText(active);
              if (!selected) break;
              await writeClipboard(selected);

              const tag = active.tagName ? active.tagName.toLowerCase() : '';
              if (tag === 'input' || tag === 'textarea') {
                const value = typeof active.value === 'string' ? active.value : '';
                const start = Number.isFinite(active.selectionStart) ? active.selectionStart : value.length;
                const end = Number.isFinite(active.selectionEnd) ? active.selectionEnd : start;
                try {
                  active.setRangeText('', start, end, 'start');
                } catch (_) {
                  active.value = value.slice(0, start) + value.slice(end);
                  try { active.setSelectionRange(start, start); } catch (_) { /* noop */ }
                }
                active.dispatchEvent(new Event('input', { bubbles: true }));
                break;
              }
              if (active.isContentEditable) {
                try {
                  document.execCommand('delete');
                } catch (_) { /* noop */ }
                break;
              }
            }
          }
          break;
        case 'terminal:paste': {
          const active = document.activeElement;
          const text = await readClipboard();
          if (isEditable(active)) {
            if (pasteInto(active, text)) {
              break;
            }
          }
          terminalManager?.paste?.(text);
          break;
        }
        case 'terminal:select-all': {
          const active = document.activeElement;
          if (isEditable(active)) {
            const tag = active.tagName ? active.tagName.toLowerCase() : '';
            if (tag === 'input' || tag === 'textarea') {
              try { active.select?.(); } catch (_) { /* noop */ }
              break;
            }
            if (active.isContentEditable) {
              try { document.execCommand('selectAll'); } catch (_) { /* noop */ }
              break;
            }
            break;
          }
          try {
            terminalManager?.terminal?.selectAll?.();
          } catch (_) { /* noop */ }
          break;
        }
        case 'view:search':
          void tabManager?.warmupHistoryWsl?.();
          if (window.leftPaneAPI?.setActivePane) {
            window.leftPaneAPI.setActivePane('search', { toggle: false, focusSelectAll: true });
          }
          break;
        case 'view:active':
          void tabManager?.warmupHistoryWsl?.();
          if (window.leftPaneAPI?.setActivePane) {
            window.leftPaneAPI.setActivePane('active', { toggle: false });
          }
          break;
        case 'view:pins':
          if (window.leftPaneAPI?.setActivePane) {
            window.leftPaneAPI.setActivePane('pins', { toggle: false });
            break;
          }
          if (pinManager?.openPanelWithTab) {
            pinManager.openPanelWithTab('pins');
          } else {
            pinManager?.togglePanel?.();
          }
          break;
        case 'view:history':
          void tabManager?.warmupHistoryWsl?.();
          if (window.leftPaneAPI?.setActivePane) {
            window.leftPaneAPI.setActivePane('history', { toggle: false });
            break;
          }
          if (pinManager?.openPanelWithTab) {
            pinManager.openPanelWithTab('history');
          } else {
            pinManager?.togglePanel?.();
          }
          break;
        case 'view:pin':
          if (pinManager?.pinLastOutput) {
            void pinManager.pinLastOutput();
          }
          break;
        case 'pin:copy-last':
          if (pinManager?.copyLastOutput) {
            void pinManager.copyLastOutput();
          }
          break;
        case 'view:shortcuts':
          shortcutSheet?.toggle?.();
          break;
        default:
          break;
      }
    };
  }

  function initMenuActions({ dispatchAction } = {}) {
    if (!window.menuAPI?.onAction) return;

    window.menuAPI.onAction(async (payload) => {
      const action = payload?.action;
      if (!action) return;
      await dispatchAction?.(action);
    });
  }

  window.ActionDispatcher = {
    createActionDispatcher,
    initMenuActions,
  };
})();
