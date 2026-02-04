/* global CheerManager, AvatarManager */
(function () {
  'use strict';

  const WINDOW_ID = (() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('windowId') || 'win';
    } catch (_) {
      return 'win';
    }
  })();
  const SHOULD_WAIT_FOR_ADOPT = (() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('adopt') === '1';
    } catch (_) {
      return false;
    }
  })();
  const SESSION_WINDOW_KEY = (() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('sessionKey') || null;
    } catch (_) {
      return null;
    }
  })();
  const SHOULD_RESTORE_SESSION = (() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('restore') === '1';
    } catch (_) {
      return false;
    }
  })();
  const SHOULD_PROMPT_RECOVERY = (() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('recovery') === '1';
    } catch (_) {
      return false;
    }
  })();
  const STARTUP_CWD = (() => {
    const raw = typeof window.windowAPI?.startupCwd === 'string' ? window.windowAPI.startupCwd.trim() : '';
    return raw || '';
  })();
  const TERMINAL_LOADING_DELAY_MS = 500;
  const RESTORE_PREFILL_ENABLED = false;

  window.TabTransfer?.init?.({ windowId: WINDOW_ID });

  const clampValue = window.KawaiiUtils?.clampNumber
    || ((value, min, max, fallbackValue) => {
      const num = Number(value);
      if (Number.isNaN(num)) return fallbackValue;
      return Math.min(max, Math.max(min, num));
    });

  let settingsCache = null;
  let settingsPromise = null;
  const getAppSettings = async () => {
    if (settingsCache) return settingsCache;
    if (!settingsPromise) {
      if (!window.settingsAPI?.get) {
        return null;
      }
      settingsPromise = window.settingsAPI.get().catch(() => null);
    }
    settingsCache = await settingsPromise;
    return settingsCache;
  };

  async function loadInitialTerminalSettings(settings) {
    const defaults = window.TerminalSettings?.defaults || { fontSize: 14, scrollback: 5000, webglEnabled: true };
    const normalize = window.TerminalSettings?.normalize;
    if (!normalize) return defaults;
    return normalize(settings?.terminal);
  }

  const isMac = () => window.windowAPI?.platform === 'darwin';

  function quoteShellValue(value) {
    const raw = String(value || '');
    if (!raw) return "''";
    if (/^[A-Za-z0-9._-]+$/.test(raw)) return raw;
    if (window.windowAPI?.platform === 'win32') {
      return `"${raw.replace(/"/g, '""')}"`;
    }
    return `'${raw.replace(/'/g, `'\\''`)}'`;
  }

  function extractWslDistroFromPath(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const normalized = raw.replace(/\//g, '\\');
    const match = normalized.match(/^\\\\wsl(?:\\.localhost)?(?:\\$)?\\\\([^\\]+)(?:\\\\|$)/i);
    if (!match) return '';
    return String(match[1] || '').trim();
  }

  function inferWslDistroFromBlock(block) {
    if (!block || typeof block !== 'object') return '';
    const direct = typeof block.wsl_distro === 'string' ? block.wsl_distro.trim() : '';
    if (direct) return direct;
    const sourcePath = typeof block.source_path === 'string' ? block.source_path.trim() : '';
    const paneId = typeof block.pane_id === 'string' ? block.pane_id.trim() : '';
    return extractWslDistroFromPath(sourcePath) || extractWslDistroFromPath(paneId) || '';
  }

  function buildResumeCommand(item) {
    if (!item || typeof item !== 'object') return '';
    const sessionId = String(item.sessionId || '').trim();
    const source = String(item.source || '').trim().toLowerCase();
    if (!sessionId || !source) return '';
    if (sessionId.toLowerCase() === source) return '';
    const sessionArg = quoteShellValue(sessionId);
    if (source === 'claude') return `claude --resume ${sessionArg}`;
    if (source === 'codex') return `codex resume ${sessionArg}`;
    return '';
  }

  const prefersReducedMotion = () => {
    try {
      return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
    } catch (_) {
      return false;
    }
  };

  const escapeSelector = (value) => {
    const raw = String(value || '');
    if (window.CSS?.escape) return window.CSS.escape(raw);
    return raw.replace(/["\\]/g, '\\$&');
  };

  const findTabElById = (tabId) => {
    if (!tabId) return document.querySelector('.terminal-tab.active');
    const safeId = escapeSelector(tabId);
    return document.querySelector(`.terminal-tab[data-tab-id="${safeId}"]`);
  };

  const findPaneElById = (paneId) => {
    if (!paneId) return document.querySelector('.terminal-pane.active');
    const safeId = escapeSelector(paneId);
    return document.querySelector(`.terminal-pane[data-pane-id="${safeId}"]`);
  };

  const waitForTabEl = (tabId, timeoutMs = 900) => new Promise((resolve) => {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const tick = () => {
      const el = findTabElById(tabId);
      if (el) return resolve(el);
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if ((now - start) >= timeoutMs) return resolve(null);
      requestAnimationFrame(tick);
    };
    tick();
  });

  const waitForPaneEl = (paneId, timeoutMs = 900) => new Promise((resolve) => {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const tick = () => {
      const el = findPaneElById(paneId);
      if (el) return resolve(el);
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if ((now - start) >= timeoutMs) return resolve(null);
      requestAnimationFrame(tick);
    };
    tick();
  });

  const triggerTabArrival = (tabEl, delayMs = 0) => {
    if (!tabEl) return;
    const run = () => {
      tabEl.classList.remove('is-resume-blink');
      void tabEl.offsetWidth;
      tabEl.classList.add('is-resume-blink');
      setTimeout(() => tabEl.classList.remove('is-resume-blink'), 700);
    };
    if (delayMs > 0) {
      setTimeout(run, delayMs);
    } else {
      run();
    }
  };

  const triggerPaneArrival = (paneEl, delayMs = 0) => {
    if (!paneEl) return;
    const run = () => {
      paneEl.classList.remove('is-ghost-arrive');
      void paneEl.offsetWidth;
      paneEl.classList.add('is-ghost-arrive');
      setTimeout(() => paneEl.classList.remove('is-ghost-arrive'), 620);
    };
    if (delayMs > 0) {
      setTimeout(run, delayMs);
    } else {
      run();
    }
  };

  const animateHistoryFlight = async ({ tabId, tabEl, paneId, paneEl, paneArrival = true } = {}) => {
    const targetTabEl = tabEl || findTabElById(tabId);
    const targetPaneEl = paneEl || findPaneElById(paneId) || document.querySelector('.terminal-pane.active');
    const targetEl = targetTabEl || targetPaneEl;
    if (!targetEl) return;
    if (prefersReducedMotion()) return;
    if (targetTabEl) triggerTabArrival(targetTabEl, 0);
    if (paneArrival && targetPaneEl) triggerPaneArrival(targetPaneEl, 80);
  };

  const activateActiveAgentsPane = () => {
    window.leftPaneAPI?.setActivePane?.('active', { toggle: false });
  };

  async function checkMissingCwd(cwd, wslDistro) {
    const trimmed = typeof cwd === 'string' ? cwd.trim() : '';
    if (!trimmed) return false;
    if (!window.historyAPI?.checkCwd) return;
    try {
      const result = await window.historyAPI.checkCwd({ cwd: trimmed, wslDistro: wslDistro || '' });
      return Boolean(result?.checked && result?.exists === false);
    } catch (error) {
      console.warn('[History] cwd check failed:', error);
    }
    return false;
  }

  function showMissingCwdWarning({ historyManager, tabManager, tabId } = {}) {
    const message = 'Cannot find the working directory. It may have been deleted or moved.\nBehavior may be unexpected.';
    if (tabManager?.showTabPaneToast?.(tabId, message, { tone: 'error', persistent: true })) {
      return;
    }
    if (tabManager?.showActivePaneToast?.(message, { tone: 'error', persistent: true })) {
      return;
    }
    historyManager?.showHistoryToast?.(message, { tone: 'error' });
  }

  // === Session Recovery Modal ===
  const RecoveryModal = (() => {
    let cleanupListener = null;

    function show({ windows = 0, tabs = 0, panes = 0 } = {}) {
      const overlay = document.getElementById('recovery-modal-overlay');
      if (!overlay) return Promise.resolve('new-session');

      document.getElementById('recovery-windows').textContent = windows;
      document.getElementById('recovery-tabs').textContent = tabs;
      document.getElementById('recovery-panes').textContent = panes;

      return new Promise((resolve) => {
        const handleChoice = (choice) => {
          overlay.classList.add('fade-out');
          setTimeout(() => {
            overlay.classList.remove('visible', 'fade-out');
            resolve(choice);
          }, 150);
        };

        document.getElementById('recovery-restore-all').onclick = () => handleChoice('restore-all');
        document.getElementById('recovery-restore-last').onclick = () => handleChoice('restore-last-window');
        document.getElementById('recovery-start-fresh').onclick = () => handleChoice('new-session');

        overlay.classList.add('visible');
      });
    }

    function init() {
      if (cleanupListener) return;
      cleanupListener = window.sessionAPI?.onShowRecoveryModal?.(async (payload) => {
        const choice = await show(payload);
        resolveChoice(choice);
        window.sessionAPI?.sendRecoveryChoice?.(choice);
      });
    }

    let pendingChoicePromise = null;
    let pendingChoiceResolve = null;
    let cachedChoice = null;

    function ensureChoicePromise() {
      if (!pendingChoicePromise) {
        pendingChoicePromise = new Promise((resolve) => {
          pendingChoiceResolve = resolve;
        });
      }
      return pendingChoicePromise;
    }

    function resolveChoice(choice) {
      if (!pendingChoiceResolve) {
        cachedChoice = choice;
        return;
      }
      const resolve = pendingChoiceResolve;
      pendingChoiceResolve = null;
      pendingChoicePromise = null;
      resolve(choice);
    }

    function waitForChoice() {
      if (cachedChoice !== null) {
        const choice = cachedChoice;
        cachedChoice = null;
        return Promise.resolve(choice);
      }
      return ensureChoicePromise();
    }

    return { show, init, waitForChoice };
  })();

  function showCheerMessage(message) {
    const messageEl = document.getElementById('cheer-bubble');
    const popupBubble = document.getElementById('avatar-popup-bubble');
    if (!messageEl) return;

    messageEl.classList.remove('show');
    messageEl.textContent = message;

    if (popupBubble) {
      popupBubble.textContent = message;
    }

    requestAnimationFrame(() => {
      messageEl.classList.add('show');
    });
  }

  function initAvatarPopup() {
    const avatarEl = document.getElementById('status-bar-avatar');
    const popup = document.getElementById('avatar-popup');
    const popupImage = document.getElementById('avatar-popup-image');
    const mainImage = document.getElementById('avatar-image');

    if (!avatarEl || !popup) return;

    if (mainImage && popupImage) {
      const observer = new MutationObserver(() => {
        popupImage.src = mainImage.src;
      });
      observer.observe(mainImage, { attributes: true, attributeFilter: ['src'] });
    }

    avatarEl.addEventListener('mouseenter', () => {
      popup.classList.add('show');
    });

    avatarEl.addEventListener('mouseleave', () => {
      popup.classList.remove('show');
    });

    popup.addEventListener('mouseenter', () => {
      popup.classList.add('show');
    });

    popup.addEventListener('mouseleave', () => {
      popup.classList.remove('show');
    });
  }

  function logStartup(_label, _detail) {}

  const initApp = async () => {
    try {
      logStartup('DOMContentLoaded');

      window.LeftPane?.applyStoredSettings?.();

      window.WindowUI?.initTitlebarStyle?.();
      window.WindowUI?.initWindowResizeHandles?.();

      window.LeftPane?.setupSessionSidebar?.();
      window.LeftPane?.setupSessionSidebarResizer?.();
      window.LeftPane?.setupSessionSidebarFocus?.();
      window.LeftPane?.setupLeftActivityBar?.();

      document.getElementById('btn-minimize').addEventListener('click', () => window.windowAPI.minimize());
      document.getElementById('btn-maximize').addEventListener('click', () => window.windowAPI.maximize());
      document.getElementById('btn-close').addEventListener('click', () => window.windowAPI.close());

      RecoveryModal.init();

      if (SHOULD_PROMPT_RECOVERY) {
        const choice = await RecoveryModal.waitForChoice();
        if (choice !== 'new-session') {
          return;
        }
      }

      const appSettings = await getAppSettings();
      const initialTerminalSettings = await loadInitialTerminalSettings(appSettings);
      const shortcutManager = window.Shortcuts?.createShortcutManager?.({ settings: appSettings }) || null;

      const cheerManager = new CheerManager(showCheerMessage);
      let tabManager = null;

      const historyManager = new window.HistoryManager({
        sessionId: SESSION_WINDOW_KEY || WINDOW_ID,
        deferInitialLoad: true,
      });
      window.historyManager = historyManager;
      const historyClient = window.HistoryClient ? new window.HistoryClient() : null;
      if (historyClient) {
        historyClient.init();
        window.historyClient = historyClient;
        historyManager?.setHistoryProvider?.(historyClient);
        historyClient.setUpdateListener((event) => {
          if (!event) return;
          if (event.type === 'delta') {
            historyManager?.handleHistoryDelta?.(event.payload);
          } else if (event.type === 'invalidate') {
            historyManager?.handleHistoryInvalidate?.(event.payload);
          }
        });
      }
      window.WindowUI?.initStatusDebugPanel?.(historyManager);
      const statusClient = window.StatusClient ? new window.StatusClient() : null;
      if (statusClient) {
        await statusClient.init();
        window.statusClient = statusClient;
        const summaryManager = window.SummaryManager
          ? new window.SummaryManager({ historyManager, statusClient })
          : null;
        if (summaryManager) {
          summaryManager.init();
          window.summaryManager = summaryManager;
          historyManager?.setSummaryProvider?.(summaryManager);
          historyManager?.setSessionDeltaListener?.((payload) => summaryManager.handleHistoryDelta(payload));
        }
        statusClient.setUpdateListener((payload) => {
          const entries = Array.isArray(payload?.entries) ? payload.entries : [];
          const removed = Array.isArray(payload?.removed) ? payload.removed : [];
          if (entries.length || removed.length) {
            historyManager.sidebarDirty = true;
            historyManager.scheduleRender();
            tabManager?.syncTabStatusIndicators?.();
          }
          summaryManager?.handleStatusUpdate?.(payload);
        });
        historyManager?.setStatusProvider?.(statusClient);
      }

      const pinManager = new window.PinManager({ historyManager });
      window.pinManager = pinManager;
      const leftPane = document.getElementById('left-pane');
      const activePane =
        window.leftPaneAPI?.getActivePane?.() || window.LeftPane?.getStoredActivePane?.() || 'active';
      const isHidden = leftPane?.getAttribute('aria-hidden') === 'true';
      if (!isHidden) {
        if (activePane === 'pins') {
          pinManager.renderPins?.();
        } else {
          historyManager.sidebarDirty = true;
          historyManager.scheduleRender();
        }
      }
      const imagePreviewManager = new window.ImagePreviewManager();
      const mdPreviewManager = new window.MdPreviewManager();

      let snapshotConfig = null;
      try {
        snapshotConfig = await window.sessionAPI?.getSnapshotConfig?.();
      } catch (_) {
        snapshotConfig = null;
      }
      logStartup('snapshotConfig loaded');

      let initialSession = null;
      if (SHOULD_RESTORE_SESSION && SESSION_WINDOW_KEY && window.sessionAPI?.getRestoreWindow) {
        try {
          initialSession = await window.sessionAPI.getRestoreWindow(SESSION_WINDOW_KEY);
        } catch (_) {
          initialSession = null;
        }
      }
      logStartup('initialSession loaded', { restore: SHOULD_RESTORE_SESSION, hasSession: Boolean(initialSession) });

      let historyBootstrapStarted = false;
      const startHistoryBootstrap = () => {
        if (historyBootstrapStarted) return;
        historyBootstrapStarted = true;
        const load = () => historyManager?.loadSessionSummaries?.();
        if (typeof window.requestIdleCallback === 'function') {
          window.requestIdleCallback(() => load(), { timeout: 1500 });
        } else {
          setTimeout(load, 300);
        }
      };

      let resizeFocusHandler = null;
      const onResizeFocus = () => resizeFocusHandler?.();

      logStartup('initTerminalTabs:start');
      tabManager = await window.TerminalTabs?.initTerminalTabs?.(
        cheerManager,
        pinManager,
        historyManager,
        imagePreviewManager,
        mdPreviewManager,
        {
          initialSession,
          restoreSession: SHOULD_RESTORE_SESSION,
          startupCwd: STARTUP_CWD,
          deferPtyStart: true,
          initialTerminalSettings,
          shortcutManager,
          windowId: WINDOW_ID,
          waitForAdopt: SHOULD_WAIT_FOR_ADOPT,
          loadingDelayMs: TERMINAL_LOADING_DELAY_MS,
          restorePrefillEnabled: RESTORE_PREFILL_ENABLED,
          onHistoryBootstrap: startHistoryBootstrap,
          onResizeFocus,
        }
      );
      logStartup('initTerminalTabs:done');
      if (!tabManager) return;

      window.TabTransfer?.setTabManager?.(tabManager);
      historyManager?.setStatusChangeListener?.(() => tabManager?.syncTabStatusIndicators?.());
      tabManager?.syncTabStatusIndicators?.();

      const pruneStaleStatusBindings = () => {
        const entries = historyManager?.statusProvider?.entries;
        if (!entries || typeof entries.forEach !== 'function') return;
        const paneEls = document.querySelectorAll('.terminal-pane[data-pane-id]');
        const livePaneIds = new Set();
        const localPanePrefix = `pane-tab-${WINDOW_ID}-`;
        paneEls.forEach((el) => {
          const pid = el?.dataset?.paneId;
          if (pid) livePaneIds.add(pid);
        });
        entries.forEach((entry) => {
          const paneId = String(entry?.pane_id || '').trim();
          if (!paneId) return;
          if (localPanePrefix && !paneId.startsWith(localPanePrefix)) return;
          if (livePaneIds.has(paneId)) return;
          window.statusAPI?.sendPaneEvent?.({
            pane_id: paneId,
            event: 'close',
            timestamp: Date.now(),
          });
        });
      };

      setTimeout(pruneStaleStatusBindings, 120);

      const getActiveTerminal = () => tabManager.getActiveTerminal();
      let resizeFocusTimer = null;
      const focusActiveTerminalSafely = (delayMs = 0) => {
        const run = () => {
          if (document.hidden) return;
          const terminal = getActiveTerminal?.();
          if (!terminal) return;
          const activeEl = document.activeElement;
          if (activeEl) {
            if (activeEl.classList?.contains('xterm-helper-textarea')) return;
            if (activeEl.isContentEditable) return;
            if (activeEl.tagName) {
              const tag = activeEl.tagName.toLowerCase();
              if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
            }
            if (activeEl.closest && !activeEl.closest('.terminal-panel')) return;
          }
          terminal.focus?.();
        };
        if (delayMs > 0) {
          if (resizeFocusTimer) clearTimeout(resizeFocusTimer);
          resizeFocusTimer = setTimeout(run, delayMs);
        } else {
          run();
        }
      };
      resizeFocusHandler = () => focusActiveTerminalSafely(80);
      window.LeftPane?.setResizeFocusHandler?.(resizeFocusHandler);
      window.WindowUI?.setResizeFocusHandler?.(resizeFocusHandler);

      shortcutManager.onChange(() => {
        tabManager.updateTabShortcuts?.();
      });

      startHistoryBootstrap();

      let timeMachineBusy = false;
      historyManager?.setTimeMachineHandler?.(async (block, _options = {}) => {
        if (timeMachineBusy) return;
        if (!window.historyAPI?.timeMachine) {
          historyManager?.showHistoryToast?.('Time Machine unavailable', { tone: 'error' });
          return;
        }
        timeMachineBusy = true;
        const fallbackProfileId = tabManager.getActiveTerminal()?.profileId || null;
        try {
          const result = await window.historyAPI.timeMachine({ block });
          if (!result?.success || !result?.command) {
            console.warn('[TimeMachine] Failed:', result?.error || 'unknown');
            historyManager?.showHistoryToast?.('Time Machine failed', { tone: 'error' });
            return;
          }
          const title = 'Time Machine';
          const cwdRaw = typeof block?.cwd === 'string' ? block.cwd.trim() : '';
          const startCwd = cwdRaw
            || (String(block?.source || '').toLowerCase() === 'codex'
              ? (typeof block?.pane_id === 'string' ? block.pane_id.trim() : '')
              : '');
          const inferredDistro = inferWslDistroFromBlock(block);
          const missingCwd = await checkMissingCwd(startCwd, inferredDistro);
          const launchResult = await tabManager.launchCommandInNewTab({
            title,
            command: result.command,
            cwd: startCwd,
            wslDistro: inferredDistro,
            fallbackProfileId,
          });
          if (missingCwd) {
            showMissingCwdWarning({ historyManager, tabManager, tabId: launchResult?.tabId });
          }
          if (launchResult?.success && launchResult?.tabId) {
            const tabEl = await waitForTabEl(launchResult.tabId);
            const paneEl = await waitForPaneEl(launchResult.paneId, 900);
            await animateHistoryFlight({
              tabId: launchResult.tabId,
              tabEl,
              paneId: launchResult.paneId,
              paneEl,
            });
            activateActiveAgentsPane();
          }
          if (!launchResult?.success) {
            if (window.clipboardAPI?.writeText) {
              window.clipboardAPI.writeText(result.command);
            } else if (navigator?.clipboard?.writeText) {
              await navigator.clipboard.writeText(result.command);
            }
          }
        } catch (e) {
          console.error('[TimeMachine] Failed to start:', e);
          historyManager?.showHistoryToast?.('Time Machine failed', { tone: 'error' });
        } finally {
          timeMachineBusy = false;
        }
      });

      historyManager?.setResumeHandler?.(async ({ sessionId, source, cwd, wslDistro }) => {
        if (!sessionId || !source) {
          return;
        }
        try {
          const bound = historyManager?.getSessionStatus?.({ sessionId, source }) || null;
          const boundPaneId = bound?.pane_id || '';
          const activeTab = tabManager?.getActiveTab?.();
          const isActiveBound = Boolean(boundPaneId && activeTab?.panes?.has?.(boundPaneId));
          if (boundPaneId && tabManager.activatePaneById?.(boundPaneId)) {
            const targetEl = document.querySelector('.terminal-tab.active');
            const paneEl = await waitForPaneEl(boundPaneId, 600);
            await animateHistoryFlight({
              tabEl: targetEl,
              paneId: boundPaneId,
              paneEl,
              paneArrival: false,
            });
            activateActiveAgentsPane();
            if (isActiveBound) {
              tabManager?.blinkActiveTab?.();
            }
            return;
          }
          const item = { sessionId, source, cwd, wslDistro };
          const command = buildResumeCommand(item);
          if (!command) {
            return;
          }
          const fallbackProfileId = tabManager.getActiveTerminal()?.profileId || null;
          const missingCwd = await checkMissingCwd(cwd, wslDistro);
          const launchResult = await tabManager.launchCommandInNewTab({
            title: 'Resume Session',
            command,
            cwd,
            wslDistro,
            fallbackProfileId,
          });
          if (missingCwd) {
            showMissingCwdWarning({ historyManager, tabManager, tabId: launchResult?.tabId });
          }
          if (launchResult?.success && launchResult?.tabId) {
            const tabEl = await waitForTabEl(launchResult.tabId);
            const paneEl = await waitForPaneEl(launchResult.paneId, 900);
            await animateHistoryFlight({
              tabId: launchResult.tabId,
              tabEl,
              paneId: launchResult.paneId,
              paneEl,
            });
            activateActiveAgentsPane();
          }
          if (!launchResult?.success) {
            console.error('[Resume] Failed:', launchResult?.reason || 'unknown');
          }
        } catch (e) {
          console.error('[Resume] Failed:', e);
        }
      });

      historyManager?.setForkHandler?.(async ({ sessionId, source, cwd, wslDistro }) => {
        if (!sessionId || !source) {
          historyManager?.showHistoryToast?.('Fork unavailable');
          return;
        }
        try {
          const item = { sessionId, source, cwd, wslDistro };
          const command = buildResumeCommand(item);
          if (!command) {
            historyManager?.showHistoryToast?.('Fork unavailable');
            return;
          }
          const fallbackProfileId = tabManager.getActiveTerminal()?.profileId || null;
          const launchResult = await tabManager.launchCommandInNewTab({
            command,
            cwd,
            wslDistro,
            fallbackProfileId,
          });
          if (launchResult?.success) {
            if (launchResult?.tabId) {
              const tabEl = await waitForTabEl(launchResult.tabId);
              const paneEl = await waitForPaneEl(launchResult.paneId, 900);
              await animateHistoryFlight({
                tabId: launchResult.tabId,
                tabEl,
                paneId: launchResult.paneId,
                paneEl,
              });
            }
            activateActiveAgentsPane();
            historyManager?.showHistoryToast?.('Forking session...');
          } else {
            historyManager?.showHistoryToast?.('Fork failed');
          }
        } catch (e) {
          console.error('[Fork] Failed:', e);
          historyManager?.showHistoryToast?.('Fork failed');
        }
      });

      window.SessionPersistence?.startSessionPersistence?.({
        tabManager,
        windowKey: SESSION_WINDOW_KEY,
        snapshotConfig,
      });

      window.addEventListener('resize', () => {
        getActiveTerminal()?.handleResize();
        focusActiveTerminalSafely(120);
      });

      requestAnimationFrame(() => {
        document.getElementById('main-container')?.classList.add('ready');
      });

      setTimeout(() => {
        const debugMenu = window.WindowUI?.initDebugMenu?.();

        let dispatchAction = null;
        const shortcutSheet = window.SettingsUI?.initShortcutSheet?.(() => dispatchAction, shortcutManager);

        const avatarManager = new AvatarManager('avatar-image');
        avatarManager.initialize();
        initAvatarPopup();

        // CheerManagerにAvatarManagerを設定（イルカ語変換とアバター切り替えの連携）
        cheerManager.setAvatarManager(avatarManager);

        window.SettingsUI?.initCheerUI?.(cheerManager);
        window.SettingsUI?.initAutoConfigUI?.();
        window.SettingsUI?.initSummarySettingsUI?.();
        window.OnboardingUI?.initOnboarding?.();

        const searchUI = window.TerminalUI?.initTerminalSearchUI?.(getActiveTerminal);
        const inputUtils = window.InputUtils || {};
        const readClipboardText = window.ClipboardUtils?.readText || (async () => '');
        const writeClipboardText = window.ClipboardUtils?.writeText || (async () => false);
        dispatchAction = window.ActionDispatcher?.createActionDispatcher?.({
          getActiveTerminal,
          searchUI,
          tabManager,
          pinManager,
          getShortcutSheet: () => shortcutSheet,
          isEditableTarget: inputUtils.isEditableTarget || (() => false),
          getEditableSelectionText: inputUtils.getEditableSelectionText || (() => ''),
          pasteIntoEditableTarget: inputUtils.pasteIntoEditableTarget || (() => false),
          readClipboardText,
          writeClipboardText,
        });
        window.ActionDispatcher?.initMenuActions?.({ dispatchAction });
        window.TerminalShortcuts?.initTerminalShortcuts?.({
          getActiveTerminal,
          searchUI,
          tabManager,
          dispatchAction,
          shortcutManager,
          debugMenu,
          isEditableTarget: inputUtils.isEditableTarget || (() => false),
          getSelectionTextInLeftPane: inputUtils.getSelectionTextInLeftPane || (() => ''),
          readClipboardText,
          writeClipboardText,
          pasteIntoEditableTarget: inputUtils.pasteIntoEditableTarget || (() => false),
          clampValue,
          isMac,
        });
        window.TerminalUI?.initTerminalContextMenu?.(getActiveTerminal, searchUI, tabManager, shortcutManager);
        window.TerminalUI?.initTerminalHealthIndicator?.(getActiveTerminal, debugMenu);
        window.TerminalDnD?.initTerminalDragAndDrop?.(getActiveTerminal);
        window.SettingsUI?.initTerminalSettingsUI?.(tabManager, pinManager);
        window.SettingsUI?.initThemeSettingsUI?.();
        window.LeftPane?.initFontScaleUI?.();
        window.LeftPane?.initSmoothScrollUI?.();
        window.SettingsUI?.initSettingsWheelInputs?.();
        window.SettingsUI?.initShortcutSettingsUI?.(shortcutManager);
      }, 0);
    } catch (error) {
      console.error('Initialization error:', error);
    }
  };

  const init = () => {
    if (init.started) return;
    init.started = true;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initApp);
    } else {
      initApp();
    }
  };

  window.AppBootstrap = {
    init,
  };
})();
