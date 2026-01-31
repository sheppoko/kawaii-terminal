(function () {
  'use strict';

  function initTerminalShortcuts(options = {}) {
    const {
      getActiveTerminal,
      tabManager,
      dispatchAction,
      shortcutManager,
      debugMenu,
      isEditableTarget,
      getSelectionTextInLeftPane,
      readClipboardText,
      writeClipboardText,
      pasteIntoEditableTarget,
      clampValue,
      isMac,
    } = options;

    const isEditable = typeof isEditableTarget === 'function' ? isEditableTarget : () => false;
    const getLeftPaneSelection = typeof getSelectionTextInLeftPane === 'function' ? getSelectionTextInLeftPane : () => '';
    const readClipboard = typeof readClipboardText === 'function' ? readClipboardText : async () => '';
    const writeClipboard = typeof writeClipboardText === 'function' ? writeClipboardText : async () => false;
    const pasteIntoEditable = typeof pasteIntoEditableTarget === 'function' ? pasteIntoEditableTarget : () => false;
    const clamp = typeof clampValue === 'function'
      ? clampValue
      : (window.KawaiiUtils?.clampNumber || ((value, min, max, fallbackValue) => {
        const num = Number(value);
        if (Number.isNaN(num)) return fallbackValue;
        return Math.min(max, Math.max(min, num));
      }));
    const isMacPlatform = typeof isMac === 'function'
      ? isMac
      : (() => window.windowAPI?.platform === 'darwin');

    const commandMap = new Map((shortcutManager?.commands || []).map(cmd => [cmd.id, cmd]));

    document.addEventListener('keydown', async (e) => {
      if (shortcutManager?.isCapturing?.()) return;
      const match = shortcutManager?.matchEvent?.(e);
      if (!match) return;
      const commandId = match.commandId;
      const binding = match.binding;

      const editable = isEditable(e.target);
      const command = commandMap.get(commandId);

      if (editable && command && !command.allowInEditable) {
        return;
      }

      if (commandId === 'tab:switcher-next') {
        e.preventDefault();
        e.stopPropagation();
        tabManager?.nextTab?.();
        return;
      }

      if (commandId === 'tab:switcher-prev') {
        e.preventDefault();
        e.stopPropagation();
        tabManager?.previousTab?.();
        return;
      }

      if (commandId === 'tab:notified') {
        e.preventDefault();
        e.stopPropagation();
        tabManager?.goToNotifiedTab?.();
        return;
      }

      if (commandId === 'view:toggle-sidebar') {
        e.preventDefault();
        e.stopPropagation();
        window.LeftPane?.toggleSidebar?.();
        return;
      }

      if (commandId.startsWith('pane:focus-')) {
        e.preventDefault();
        e.stopPropagation();
        const direction = commandId.replace('pane:focus-', '');
        if (direction) {
          tabManager?.focusPaneByDirection?.(direction);
        }
        return;
      }

      if (commandId === 'window:new') {
        e.preventDefault();
        e.stopPropagation();
        window.windowAPI?.newWindow?.();
        return;
      }

      if (commandId.startsWith('tab:activate-')) {
        const index = Number.parseInt(commandId.split('-').pop(), 10) - 1;
        const orderedTabIds = tabManager.getOrderedTabIds?.();
        if (orderedTabIds && index >= 0 && index < orderedTabIds.length) {
          e.preventDefault();
          e.stopPropagation();
          tabManager.activateTab(orderedTabIds[index]);
        }
        return;
      }

      if (commandId === 'terminal:copy') {
        const leftPaneSelection = getLeftPaneSelection();
        if (leftPaneSelection) {
          e.preventDefault();
          e.stopPropagation();
          await writeClipboard(leftPaneSelection);
          return;
        }
        const terminalManager = getActiveTerminal?.();
        if (!terminalManager) return;
        const parsed = window.Shortcuts?.parseShortcutString?.(binding);
        const isPlainCtrlC = parsed
          && parsed.key === 'C'
          && parsed.mods.Ctrl
          && !parsed.mods.Cmd
          && !parsed.mods.Alt
          && !parsed.mods.Shift;
        if (isPlainCtrlC && !terminalManager.hasSelection()) {
          return;
        }
        if (terminalManager.hasSelection()) {
          e.preventDefault();
          e.stopPropagation();
          await writeClipboard(terminalManager.getSelection());
        }
        return;
      }

      if (commandId === 'terminal:paste') {
        e.preventDefault();
        e.stopPropagation();
        const text = await readClipboard();
        const active = document.activeElement;
        if (isEditable(active)) {
          if (pasteIntoEditable(active, text)) {
            return;
          }
        }
        const terminalManager = getActiveTerminal?.();
        if (text && terminalManager) {
          const useRaw = e.shiftKey || terminalManager.isAlternateBufferActive?.();
          if (useRaw && terminalManager.rawPaste) {
            await terminalManager.rawPaste(text);
          } else {
            terminalManager.paste(text);
          }
        }
        return;
      }

      if (commandId === 'terminal:font-increase' || commandId === 'terminal:font-decrease' || commandId === 'terminal:font-reset') {
        const terminalManager = getActiveTerminal?.();
        if (!terminalManager) return;
        e.preventDefault();
        const currentSize = terminalManager.getSettings().fontSize;
        if (commandId === 'terminal:font-increase') {
          const nextSize = clamp(currentSize + 1, 10, 32, currentSize);
          tabManager.updateSettingsAll({ fontSize: nextSize });
        } else if (commandId === 'terminal:font-decrease') {
          const nextSize = clamp(currentSize - 1, 10, 32, currentSize);
          tabManager.updateSettingsAll({ fontSize: nextSize });
        } else {
          const defaultSize = window.TerminalSettings?.defaults?.fontSize ?? 14;
          tabManager.updateSettingsAll({ fontSize: defaultSize });
        }
        return;
      }

      if (commandId === 'debug:menu') {
        e.preventDefault();
        e.stopPropagation();
        debugMenu?.toggle?.();
        return;
      }

      if (commandId === 'window:toggle-devtools') {
        e.preventDefault();
        e.stopPropagation();
        window.windowAPI?.toggleDevTools?.();
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      await dispatchAction?.(commandId);
    }, true);

    // Ctrl + スクロールでフォントサイズ変更（ブラウザズームは無効化）
    document.addEventListener('wheel', (e) => {
      const mac = isMacPlatform();
      if (!mac && e.ctrlKey) {
        if (isEditable(e.target)) return;
        e.preventDefault();

        const terminalManager = getActiveTerminal?.();
        if (!terminalManager) return;

        const currentSize = terminalManager.getSettings().fontSize;
        const delta = e.deltaY < 0 ? 1 : -1; // スクロールアップで拡大、ダウンで縮小
        const nextSize = clamp(currentSize + delta, 10, 32, currentSize);
        if (nextSize !== currentSize) {
          tabManager.updateSettingsAll({ fontSize: nextSize });
        }
      }
    }, { capture: true, passive: false });
  }

  window.TerminalShortcuts = {
    initTerminalShortcuts,
  };
})();
