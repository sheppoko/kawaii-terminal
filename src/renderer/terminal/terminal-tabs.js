/* global TerminalManager */
(function () {
  'use strict';

const TAB_DRAG_SNAPSHOT_MAX = 20000;
const USE_NATIVE_GHOST_WINDOW = true;
const DRAG_START_DISTANCE = 4;
const TAB_REORDER_VERTICAL_THRESHOLD = 20;
const TAB_REORDER_OVERLAP_RATIO = 0.3;
const TAB_REORDER_MIN_OVERLAP_PX = 8;
const TAB_REORDER_HYSTERESIS_PX = 6;
const TAB_AUTOSCROLL_MIN_OVERFLOW = 48;
const TAB_ATTACH_VERTICAL_THRESHOLD = 24;
const TAB_DETACH_VERTICAL_THRESHOLD = 52;
const TAB_DETACH_HORIZONTAL_THRESHOLD = 60;
const TAB_DETACH_HORIZONTAL_HYSTERESIS = 12;
const MAX_PANES = 4;
const MIN_PANE_WIDTH = 220;
const MIN_PANE_HEIGHT = 140;
const PANE_DRAG_START_DISTANCE = 6;
const TERMINAL_TOAST_DURATION_MS = 3000;

function getTerminalLoadingLabel(profileId) {
  const platform = window.windowAPI?.platform;
  const rawProfile = typeof profileId === 'string' ? profileId.trim().toLowerCase() : '';
  if (platform === 'win32') {
    if (rawProfile.startsWith('wsl:')) return 'Loading WSL...';
    return 'Loading PowerShell...';
  }
  return 'Loading shell...';
}

function isWslProfile(profileId) {
  return typeof profileId === 'string' && profileId.trim().toLowerCase().startsWith('wsl:');
}

function quoteShellValue(value) {
  const raw = String(value || '');
  if (!raw) return "''";
  if (/^[A-Za-z0-9._-]+$/.test(raw)) return raw;
  if (window.windowAPI?.platform === 'win32') {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return `'${raw.replace(/'/g, `'\\''`)}'`;
}

function resolveWslProfileId({ wslDistro, cwd } = {}) {
  const distro = typeof wslDistro === 'string' ? wslDistro.trim() : '';
  if (distro) return `wsl:${distro}`;
  const isWindows = window.windowAPI?.platform === 'win32';
  const cwdRaw = typeof cwd === 'string' ? cwd.trim() : '';
  if (isWindows && cwdRaw.startsWith('/')) {
    return 'wsl:default';
  }
  return null;
}

function looksLikeWindowsPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (/^[A-Za-z]:[\\/]/.test(raw)) return true;
  if (raw.startsWith('\\\\')) return true;
  return false;
}

function resolveSessionProfileId({ wslDistro, cwd, fallbackProfileId } = {}) {
  const inferred = resolveWslProfileId({ wslDistro, cwd });
  if (inferred) return inferred;
  const fallback = typeof fallbackProfileId === 'string' ? fallbackProfileId.trim() : '';
  if (looksLikeWindowsPath(cwd) && isWslProfile(fallback)) {
    return null;
  }
  return fallback || null;
}


function getTabProfileId(tab) {
  if (!tab) return null;
  const activePane = tab.activePaneId ? tab.panes.get(tab.activePaneId) : null;
  const fromActive = activePane?.profileId || activePane?.terminalManager?.profileId || null;
  if (fromActive) return fromActive;
  for (const pane of tab.panes.values()) {
    const candidate = pane?.profileId || pane?.terminalManager?.profileId || null;
    if (candidate) return candidate;
  }
  return null;
}

function updateTabWslIndicator(tab) {
  if (!tab?.tabEl || !tab?.wslBadgeEl) return;
  const profileId = getTabProfileId(tab);
  const isWsl = isWslProfile(profileId);
  tab.tabEl.classList.toggle('wsl', isWsl);
  tab.wslBadgeEl.setAttribute('aria-hidden', isWsl ? 'false' : 'true');
}

async function initTerminalTabs(cheerManager, pinManager, historyManager, imagePreviewManager, mdPreviewManager, options = {}) {
  const tabsBar = document.getElementById('terminal-tabs');
    const addBtn = document.getElementById('terminal-tab-add');
    const actionsEl = document.getElementById('terminal-tabs-actions');
    const stack = document.getElementById('terminal-stack');
    const tabMenu = document.getElementById('terminal-tab-menu');
    const profileBtn = document.getElementById('terminal-tab-add-menu');
    const profileMenu = document.getElementById('terminal-profile-menu');
    const scrollLeftBtn = document.getElementById('tab-scroll-left');
    const scrollRightBtn = document.getElementById('tab-scroll-right');

  if (!tabsBar || !addBtn || !actionsEl || !stack) {
    throw new Error('Terminal tab elements not found');
  }

  const windowId = typeof options?.windowId === 'string' && options.windowId.trim()
    ? options.windowId.trim()
    : 'win';
  const isWindows = window.windowAPI?.platform === 'win32';
  const waitForAdopt = Boolean(options?.waitForAdopt);
  const loadingDelayMs = Number.isFinite(options?.loadingDelayMs) ? options.loadingDelayMs : 500;
  const restorePrefillEnabled = Boolean(options?.restorePrefillEnabled);
  const onHistoryBootstrap = typeof options?.onHistoryBootstrap === 'function' ? options.onHistoryBootstrap : null;
  const resizeFocusHandler = typeof options?.onResizeFocus === 'function' ? options.onResizeFocus : null;
  let tabManager = null;

  const shortcutManager = options?.shortcutManager || null;

  // === Chrome風タブスクロール機能 ===
  const TAB_NARROW_THRESHOLD = 80; // この幅以下でnarrowクラス付与
  const TAB_SHORTCUT_HIDE_THRESHOLD = 128; // この幅以下でショートカット非表示
  const TAB_SCROLL_AMOUNT = 150;

  const updateTabScrollButtons = () => {
    if (!scrollLeftBtn || !scrollRightBtn) return;
    const { scrollLeft, scrollWidth, clientWidth } = tabsBar;
    const canScrollLeft = scrollLeft > 0;
    const canScrollRight = scrollLeft + clientWidth < scrollWidth - 1;
    scrollLeftBtn.classList.toggle('visible', canScrollLeft);
    scrollRightBtn.classList.toggle('visible', canScrollRight);
  };

  const updateTabNarrowClass = () => {
    tabsBar.querySelectorAll('.terminal-tab').forEach(tabEl => {
      const width = tabEl.offsetWidth;
      const isNarrow = width <= TAB_NARROW_THRESHOLD;
      const isCompact = width <= TAB_SHORTCUT_HIDE_THRESHOLD;
      tabEl.classList.toggle('narrow', isNarrow);
      tabEl.classList.toggle('compact', isCompact);
    });
  };

  const tabs = new Map();
  const DEFAULT_TERMINAL_SETTINGS = window.TerminalSettings?.defaults || {
    fontSize: 14,
    scrollback: 5000,
    webglEnabled: true,
  };
  const normalizeTerminalSettings = typeof window.TerminalSettings?.normalize === 'function'
    ? window.TerminalSettings.normalize
    : (settings) => ({ ...DEFAULT_TERMINAL_SETTINGS, ...(settings || {}) });
  const mergeTerminalSettings = (base, patch) => {
    const merged = { ...(base || DEFAULT_TERMINAL_SETTINGS), ...(patch || {}) };
    return normalizeTerminalSettings(merged);
  };
  let settingsSnapshot = mergeTerminalSettings(DEFAULT_TERMINAL_SETTINGS, options?.initialTerminalSettings);
  let tabCounter = 0;
  let activeTabId = null;
  let lastLocalCwd = null;
  let lastWslCwd = null;
  let isCreating = false;
  let initialTabTimer = null;
  const autoScrollState = { dir: 0, since: 0 };
  const dragState = {
    tabId: null,
    tabEl: null,
    payload: null,
    dragOffsetX: 0,
    dragOffsetY: 0,
    startClientX: 0,
    startClientY: 0,
    startScreenX: 0,
    startScreenY: 0,
    lastClientX: 0,
    lastClientY: 0,
    lastScreenX: 0,
    lastScreenY: 0,
    prevClientX: 0,
    lastReorderTargetId: null,
    lastReorderDirection: 0,
    reorderCandidate: null,
    forceDetach: false,
    lastDropBeforeEl: null,
    didDrop: false,
    ghostEl: null,
    dragging: false,
    pending: false,
    pointerId: null,
    suppressClick: false,
    moveRaf: null,
  };

  const updateTabsLayout = () => {
    updateTabScrollButtons();
    updateTabNarrowClass();
    // タブが1つの時はタブでウィンドウドラッグ可能にする（プレビュータブは除外）
    const tabCount = tabsBar.querySelectorAll('.terminal-tab:not(.preview-tab)').length;
    tabsBar.classList.toggle('single-tab', tabCount === 1);
  };

  const dropIndicator = document.createElement('div');
  dropIndicator.className = 'tab-drop-indicator';
  tabsBar.appendChild(dropIndicator);

  const dragGhost = document.createElement('div');
  dragGhost.className = 'tab-drag-ghost';
  dragGhost.innerHTML = '<span class="tab-drag-ghost-dot"></span><span class="tab-drag-ghost-title"></span>';
  document.body.appendChild(dragGhost);
  dragState.ghostEl = dragGhost;

  // スクロールボタンのクリックイベント
  scrollLeftBtn?.addEventListener('click', () => {
    tabsBar.scrollBy({ left: -TAB_SCROLL_AMOUNT, behavior: 'smooth' });
  });

  scrollRightBtn?.addEventListener('click', () => {
    tabsBar.scrollBy({ left: TAB_SCROLL_AMOUNT, behavior: 'smooth' });
  });

  // マウスホイールで横スクロール
  tabsBar.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // 既に横スクロールの場合はそのまま
    if (e.deltaY !== 0) {
      e.preventDefault();
      tabsBar.scrollBy({ left: e.deltaY, behavior: 'auto' });
    }
  }, { passive: false });

  // スクロールイベントでボタン表示を更新
  tabsBar.addEventListener('scroll', updateTabScrollButtons);

  // Pointer-based drag handlers below (native HTML5 drag disabled for stability/UX).

  // リサイズ時にレイアウト更新
  const resizeObserver = new ResizeObserver(() => {
    updateTabsLayout();
  });
  resizeObserver.observe(tabsBar);

  const paneResizeObserver = new ResizeObserver(() => {
    const tab = tabs.get(activeTabId);
    if (tab) requestPaneResize(tab);
  });
  paneResizeObserver.observe(stack);


  const getOrderedTabIds = () =>
    Array.from(tabsBar.querySelectorAll('.terminal-tab'))
      .map(el => el.dataset.tabId)
      .filter(Boolean);

  const getActiveTerminal = () => {
    const tab = tabs.get(activeTabId);
    if (!tab) return null;
    const pane = tab.panes.get(tab.activePaneId);
    return pane?.terminalManager || null;
  };

  const resolvePaneProfileId = (pane, tab) => {
    if (pane?.profileId) return pane.profileId;
    if (pane?.terminalManager?.profileId) return pane.terminalManager.profileId;
    return getTabProfileId(tab);
  };

  const updateLastActiveCwd = (pane, tab, cwd) => {
    const next = typeof cwd === 'string' ? cwd.trim() : '';
    if (!next) return;
    const profileId = resolvePaneProfileId(pane, tab);
    if (isWindows && isWslProfile(profileId)) {
      lastWslCwd = next;
    } else {
      lastLocalCwd = next;
    }
  };

  const getTabStatusInfo = (tab) => {
    if (!tab?.panes || !historyManager?.getPaneStatusByPaneId) {
      return { status: '', updatedAt: 0, completedAt: 0, hasUnread: false };
    }
    let latestCompletedAt = 0;
    let latestUnreadCompletedAt = 0;
    let latestWaitingAt = 0;
    let latestWorkingAt = 0;
    tab.panes.forEach((pane) => {
      const pid = String(pane?.paneId || '').trim();
      if (!pid) return;
      const entry = historyManager.getPaneStatusByPaneId(pid);
      const status = String(entry?.status || '').trim();
      if (!status) return;
      const updatedAt = Number(entry?.updated_at) || 0;
      if (status === 'completed') {
        if (updatedAt > latestCompletedAt) latestCompletedAt = updatedAt;
        if (!entry?.flags?.defaultCompleted && updatedAt > latestUnreadCompletedAt) {
          latestUnreadCompletedAt = updatedAt;
        }
        return;
      }
      if (status === 'waiting_user') {
        if (updatedAt > latestWaitingAt) latestWaitingAt = updatedAt;
        return;
      }
      if (status === 'working') {
        if (updatedAt > latestWorkingAt) latestWorkingAt = updatedAt;
      }
    });
    const lastViewedAt = Number(tab.lastViewedAt || 0) || 0;
    const hasUnread = latestUnreadCompletedAt > lastViewedAt;
    if (hasUnread) {
      return { status: 'completed', updatedAt: latestCompletedAt, completedAt: latestCompletedAt, hasUnread: true };
    }
    if (latestWaitingAt) {
      return { status: 'waiting_user', updatedAt: latestWaitingAt, completedAt: latestCompletedAt, hasUnread: false };
    }
    if (latestWorkingAt) {
      return { status: 'working', updatedAt: latestWorkingAt, completedAt: latestCompletedAt, hasUnread: false };
    }
    if (latestCompletedAt) {
      return { status: 'completed', updatedAt: latestCompletedAt, completedAt: latestCompletedAt, hasUnread: false };
    }
    return { status: '', updatedAt: 0, completedAt: 0, hasUnread: false };
  };

  const markTabViewed = (tab, viewedAt = Date.now()) => {
    if (!tab) return;
    const ts = Number(viewedAt) || Date.now();
    tab.lastViewedAt = Math.max(tab.lastViewedAt || 0, ts);
    tab.tabEl?.classList.remove('has-unread-completion');
  };

  const syncTabUnreadCompletion = (tab, statusInfo) => {
    if (!tab?.tabEl) return;
    const completedAt = Number(statusInfo?.completedAt || 0) || 0;
    if (completedAt && completedAt > (tab.lastCompletedAt || 0)) {
      tab.lastCompletedAt = completedAt;
      if (tab.tabId === activeTabId || statusInfo?.hasUnread === false) {
        tab.lastViewedAt = Math.max(tab.lastViewedAt || 0, completedAt);
      }
    }
    const hasUnread = Boolean((tab.lastCompletedAt || 0) > (tab.lastViewedAt || 0));
    tab.tabEl.classList.toggle('has-unread-completion', hasUnread);
    tab.statusDotEl?.classList.toggle('is-unread', hasUnread);
  };

  const syncTabStatusIndicator = (tab) => {
    if (!tab?.statusDotEl) return;
    const dot = tab.statusDotEl;
    const info = getTabStatusInfo(tab);
    const status = info.status;
    const classes = ['status-working', 'status-waiting_user', 'status-completed'];
    dot.classList.remove(...classes);
    dot.classList.remove('is-unread');
    if (!status) {
      dot.classList.remove('is-visible');
      tab?.tabEl?.classList.remove('has-unread-completion');
      return;
    }
    dot.classList.add('is-visible', `status-${status}`);
    syncTabUnreadCompletion(tab, info);
  };

  const syncAllTabStatusIndicators = () => {
    tabs.forEach((tab) => syncTabStatusIndicator(tab));
  };

  const WSL_PROFILE_STORAGE_KEY = 'kawaii-terminal-wsl-profiles';
  const WSL_PROFILE_STORAGE_LIMIT = 6;

  const loadStoredWslProfiles = () => {
    try {
      const raw = localStorage.getItem(WSL_PROFILE_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isWslProfile);
    } catch (_) {
      return [];
    }
  };

  const saveStoredWslProfiles = (profiles) => {
    try {
      localStorage.setItem(WSL_PROFILE_STORAGE_KEY, JSON.stringify(profiles));
    } catch (_) {
      // ignore
    }
  };

  const rememberWslProfile = (profileId) => {
    if (!isWslProfile(profileId)) return;
    const normalized = String(profileId).trim();
    if (!normalized) return;
    const stored = loadStoredWslProfiles();
    const next = [normalized, ...stored.filter((id) => id !== normalized)];
    saveStoredWslProfiles(next.slice(0, WSL_PROFILE_STORAGE_LIMIT));
  };

  const collectWslProfileIds = () => {
    const ids = new Set(loadStoredWslProfiles());
    for (const tab of tabs.values()) {
      for (const pane of tab.panes.values()) {
        const profileId = pane.profileId || pane.terminalManager?.profileId || null;
        if (isWslProfile(profileId)) {
          ids.add(String(profileId).trim());
        }
      }
    }
    return Array.from(ids).slice(0, WSL_PROFILE_STORAGE_LIMIT);
  };

  const warmupWslForHistory = () => {
    if (!window.historyAPI?.warmupWsl) return null;
    const warmupPayload = { timeoutMs: 1500 };
    const wslProfileIds = collectWslProfileIds();
    if (wslProfileIds.length > 0) warmupPayload.profileIds = wslProfileIds;
    const promise = window.historyAPI.warmupWsl(warmupPayload);
    if (promise && typeof promise.then === 'function') {
      promise
        .then((result) => {
          if (!result?.attempted) return;
          if (historyManager?.isPanelActive?.()) {
            void historyManager.loadSessionSummaries?.({ force: true });
          }
        })
        .catch(() => {});
    }
    return promise;
  };

  const getStartCwdForNewTab = (targetProfileId) => {
    const targetIsWsl = isWindows && isWslProfile(targetProfileId);
    const cached = targetIsWsl ? lastWslCwd : lastLocalCwd;
    if (cached) return cached;

    const tab = tabs.get(activeTabId);
    if (!tab) return null;
    const paneId = tab.activePaneId || Array.from(tab.panes.keys())[0];
    const pane = paneId ? tab.panes.get(paneId) : null;
    if (!pane) return null;
    const sourceProfileId = resolvePaneProfileId(pane, tab);
    const sourceIsWsl = isWindows && isWslProfile(sourceProfileId);
    if (targetIsWsl !== sourceIsWsl) return null;
    const cwd = pane.terminalManager?.getCwd?.() || pane.lastCwd || null;
    return cwd || null;
  };

  const captureTabRects = () => {
    const rects = new Map();
    tabsBar.querySelectorAll('.terminal-tab').forEach((el) => {
      rects.set(el.dataset.tabId, el.getBoundingClientRect());
    });
    return rects;
  };

  const animateTabReorder = (prevRects, { excludeEl } = {}) => {
    const nextTabs = tabsBar.querySelectorAll('.terminal-tab');
    nextTabs.forEach((el) => {
      if (excludeEl && el === excludeEl) return;
      const prev = prevRects.get(el.dataset.tabId);
      if (!prev) return;
      const next = el.getBoundingClientRect();
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (dx === 0 && dy === 0) return;
      el.animate([
        { transform: `translate(${dx}px, ${dy}px)` },
        { transform: 'translate(0, 0)' },
      ], {
        duration: 160,
        easing: 'cubic-bezier(0.2, 0, 0, 1)',
      });
    });
  };

  const getDropBeforeElement = (clientX, { excludeId } = {}) => {
    const tabEls = Array.from(tabsBar.querySelectorAll('.terminal-tab'))
      .filter(el => el.dataset.tabId !== excludeId);
    for (const el of tabEls) {
      const rect = el.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        return el;
      }
    }
    return addBtn;
  };

  const showDropIndicator = (beforeEl) => {
    if (!beforeEl) return;
    const barRect = tabsBar.getBoundingClientRect();
    const targetRect = beforeEl.getBoundingClientRect();
    const left = targetRect.left - barRect.left - 1;
    dropIndicator.style.transform = `translateX(${Math.max(0, left)}px)`;
    dropIndicator.classList.add('show');
  };

  const hideDropIndicator = () => {
    dropIndicator.classList.remove('show');
  };

  const setGhostPosition = (clientX, clientY) => {
    if (!dragState.ghostEl) return;
    dragState.ghostEl.style.transform = `translate(${Math.round(clientX + 6)}px, ${Math.round(clientY + 6)}px)`;
  };

  const showGhost = () => {
    dragState.ghostEl?.classList.add('show');
  };

  const hideGhost = () => {
    dragState.ghostEl?.classList.remove('show');
  };

  const getDraggedTabMetrics = (clientX) => {
    if (!dragState.tabEl) return { left: clientX, width: 0, overshootX: 0 };
    const barRect = tabsBar.getBoundingClientRect();
    const tabWidth = dragState.tabEl.getBoundingClientRect().width;
    const desiredLeft = clientX - dragState.dragOffsetX;
    const desiredContentLeft = desiredLeft - barRect.left + tabsBar.scrollLeft;
    const maxContentLeft = Math.max(0, tabsBar.scrollWidth - tabWidth);
    const clampedContentLeft = Math.max(0, Math.min(maxContentLeft, desiredContentLeft));
    const overshootX = desiredContentLeft - clampedContentLeft;
    return {
      left: barRect.left + clampedContentLeft - tabsBar.scrollLeft,
      width: tabWidth,
      overshootX,
    };
  };

  const setDraggedTabOffset = (clientX) => {
    if (!dragState.tabEl) return;
    const barRect = tabsBar.getBoundingClientRect();
    const layoutLeft = barRect.left + dragState.tabEl.offsetLeft - tabsBar.scrollLeft;
    const { left } = getDraggedTabMetrics(clientX);
    const dx = left - layoutLeft;
    dragState.tabEl.style.setProperty('--drag-x', `${Math.round(dx)}px`);
  };

  const clearDraggedTabOffset = () => {
    if (!dragState.tabEl) return;
    dragState.tabEl.style.removeProperty('--drag-x');
  };

  const getOverlapDropBeforeEl = (clientX, { excludeId } = {}) => {
    if (!dragState.tabEl) return null;
    const { left, width } = getDraggedTabMetrics(clientX);
    const draggedRight = left + width;
    const draggedCenter = left + width / 2;
    let best = null;
    const tabEls = Array.from(tabsBar.querySelectorAll('.terminal-tab'))
      .filter(el => el.dataset.tabId !== excludeId);
    for (const el of tabEls) {
      const rect = el.getBoundingClientRect();
      const overlap = Math.min(draggedRight, rect.right) - Math.max(left, rect.left);
      if (overlap <= 0) continue;
      const threshold = Math.max(TAB_REORDER_MIN_OVERLAP_PX, rect.width * TAB_REORDER_OVERLAP_RATIO);
      if (overlap < threshold) continue;
      if (!best || overlap > best.overlap) {
        best = { el, rect, overlap };
      }
    }
    if (!best) {
      dragState.reorderCandidate = null;
      return null;
    }
    const targetMid = best.rect.left + best.rect.width / 2;
    const dx = dragState.lastClientX - dragState.prevClientX;
    let shouldAfter = Math.abs(dx) < 0.5 ? (draggedCenter > targetMid) : dx > 0;

    if (dragState.lastReorderTargetId === best.el.dataset.tabId && dragState.lastReorderDirection) {
      if (dragState.lastReorderDirection > 0 && !shouldAfter) {
        if (draggedCenter > targetMid - TAB_REORDER_HYSTERESIS_PX) {
          shouldAfter = true;
        }
      } else if (dragState.lastReorderDirection < 0 && shouldAfter) {
        if (draggedCenter < targetMid + TAB_REORDER_HYSTERESIS_PX) {
          shouldAfter = false;
        }
      }
    }

    dragState.reorderCandidate = {
      targetId: best.el.dataset.tabId,
      direction: shouldAfter ? 1 : -1,
    };
    return shouldAfter ? (best.el.nextSibling || addBtn) : best.el;
  };

  const reorderTabsAt = (clientX, { excludeId, useOverlap = false } = {}) => {
    const beforeEl = useOverlap
      ? getOverlapDropBeforeEl(clientX, { excludeId })
      : getDropBeforeElement(clientX, { excludeId });
    if (!beforeEl) {
      hideDropIndicator();
      return;
    }
    dragState.lastDropBeforeEl = beforeEl;
    showDropIndicator(beforeEl);
    if (dragState.tabEl && dragState.tabId) {
      const currentBefore = beforeEl === addBtn ? addBtn : beforeEl;
      if (currentBefore && dragState.tabEl !== currentBefore && dragState.tabEl.nextSibling !== currentBefore) {
        const prevRects = captureTabRects();
        tabsBar.insertBefore(dragState.tabEl, currentBefore);
        animateTabReorder(prevRects, { excludeEl: dragState.tabEl });
        setDraggedTabOffset(dragState.lastClientX);
        if (dragState.reorderCandidate) {
          dragState.lastReorderTargetId = dragState.reorderCandidate.targetId || null;
          dragState.lastReorderDirection = dragState.reorderCandidate.direction || 0;
        }
      }
    }
  };

  const getReorderClientX = (clientX) => {
    if (!dragState.tabEl) return clientX;
    const tabWidth = dragState.tabEl.getBoundingClientRect().width;
    return clientX + (tabWidth / 2 - dragState.dragOffsetX);
  };

  const handleTabDragOver = (clientX, clientY, options = {}) => {
    const { ignoreVerticalDelta = false, showDragGhost = true, useOverlap = false } = options;
    if (showDragGhost) {
      setGhostPosition(clientX, clientY);
      showGhost();
    } else {
      hideGhost();
    }

    const barRect = tabsBar.getBoundingClientRect();
    const withinBar = clientY >= barRect.top - 4 && clientY <= barRect.bottom + 4;
    const verticalDelta = Math.abs(clientY - dragState.startClientY);
    const allowReorder = withinBar && (ignoreVerticalDelta || verticalDelta < TAB_REORDER_VERTICAL_THRESHOLD);
    if (!allowReorder) {
      hideDropIndicator();
      return;
    }
    const reorderX = useOverlap ? clientX : (ignoreVerticalDelta ? clientX : getReorderClientX(clientX));
    reorderTabsAt(reorderX, { excludeId: dragState.tabId, useOverlap });
  };

  const autoScrollTabsBar = (clientX, allowReorder) => {
    if (!allowReorder) {
      autoScrollState.dir = 0;
      autoScrollState.since = 0;
      return;
    }
    if (!scrollLeftBtn || !scrollRightBtn) return;
    const isScrollable = scrollLeftBtn.classList.contains('visible')
      || scrollRightBtn.classList.contains('visible');
    if (!isScrollable) {
      autoScrollState.dir = 0;
      autoScrollState.since = 0;
      return;
    }
    const maxScrollLeft = Math.max(0, tabsBar.scrollWidth - tabsBar.clientWidth);
    if (maxScrollLeft < TAB_AUTOSCROLL_MIN_OVERFLOW) {
      autoScrollState.dir = 0;
      autoScrollState.since = 0;
      return;
    }
    const canScrollLeft = tabsBar.scrollLeft > 0.5;
    const canScrollRight = tabsBar.scrollLeft < maxScrollLeft - 0.5;
    const rect = tabsBar.getBoundingClientRect();
    const edge = 14;
    let dir = 0;
    if (clientX < rect.left + edge) {
      dir = -1;
    } else if (clientX > rect.right - edge) {
      dir = 1;
    }
    if ((dir < 0 && !canScrollLeft) || (dir > 0 && !canScrollRight)) {
      autoScrollState.dir = 0;
      autoScrollState.since = 0;
      return;
    }
    if (!dir) {
      autoScrollState.dir = 0;
      autoScrollState.since = 0;
      return;
    }
    const now = performance.now();
    if (dir !== autoScrollState.dir) {
      autoScrollState.dir = dir;
      autoScrollState.since = now;
      return;
    }
    if (now - autoScrollState.since < 140) return;
    tabsBar.scrollBy({ left: dir * (TAB_SCROLL_AMOUNT / 3), behavior: 'auto' });
  };

  const buildTabDragPayload = (tabId) => {
    const tab = tabs.get(tabId);
    if (!tab) return null;
    const title = tab.customTitle || tab.autoTitle || tab.titleEl.textContent || `Terminal ${tab.index}`;
    const panes = Array.from(tab.panes.values()).map((pane) => {
      let paneSnapshot = '';
      try {
        paneSnapshot = pane.terminalManager?.getScreenContent?.() || '';
      } catch (_) { /* noop */ }
      if (paneSnapshot.length > TAB_DRAG_SNAPSHOT_MAX) {
        paneSnapshot = paneSnapshot.slice(-TAB_DRAG_SNAPSHOT_MAX);
      }
        return {
          paneId: pane.paneId,
          title: pane.autoTitle || title,
          snapshot: paneSnapshot,
          profileId: pane.profileId || pane.terminalManager?.profileId || null,
        };
    });
    let snapshot = '';
    const activePane = tab.panes.get(tab.activePaneId);
    if (activePane) {
      snapshot = panes.find(p => p.paneId === activePane.paneId)?.snapshot || '';
    }
    return {
      tabId,
      title,
      customTitle: Boolean(tab.customTitle),
      snapshot,
      sourceWindowId: windowId,
      splitLayout: serializePaneLayout(tab.paneTree),
      panes,
      activePaneId: tab.activePaneId,
    };
  };

  const scheduleMainDragMove = () => {
    if (!USE_NATIVE_GHOST_WINDOW) return;
    if (dragState.moveRaf) return;
    dragState.moveRaf = requestAnimationFrame(() => {
      dragState.moveRaf = null;
      window.windowAPI?.tabDragMove?.({
        screenX: dragState.lastScreenX,
        screenY: dragState.lastScreenY,
        forceDetach: dragState.forceDetach,
      });
    });
  };

  const beginPointerDrag = (tabId, tabEl, event) => {
    const tab = tabs.get(tabId);
    if (!tab || tab.isEditing) return false;
    if (event.target.closest('.terminal-tab-close') || event.target.closest('.terminal-tab-rename')) return false;
    dragState.pending = true;
    dragState.dragging = false;
    dragState.pointerId = event.pointerId;
    dragState.tabId = tabId;
    dragState.tabEl = tabEl;
    dragState.payload = null;
    dragState.didDrop = false;
    dragState.startClientX = event.clientX;
    dragState.startClientY = event.clientY;
    dragState.startScreenX = event.screenX;
    dragState.startScreenY = event.screenY;
    dragState.lastClientX = event.clientX;
    dragState.lastClientY = event.clientY;
    dragState.lastScreenX = event.screenX;
    dragState.lastScreenY = event.screenY;
    dragState.prevClientX = event.clientX;
    dragState.lastReorderTargetId = null;
    dragState.lastReorderDirection = 0;
    dragState.reorderCandidate = null;
    dragState.forceDetach = false;
    dragState.suppressClick = false;
    dragState.tabEl.setPointerCapture?.(event.pointerId);
    return true;
  };

  const startPointerDrag = (event) => {
    if (dragState.dragging) return;
    const payload = buildTabDragPayload(dragState.tabId);
    if (!payload) {
      dragState.pending = false;
      return;
    }
    dragState.payload = payload;
    dragState.dragging = true;
    const rect = dragState.tabEl.getBoundingClientRect();
    dragState.dragOffsetX = event.clientX - rect.left;
    dragState.dragOffsetY = event.clientY - rect.top;

    const titlebarHeight = document.getElementById('titlebar')?.getBoundingClientRect?.().height || 44;
    if (USE_NATIVE_GHOST_WINDOW) {
      window.windowAPI?.tabDragStart?.({
        title: payload.title,
        customTitle: payload.customTitle,
        snapshot: payload.snapshot,
        panes: payload.panes,
        splitLayout: payload.splitLayout,
        activePaneId: payload.activePaneId,
        width: window.outerWidth,
        height: window.outerHeight,
        offsetX: event.screenX - window.screenX,
        offsetY: event.screenY - window.screenY,
        startScreenX: event.screenX,
        startScreenY: event.screenY,
        tabbarHeight: titlebarHeight,
        sourceWindowId: windowId,
        tabId: payload.tabId,
        detachThreshold: TAB_DETACH_VERTICAL_THRESHOLD,
        attachThreshold: TAB_ATTACH_VERTICAL_THRESHOLD,
      });
    }

    dragState.tabEl.classList.add('dragging');
    dragState.tabEl.style.setProperty('--drag-x', '0px');
    tabsBar.classList.add('dragging');
    document.body.classList.add('tab-dragging');
    if (dragState.ghostEl) {
      dragState.ghostEl.querySelector('.tab-drag-ghost-title').textContent = payload.title || 'Terminal';
      if (!USE_NATIVE_GHOST_WINDOW) {
        showGhost();
        setGhostPosition(event.clientX, event.clientY);
      } else {
        hideGhost();
      }
    }
    scheduleMainDragMove();
  };

  const updatePointerDrag = (event) => {
    if (!dragState.pending) return;
    if (dragState.pointerId !== null && event.pointerId !== dragState.pointerId) return;
    dragState.prevClientX = dragState.lastClientX;
    dragState.lastClientX = event.clientX;
    dragState.lastClientY = event.clientY;
    dragState.lastScreenX = event.screenX;
    dragState.lastScreenY = event.screenY;

    if (!dragState.dragging) {
      const dx = event.clientX - dragState.startClientX;
      const dy = event.clientY - dragState.startClientY;
      if (Math.hypot(dx, dy) < DRAG_START_DISTANCE) {
        return;
      }
      startPointerDrag(event);
    }

    if (!dragState.dragging) return;

    const metrics = getDraggedTabMetrics(event.clientX);
    const overshootX = Math.abs(metrics.overshootX);
    if (dragState.forceDetach) {
      if (overshootX < TAB_DETACH_HORIZONTAL_THRESHOLD - TAB_DETACH_HORIZONTAL_HYSTERESIS) {
        dragState.forceDetach = false;
      }
    } else if (overshootX > TAB_DETACH_HORIZONTAL_THRESHOLD) {
      dragState.forceDetach = true;
    }

    const barRect = tabsBar.getBoundingClientRect();
    const withinBar = event.clientY >= barRect.top - 4
      && event.clientY <= barRect.bottom + 4
      && event.clientX >= barRect.left - 4
      && event.clientX <= barRect.right + 4;
    if (withinBar && Math.abs(event.clientY - dragState.startClientY) > TAB_REORDER_VERTICAL_THRESHOLD) {
      dragState.startClientY = event.clientY;
    }
    const verticalDelta = Math.abs(event.clientY - dragState.startClientY);
    const allowReorder = withinBar && verticalDelta < TAB_REORDER_VERTICAL_THRESHOLD && !dragState.forceDetach;
    autoScrollTabsBar(event.clientX, allowReorder);

    if (allowReorder) {
      handleTabDragOver(event.clientX, event.clientY, { ignoreVerticalDelta: true, showDragGhost: false, useOverlap: true });
      setDraggedTabOffset(event.clientX);
    } else {
      clearDraggedTabOffset();
      hideDropIndicator();
      hideGhost();
    }

    scheduleMainDragMove();
  };

  const endPointerDrag = (event) => {
    if (!dragState.pending) return;
    if (dragState.pointerId !== null && event && event.pointerId !== dragState.pointerId) return;
    dragState.tabEl?.releasePointerCapture?.(dragState.pointerId);

    if (dragState.dragging) {
      dragState.suppressClick = true;
      if (USE_NATIVE_GHOST_WINDOW) {
        const endScreenX = Number.isFinite(event?.screenX) ? event.screenX : dragState.lastScreenX;
        const endScreenY = Number.isFinite(event?.screenY) ? event.screenY : dragState.lastScreenY;
        window.windowAPI?.tabDragEnd?.({
          screenX: endScreenX,
          screenY: endScreenY,
          forceDetach: dragState.forceDetach,
        });
      }
    }

    if (dragState.tabEl) {
      dragState.tabEl.classList.remove('dragging');
      dragState.tabEl.style.removeProperty('--drag-x');
    }
    dragState.pending = false;
    dragState.dragging = false;
    dragState.pointerId = null;
    dragState.tabId = null;
    dragState.tabEl = null;
    dragState.payload = null;
    dragState.lastDropBeforeEl = null;
    dragState.didDrop = false;
    dragState.startClientX = 0;
    dragState.startClientY = 0;
    dragState.startScreenX = 0;
    dragState.startScreenY = 0;
    dragState.lastClientX = 0;
    dragState.lastClientY = 0;
    dragState.lastScreenX = 0;
    dragState.lastScreenY = 0;
    dragState.prevClientX = 0;
    dragState.lastReorderTargetId = null;
    dragState.lastReorderDirection = 0;
    dragState.reorderCandidate = null;
    if (dragState.moveRaf) {
      cancelAnimationFrame(dragState.moveRaf);
      dragState.moveRaf = null;
    }
    autoScrollState.dir = 0;
    autoScrollState.since = 0;
    hideGhost();
    hideDropIndicator();
    tabsBar.classList.remove('dragging');
    document.body.classList.remove('tab-dragging');
    // タブ並び替え後にショートカット更新
    updateTabShortcuts();
  };

  document.addEventListener('pointermove', updatePointerDrag);
  document.addEventListener('pointerup', endPointerDrag);
  document.addEventListener('pointercancel', endPointerDrag);


  window.windowAPI?.onTabDragOver?.((payload) => {
    if (!payload || String(payload.sourceWindowId || '') === String(windowId)) return;
    if (dragState.pending || dragState.dragging) return;
    if (!Number.isFinite(payload.screenX) || !Number.isFinite(payload.screenY)) return;
    const clientX = payload.screenX - window.screenX;
    const clientY = payload.screenY - window.screenY;
    dragState.startClientY = clientY;
    handleTabDragOver(clientX, clientY, { ignoreVerticalDelta: true, showDragGhost: false });
    tabsBar.classList.add('drag-target');
  });

  window.windowAPI?.onTabDragLeave?.(() => {
    tabsBar.classList.remove('drag-target');
    hideDropIndicator();
    hideGhost();
    dragState.lastDropBeforeEl = null;
  });

  const startRename = (tabId) => {
    const tab = tabs.get(tabId);
    if (!tab || tab.isEditing) return;
    tab.isEditing = true;
    tab.tabEl.classList.add('editing');

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'terminal-tab-rename';
    input.value = tab.customTitle || tab.titleEl.textContent;
    tab.tabEl.insertBefore(input, tab.tabEl.firstChild);

      const finish = (commit) => {
        if (!tab.isEditing) return;
        tab.isEditing = false;
      tab.tabEl.classList.remove('editing');
      const value = input.value.trim();
      input.remove();
      if (!commit) {
        tab.tabEl.classList.remove('editing');
        tab.tabEl.classList.toggle('custom', Boolean(tab.customTitle));
        return;
      }
      if (value) {
        tab.customTitle = value;
        tab.titleEl.textContent = value;
        tab.tabEl.classList.add('custom');
      } else {
        tab.customTitle = null;
        tab.titleEl.textContent = tab.autoTitle || `Terminal ${tab.index}`;
        tab.tabEl.classList.remove('custom');
      }
      };

      let isComposing = false;
      input.addEventListener('compositionstart', () => {
        isComposing = true;
      });
      input.addEventListener('compositionend', () => {
        isComposing = false;
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          if (e.isComposing || isComposing || e.keyCode === 229) {
            return;
          }
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));

    input.focus();
    input.select();
  };

  const createPaneId = (tab) => {
    // セッション復元で paneCounter がリセットされても衝突しないよう、
    // 既存のpaneIdと重複しないものを採番する。
    let candidate = '';
    do {
      tab.paneCounter += 1;
      candidate = `pane-${tab.tabId}-${tab.paneCounter}`;
    } while (tab.panes?.has?.(candidate));
    return candidate;
  };

  const requestPaneResize = (tab) => {
    if (!tab) return;
    if (tab.resizeRaf) return;
    tab.resizeRaf = requestAnimationFrame(() => {
      tab.resizeRaf = null;
      tab.panes?.forEach((pane) => pane.terminalManager?.handleResize?.());
    });
  };

  const updateSplitIndicator = (tab) => {
    if (!tab?.splitIndicatorEl) return;
    tab.splitIndicatorEl.classList.toggle('show', (tab.panes?.size || 0) > 1);
  };

  const fitPaneForCommand = async (pane) => {
    if (!pane?.terminalManager) return;
    const manager = pane.terminalManager;
    for (let i = 0; i < 8; i += 1) {
      manager.ensureOpen?.();
      manager.handleResize?.();
      const container = manager.container;
      const hasSize = Boolean(container && container.offsetWidth > 0 && container.offsetHeight > 0);
      const cols = Number(manager.terminal?.cols || 0);
      const rows = Number(manager.terminal?.rows || 0);
      if (hasSize && cols > 0 && rows > 0) {
        // One extra frame to let layout settle before we paste commands.
        await new Promise((resolve) => requestAnimationFrame(resolve));
        manager.handleResize?.();
        return;
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  };

  async function launchCommandInNewTab({ title, command, cwd, wslDistro, fallbackProfileId } = {}) {
    const safeCommand = String(command || '').trim();
    if (!safeCommand) return { success: false, reason: 'missing-command' };

    const safeCwd = typeof cwd === 'string' ? cwd.trim() : '';
    const profileId = resolveSessionProfileId({ wslDistro, cwd: safeCwd, fallbackProfileId });
    const startCwd = !isWslProfile(profileId) && safeCwd ? safeCwd : undefined;

    let newTabId = null;
    try {
      newTabId = await createTab({ activate: true, title, startCwd, profileId });
    } catch (error) {
      return { success: false, reason: 'create-tab-failed', error };
    }
    if (!newTabId) return { success: false, reason: 'create-tab-failed' };

    const newTab = tabs.get(newTabId);
    const paneId = newTab?.activePaneId || Array.from(newTab?.panes?.keys?.() || [])[0];
    const targetPane = paneId ? (newTab?.panes?.get(paneId) || null) : null;
    if (!targetPane?.terminalManager) {
      return { success: false, reason: 'terminal-unavailable', tabId: newTabId, paneId, profileId };
    }

    const lines = [];
    if (safeCwd) {
      if (isWslProfile(profileId)) {
        if (!looksLikeWindowsPath(safeCwd)) {
          lines.push(`cd ${quoteShellValue(safeCwd)}`);
        }
      } else {
        lines.push(`cd ${quoteShellValue(safeCwd)}`);
      }
    }
    lines.push(safeCommand);
    await fitPaneForCommand(targetPane);
    targetPane.terminalManager.focus?.();
    targetPane.terminalManager.paste(`${lines.join('\n')}\n`);
    return { success: true, tabId: newTabId, paneId, profileId };
  }

  const buildPaneNode = (paneId) => ({ type: 'pane', paneId });

  const serializePaneLayout = (node) => {
    if (!node) return null;
    if (node.type === 'pane') {
      return { type: 'pane', paneId: node.paneId };
    }
    return {
      type: 'split',
      direction: node.direction,
      ratio: node.ratio,
      a: serializePaneLayout(node.a),
      b: serializePaneLayout(node.b),
    };
  };

  const normalizePaneLayout = (layout) => {
    if (!layout || typeof layout !== 'object') return null;
    if (layout.type === 'pane') {
      return { type: 'pane', paneId: layout.paneId };
    }
    if (layout.type !== 'split') return null;
    const ratio = Number.isFinite(layout.ratio) ? layout.ratio : 0.5;
    return {
      type: 'split',
      direction: layout.direction === 'col' ? 'col' : 'row',
      ratio: Math.max(0.1, Math.min(0.9, ratio)),
      a: normalizePaneLayout(layout.a),
      b: normalizePaneLayout(layout.b),
    };
  };

  const findPaneNode = (node, paneId, parent = null, parentSide = null, grandParent = null) => {
    if (!node) return null;
    if (node.type === 'pane') {
      if (node.paneId === paneId) {
        return { node, parent, parentSide, grandParent };
      }
      return null;
    }
    const left = findPaneNode(node.a, paneId, node, 'a', parent);
    if (left) return left;
    return findPaneNode(node.b, paneId, node, 'b', parent);
  };

  const setSplitFlex = (leftWrap, rightWrap, ratio) => {
    const safeRatio = Math.max(0.1, Math.min(0.9, ratio));
    leftWrap.style.flex = `${safeRatio} 1 0`;
    rightWrap.style.flex = `${1 - safeRatio} 1 0`;
  };

  const attachResizerEvents = (resizer, splitEl, node, leftWrap, rightWrap, tab) => {
    const direction = node.direction;
    const isRow = direction === 'row';
    let dragging = false;

    const onMove = (e) => {
      if (!dragging) return;
      const rect = splitEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const pos = isRow ? (e.clientX - rect.left) : (e.clientY - rect.top);
      const size = isRow ? rect.width : rect.height;
      let ratio = pos / size;
      let minRatio = isRow ? (MIN_PANE_WIDTH / size) : (MIN_PANE_HEIGHT / size);
      if (!Number.isFinite(minRatio) || minRatio <= 0) minRatio = 0.1;
      if (minRatio > 0.45) minRatio = 0.1;
      ratio = Math.max(minRatio, Math.min(1 - minRatio, ratio));
      node.ratio = ratio;
      setSplitFlex(leftWrap, rightWrap, node.ratio);
      requestPaneResize(tab);
    };

    const stop = () => {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove('dragging');
      document.body.classList.remove('pane-resizing');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('blur', stop);
      resizeFocusHandler?.();
    };

    resizer.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      resizer.classList.add('dragging');
      document.body.classList.add('pane-resizing');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
      window.addEventListener('blur', stop);
    });

    resizer.addEventListener('dblclick', (e) => {
      e.preventDefault();
      node.ratio = 0.5;
      setSplitFlex(leftWrap, rightWrap, node.ratio);
      requestPaneResize(tab);
    });
  };

  const buildPaneDom = (tab, node) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'terminal-pane-node';
    if (node.type === 'pane') {
      const pane = tab.panes.get(node.paneId);
      if (pane) {
        pane.paneEl.classList.toggle('active', tab.activePaneId === node.paneId);
        wrapper.appendChild(pane.paneEl);
      }
      return wrapper;
    }
    const splitEl = document.createElement('div');
    splitEl.className = 'terminal-pane-split';
    splitEl.dataset.direction = node.direction;
    const leftWrap = buildPaneDom(tab, node.a);
    const rightWrap = buildPaneDom(tab, node.b);
    const resizer = document.createElement('div');
    resizer.className = 'terminal-pane-resizer';
    resizer.dataset.direction = node.direction;
    splitEl.appendChild(leftWrap);
    splitEl.appendChild(resizer);
    splitEl.appendChild(rightWrap);
    setSplitFlex(leftWrap, rightWrap, node.ratio);
    attachResizerEvents(resizer, splitEl, node, leftWrap, rightWrap, tab);
    wrapper.appendChild(splitEl);
    return wrapper;
  };

  const renderPaneTree = (tab) => {
    if (!tab?.paneRoot || !tab?.paneTree) return;
    tab.paneRoot.innerHTML = '';
    const rootEl = buildPaneDom(tab, tab.paneTree);
    tab.paneRoot.appendChild(rootEl);
    updateSplitIndicator(tab);
    updatePaneCloseButtons(tab);
    requestPaneResize(tab);
  };

  const canSplitPane = (tab, paneId, direction) => {
    if (!tab || !paneId) return false;
    if ((tab.panes?.size || 0) >= MAX_PANES) return false;
    const pane = tab.panes.get(paneId);
    if (!pane) return false;
    const rect = pane.paneEl.getBoundingClientRect();
    if (direction === 'row') return rect.width >= MIN_PANE_WIDTH * 2;
    if (direction === 'col') return rect.height >= MIN_PANE_HEIGHT * 2;
    return false;
  };

  // ========== Pane Drag & Drop ==========

  // Pane drag state
  const paneDragState = {
    dragging: false,
    pending: false,
    sourceTabId: null,
    sourcePaneId: null,
    startX: 0,
    startY: 0,
    pointerId: null,
    ghostEl: null,
    dropHintEl: null,
    currentDropTarget: null,
    dropTargetType: null, // 'pane' | 'tabbar' | 'outside'
    tabInsertBeforeEl: null, // Tab element to insert new tab before
  };

  // Create swap hint overlay element (simple full-pane highlight for swap)
  const createSwapHintOverlay = () => {
    const overlay = document.createElement('div');
    overlay.className = 'pane-swap-hint-overlay';
    return overlay;
  };

  // Swap two panes in the tree
  const swapPanesInTree = (tree, paneIdA, paneIdB) => {
    const swap = (node) => {
      if (!node) return;
      if (node.type === 'pane') {
        if (node.paneId === paneIdA) {
          node.paneId = paneIdB;
        } else if (node.paneId === paneIdB) {
          node.paneId = paneIdA;
        }
        return;
      }
      swap(node.a);
      swap(node.b);
    };
    swap(tree);
  };

  // Find pane element at point
  const findPaneAtPoint = (tab, clientX, clientY) => {
    for (const pane of tab.panes.values()) {
      const rect = pane.paneEl.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right &&
          clientY >= rect.top && clientY <= rect.bottom) {
        return pane;
      }
    }
    return null;
  };

  // Show swap hint on target pane (full pane highlight)
  const showSwapHint = (targetPane) => {
    hideSwapHint();
    if (!targetPane?.paneEl) return;

    const overlay = createSwapHintOverlay();
    paneDragState.dropHintEl = overlay;
    targetPane.paneEl.appendChild(overlay);
  };

  // Hide swap hint
  const hideSwapHint = () => {
    if (paneDragState.dropHintEl) {
      paneDragState.dropHintEl.remove();
      paneDragState.dropHintEl = null;
    }
  };

  // Create drag ghost element
  const createPaneDragGhost = (pane) => {
    const ghost = document.createElement('div');
    ghost.className = 'pane-drag-ghost';
    ghost.textContent = pane.autoTitle || 'Terminal';
    document.body.appendChild(ghost);
    return ghost;
  };

  // Begin pane drag
  const beginPaneDrag = (tab, pane, event) => {
    if (paneDragState.pending || paneDragState.dragging) return false;
    if (tab.panes.size < 2) return false; // Can't drag single pane

    paneDragState.pending = true;
    paneDragState.sourceTabId = tab.tabId;
    paneDragState.sourcePaneId = pane.paneId;
    paneDragState.startX = event.clientX;
    paneDragState.startY = event.clientY;
    paneDragState.pointerId = event.pointerId;

    pane.headerEl.setPointerCapture?.(event.pointerId);
    return true;
  };

  // Start actual dragging (after threshold)
  const startPaneDrag = (event) => {
    if (paneDragState.dragging) return;
    paneDragState.dragging = true;
    paneDragState.pending = false;

    const tab = tabs.get(paneDragState.sourceTabId);
    const pane = tab?.panes.get(paneDragState.sourcePaneId);
    if (!pane) {
      endPaneDrag();
      return;
    }

    // Create ghost
    paneDragState.ghostEl = createPaneDragGhost(pane);
    updatePaneDragGhost(event.clientX, event.clientY);

    // Add dragging class
    document.body.classList.add('pane-dragging');
    pane.paneEl.classList.add('drag-source');
  };

  // Update ghost position
  const updatePaneDragGhost = (clientX, clientY) => {
    if (!paneDragState.ghostEl) return;
    paneDragState.ghostEl.style.left = `${clientX + 12}px`;
    paneDragState.ghostEl.style.top = `${clientY + 12}px`;
  };

  // Check if point is outside window
  const isOutsideWindow = (screenX, screenY) => {
    const left = window.screenX;
    const top = window.screenY;
    const right = left + window.outerWidth;
    const bottom = top + window.outerHeight;
    return screenX < left || screenX > right || screenY < top || screenY > bottom;
  };

  // Update pane drag (on pointer move)
  const updatePaneDrag = (event) => {
    if (!paneDragState.pending && !paneDragState.dragging) return;

    const dx = event.clientX - paneDragState.startX;
    const dy = event.clientY - paneDragState.startY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Start actual drag after threshold
    if (paneDragState.pending && distance >= PANE_DRAG_START_DISTANCE) {
      startPaneDrag(event);
    }

    if (!paneDragState.dragging) return;

    updatePaneDragGhost(event.clientX, event.clientY);

    const tab = tabs.get(paneDragState.sourceTabId);
    if (!tab) return;

    // Check if over tabs bar
    const tabsBarRect = tabsBar.getBoundingClientRect();
    const isOverTabsBar = event.clientX >= tabsBarRect.left &&
                          event.clientX <= tabsBarRect.right &&
                          event.clientY >= tabsBarRect.top &&
                          event.clientY <= tabsBarRect.bottom + 10;

    // Check if outside window
    const isOutside = isOutsideWindow(event.screenX, event.screenY);

    if (isOutside) {
      paneDragState.dropTargetType = 'outside';
      paneDragState.currentDropTarget = null;
      hideSwapHint();
      hideDropIndicator();
      tabsBar.classList.remove('pane-drop-target');
      // Update ghost to show "New Window"
      if (paneDragState.ghostEl) {
        paneDragState.ghostEl.classList.add('detach-hint');
      }
    } else if (isOverTabsBar) {
      paneDragState.dropTargetType = 'tabbar';
      paneDragState.currentDropTarget = null;
      hideSwapHint();
      tabsBar.classList.add('pane-drop-target');
      if (paneDragState.ghostEl) {
        paneDragState.ghostEl.classList.remove('detach-hint');
      }
      // Show tab insert position indicator
      const beforeEl = getDropBeforeElement(event.clientX, {});
      if (beforeEl) {
        showDropIndicator(beforeEl);
        paneDragState.tabInsertBeforeEl = beforeEl;
      } else {
        hideDropIndicator();
        paneDragState.tabInsertBeforeEl = null;
      }
    } else {
      paneDragState.dropTargetType = 'pane';
      tabsBar.classList.remove('pane-drop-target');
      hideDropIndicator();
      if (paneDragState.ghostEl) {
        paneDragState.ghostEl.classList.remove('detach-hint');
      }

      // Find target pane for swap
      const targetPane = findPaneAtPoint(tab, event.clientX, event.clientY);

      if (targetPane && targetPane.paneId !== paneDragState.sourcePaneId) {
        paneDragState.currentDropTarget = targetPane;
        showSwapHint(targetPane);
      } else {
        paneDragState.currentDropTarget = null;
        hideSwapHint();
      }
    }
  };

  // Convert pane to new tab
  const convertPaneToTab = async (tab, paneId, insertBeforeEl) => {
    const pane = tab.panes.get(paneId);
    if (!pane) return;
    if (tab.panes.size < 2) return; // Can't detach last pane

    // Capture pane state before closing
    const snapshot = pane.terminalManager?.getScreenContent?.() || '';
    const title = pane.autoTitle || 'Terminal';
    const cwd = pane.terminalManager?.getCwd?.() || pane.lastCwd || null;

    // Close the pane
    await closePane(tab, paneId);

    // Create new tab with the captured state at the specified position
      await createTab({
        activate: true,
        title,
        startCwd: cwd,
        profileId: pane.profileId || pane.terminalManager?.profileId || null,
        snapshot,
        insertBeforeEl,
      });
  };

  // Convert pane to new window
  const convertPaneToWindow = async (tab, paneId, screenX, screenY) => {
    const pane = tab.panes.get(paneId);
    if (!pane) return;
    if (tab.panes.size < 2) return; // Can't detach last pane

    // Build payload similar to tab drag
    const snapshot = pane.terminalManager?.getScreenContent?.() || '';
    const title = pane.autoTitle || 'Terminal';
    const cwd = pane.terminalManager?.getCwd?.() || pane.lastCwd || null;

    const payload = {
      tabId: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      customTitle: null,
      snapshot,
      sourceWindowId: windowId,
      splitLayout: null,
        panes: [{
          paneId: `pane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          title,
          snapshot,
          cwd,
          profileId: pane.profileId || pane.terminalManager?.profileId || null,
        }],
      activePaneId: null,
    };

    // Close the pane first
    await closePane(tab, paneId);

    // Request new window creation
    window.windowAPI?.createWindowWithTab?.({
      payload,
      screenX,
      screenY,
    });
  };

  // End pane drag
  const endPaneDrag = async (event) => {
    const wasDragging = paneDragState.dragging;
    const sourceTabId = paneDragState.sourceTabId;
    const sourcePaneId = paneDragState.sourcePaneId;
    const targetPane = paneDragState.currentDropTarget;
    const dropTargetType = paneDragState.dropTargetType;
    const tabInsertBeforeEl = paneDragState.tabInsertBeforeEl;

    // Cleanup
    hideSwapHint();
    hideDropIndicator();
    if (paneDragState.ghostEl) {
      paneDragState.ghostEl.remove();
      paneDragState.ghostEl = null;
    }
    document.body.classList.remove('pane-dragging');
    tabsBar.classList.remove('pane-drop-target');

    const tab = tabs.get(sourceTabId);
    const sourcePane = tab?.panes.get(sourcePaneId);
    if (sourcePane) {
      sourcePane.paneEl.classList.remove('drag-source');
      sourcePane.headerEl.releasePointerCapture?.(paneDragState.pointerId);
    }

    // Capture values before reset
    const screenX = event?.screenX ?? 0;
    const screenY = event?.screenY ?? 0;

    // Reset state
    paneDragState.dragging = false;
    paneDragState.pending = false;
    paneDragState.sourceTabId = null;
    paneDragState.sourcePaneId = null;
    paneDragState.pointerId = null;
    paneDragState.currentDropTarget = null;
    paneDragState.dropTargetType = null;
    paneDragState.tabInsertBeforeEl = null;

    if (!wasDragging || !tab) return;

    // Handle drop based on target type
    if (dropTargetType === 'tabbar') {
      // Convert pane to new tab at the indicated position
      await convertPaneToTab(tab, sourcePaneId, tabInsertBeforeEl);
    } else if (dropTargetType === 'outside') {
      // Convert pane to new window
      await convertPaneToWindow(tab, sourcePaneId, screenX, screenY);
    } else if (dropTargetType === 'pane' && targetPane) {
      if (targetPane.paneId === sourcePaneId) return;
      // Swap panes
      swapPanesInTree(tab.paneTree, sourcePaneId, targetPane.paneId);
      renderPaneTree(tab);
    }
  };

  // Bind pane drag events to header
  const bindPaneDragEvents = (tab, pane) => {
    const header = pane.headerEl;
    if (!header) return;

    header.addEventListener('pointerdown', (e) => {
      // Only left mouse button, not on close button
      if (e.button !== 0) return;
      if (e.target.closest('.terminal-pane-close')) return;

      e.preventDefault();
      beginPaneDrag(tab, pane, e);
    });

    header.addEventListener('pointermove', (e) => {
      if (paneDragState.sourcePaneId !== pane.paneId) return;
      updatePaneDrag(e);
    });

    header.addEventListener('pointerup', (e) => {
      if (paneDragState.sourcePaneId !== pane.paneId) return;
      endPaneDrag(e);
    });

    header.addEventListener('pointercancel', (e) => {
      if (paneDragState.sourcePaneId !== pane.paneId) return;
      endPaneDrag(e);
    });

    // Make header look draggable
    header.style.cursor = 'grab';
  };

  // ========== End Pane Drag & Drop ==========

  // ペインヘッダーの表示/非表示を更新（1ペインの時は非表示）
  const updatePaneCloseButtons = (tab) => {
    const showHeader = tab.panes.size > 1;
    tab.panes.forEach((pane) => {
      if (pane.headerEl) {
        pane.headerEl.style.display = showHeader ? '' : 'none';
      }
    });
  };

  const setActivePane = (tab, paneId) => {
    if (!tab || !paneId) return;
    const pane = tab.panes.get(paneId);
    if (!pane) return;
    tab.activePaneId = paneId;
    const isActiveTab = tab.tabId === activeTabId;
    tab.panes.forEach((entry) => {
      entry.paneEl.classList.toggle('active', entry.paneId === paneId);
    });
    if (!tab.customTitle) {
      tab.autoTitle = pane.autoTitle || tab.autoTitle;
      tab.titleEl.textContent = tab.autoTitle || `Terminal ${tab.index}`;
    }
    if (isActiveTab) {
      pinManager?.setActiveTab?.(tab.tabId);
      pinManager?.setActivePane?.(pane.paneId, pane);
      pinManager?.attachTerminal?.(pane.paneId, pane.terminalManager.terminal, pane.terminalManager, pane);
      historyManager?.setActiveTab?.(tab.tabId);
      historyManager?.setActiveTabLabel?.(tab.titleEl?.textContent || tab.tabId);
      historyManager?.setActivePane?.(pane.paneId, pane);
      const activeCwd = pane.terminalManager.getCwd?.();
      if (activeCwd) {
        imagePreviewManager?.setBasePath?.(activeCwd);
        mdPreviewManager?.setBasePath?.(activeCwd);
        pane.lastCwd = activeCwd;
        updateLastActiveCwd(pane, tab, activeCwd);
      } else {
        void pane.terminalManager.refreshCwdFromMain?.({ force: true });
      }
      pane.terminalManager.ensureOpen?.();
      pane.terminalManager.handleResize?.();
      pane.terminalManager.focus();
      setTimeout(() => {
        if (tab.tabId !== activeTabId || tab.activePaneId !== paneId) return;
        const activeEl = document.activeElement;
        if (activeEl) {
          if (activeEl.classList && activeEl.classList.contains('xterm-helper-textarea')) return;
          if (activeEl.closest && !activeEl.closest('.terminal-panel')) return;
          if (activeEl.isContentEditable) return;
          if (activeEl.tagName) {
            const tag = activeEl.tagName.toLowerCase();
            if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
          }
        }
        pane.terminalManager.focus();
      }, 30);
    }
    updateTabWslIndicator(tab);
  };

  const getRectCenter = (rect) => ({
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  });

  const getOverlap = (startA, endA, startB, endB) => {
    return Math.min(endA, endB) - Math.max(startA, startB);
  };

  const findAdjacentPaneId = (tab, direction) => {
    if (!tab || (tab.panes?.size || 0) <= 1) return null;
    const activeId = tab.activePaneId || Array.from(tab.panes.keys())[0];
    const activePane = tab.panes.get(activeId);
    if (!activePane) return null;
    const activeRect = activePane.paneEl.getBoundingClientRect();
    if (!activeRect.width || !activeRect.height) return null;
    const activeCenter = getRectCenter(activeRect);
    let best = null;

    tab.panes.forEach((pane, paneId) => {
      if (paneId === activeId) return;
      const rect = pane.paneEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const center = getRectCenter(rect);

      let primary = 0;
      let overlap = 0;
      let secondary = 0;

      if (direction === 'left') {
        if (center.x >= activeCenter.x - 1) return;
        primary = activeCenter.x - center.x;
        overlap = getOverlap(activeRect.top, activeRect.bottom, rect.top, rect.bottom);
        secondary = Math.abs(activeCenter.y - center.y);
      } else if (direction === 'right') {
        if (center.x <= activeCenter.x + 1) return;
        primary = center.x - activeCenter.x;
        overlap = getOverlap(activeRect.top, activeRect.bottom, rect.top, rect.bottom);
        secondary = Math.abs(activeCenter.y - center.y);
      } else if (direction === 'up') {
        if (center.y >= activeCenter.y - 1) return;
        primary = activeCenter.y - center.y;
        overlap = getOverlap(activeRect.left, activeRect.right, rect.left, rect.right);
        secondary = Math.abs(activeCenter.x - center.x);
      } else if (direction === 'down') {
        if (center.y <= activeCenter.y + 1) return;
        primary = center.y - activeCenter.y;
        overlap = getOverlap(activeRect.left, activeRect.right, rect.left, rect.right);
        secondary = Math.abs(activeCenter.x - center.x);
      } else {
        return;
      }

      const candidate = {
        paneId,
        overlap: Math.max(0, overlap),
        primary,
        secondary,
      };

      if (!best) {
        best = candidate;
        return;
      }
      if (candidate.overlap > best.overlap + 0.5) {
        best = candidate;
        return;
      }
      if (Math.abs(candidate.overlap - best.overlap) <= 0.5) {
        if (candidate.primary < best.primary - 0.5) {
          best = candidate;
          return;
        }
        if (Math.abs(candidate.primary - best.primary) <= 0.5 && candidate.secondary < best.secondary) {
          best = candidate;
        }
      }
    });

    return best?.paneId || null;
  };

  const focusPaneByDirection = (direction) => {
    const tab = tabs.get(activeTabId);
    if (!tab) return;
    const nextPaneId = findAdjacentPaneId(tab, direction);
    if (nextPaneId) {
      setActivePane(tab, nextPaneId);
    }
  };

  const bindPaneHandlers = (tab, pane) => {
    const paneId = pane.paneId;
    const terminalManager = pane.terminalManager;

    terminalManager.onCwdChange = (cwd, meta) => {
      const next = typeof cwd === 'string' ? cwd.trim() : '';
      if (!next) return;
      pane.lastCwd = next;
      window.statusAPI?.sendPaneEvent?.({
        pane_id: paneId,
        tab_id: tab.tabId,
        event: 'prompt',
        timestamp: Date.now(),
        changed: Boolean(meta?.changed),
        cwd: next,
      });
      historyManager?.onCwdChange?.(paneId, next);
      if (tab.tabId === activeTabId && tab.activePaneId === paneId) {
        imagePreviewManager?.setBasePath?.(next);
        mdPreviewManager?.setBasePath?.(next);
        updateLastActiveCwd(pane, tab, next);
      }
    };

    terminalManager.onTitleChange = (titleText) => {
      const trimmed = (titleText || '').trim();
      if (!trimmed) return;
      pane.autoTitle = trimmed;
      // ペインタイトルを更新
      if (pane.titleEl) {
        pane.titleEl.textContent = trimmed;
      }
      historyManager?.updatePaneLabel?.(paneId, trimmed);
      // アクティブペインならタブタイトルも更新
      if (tab.activePaneId === paneId && !tab.customTitle) {
        tab.autoTitle = trimmed;
        tab.titleEl.textContent = trimmed;
        historyManager?.setActiveTabLabel?.(trimmed);
      }

      // タイトル更新は表示のみ。通知判定は出力検知で行う。
    };

    terminalManager.onOutputData = (data) => {
      if (onHistoryBootstrap) onHistoryBootstrap();
      pane.sessionSnapshotDirty = true;
      historyManager?.onOutput?.(paneId, data, terminalManager.terminal, terminalManager);
      if (tab.activePaneId !== paneId) return;
      pinManager?.onOutput?.(paneId, data, terminalManager.terminal);
      const cwd = terminalManager.getCwd?.();
      if (tab.tabId === activeTabId && cwd && cwd !== pane.lastCwd) {
        imagePreviewManager?.setBasePath?.(cwd);
        mdPreviewManager?.setBasePath?.(cwd);
        pane.lastCwd = cwd;
      }
    };

    terminalManager.onCommandSubmit = (command) => {
      if (tab.activePaneId !== paneId) return;
      if (tab.tabId === activeTabId) {
        cheerManager.onCommandSubmit(command);
      }
      pinManager?.onCommandSubmit?.(paneId, command, terminalManager.terminal, terminalManager);
      historyManager?.onCommandSubmit?.(paneId, command, pane, terminalManager);
    };

    terminalManager.onCommandExecuted = (command, meta) => {
      const cwd = terminalManager.getCwd?.();
      window.statusAPI?.sendCommand?.({
        pane_id: paneId,
        tab_id: tab.tabId,
        command,
        timestamp: Date.now(),
        cwd: typeof cwd === 'string' ? cwd : '',
        meta: meta || null,
      });
      historyManager?.onCommandExecuted?.(paneId, command, meta, pane, terminalManager);
    };

    terminalManager.onShellInfo = (info, meta) => {
      historyManager?.onShellInfo?.(paneId, info, meta, pane, terminalManager);
    };

    terminalManager.onOsc = (osc) => {
      historyManager?.onOsc?.(paneId, osc, pane, terminalManager);
    };

    if (terminalManager.profileId) {
      historyManager?.onProfileUpdate?.(paneId, terminalManager.profileId, pane, terminalManager);
    }

  };

  const createPane = async (tab, options = {}) => {
    const {
      paneId: providedId,
      attachExisting = false,
      snapshot,
      title,
      startCwd,
      profileId,
      sourceCwd,
      prefillLabel,
      deferPtyStart = false,
      initialSettings = null,
      deferXtermOpen = false,
    } = options;
    const paneId = (providedId && !tab.panes.has(providedId))
      ? providedId
      : createPaneId(tab);
    const paneEl = document.createElement('div');
    paneEl.className = 'terminal-pane';
    paneEl.dataset.paneId = paneId;

    // ペインヘッダー（タイトル + 閉じるボタン）
    const headerEl = document.createElement('div');
    headerEl.className = 'terminal-pane-header';
    const titleEl = document.createElement('span');
    titleEl.className = 'terminal-pane-title';
    titleEl.textContent = title || 'Terminal';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'terminal-pane-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close pane';
    headerEl.appendChild(titleEl);
    headerEl.appendChild(closeBtn);
    paneEl.appendChild(headerEl);

    const summaryEl = document.createElement('div');
    summaryEl.className = 'terminal-pane-summary is-empty';
    paneEl.appendChild(summaryEl);

    const contentEl = document.createElement('div');
    contentEl.className = 'terminal-pane-content';
    paneEl.appendChild(contentEl);

    const loadingEl = document.createElement('div');
    loadingEl.className = 'terminal-loading';
    const loadingText = document.createElement('div');
    loadingText.className = 'terminal-loading-text';
    loadingEl.appendChild(loadingText);
    paneEl.appendChild(loadingEl);

    // Float actions (copy/pin buttons) for this pane
    const floatActionsEl = document.createElement('div');
    floatActionsEl.className = 'terminal-float-actions';

    const copyOutputBtn = document.createElement('button');
    copyOutputBtn.className = 'terminal-float-btn terminal-copy-output-btn';
    copyOutputBtn.setAttribute('data-tooltip', 'Copy Last Output');
    copyOutputBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" fill="currentColor"/></svg>';

    const pinBtn = document.createElement('button');
    pinBtn.className = 'terminal-float-btn terminal-pin-btn';
    pinBtn.setAttribute('data-tooltip', 'Pin Last Output');
    pinBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5v6l1 1 1-1v-6h5v-2l-2-2z" fill="currentColor"/></svg>';

    floatActionsEl.appendChild(copyOutputBtn);
    floatActionsEl.appendChild(pinBtn);
    paneEl.appendChild(floatActionsEl);

    // Toast element for this pane
    const toastEl = document.createElement('div');
    toastEl.className = 'terminal-toast';
    paneEl.appendChild(toastEl);

    paneEl.addEventListener('pointerdown', () => {
      if (tab.activePaneId !== paneId) {
        setActivePane(tab, paneId);
      }
    });

    const terminalManager = new TerminalManager(contentEl, paneId);
    terminalManager.setMdPreviewManager?.(mdPreviewManager);
    const resolvedStartCwd = startCwd || sourceCwd || null;
      await terminalManager.initialize({
        attachExisting,
        startCwd: resolvedStartCwd,
        profileId,
        prefill: snapshot,
        prefillLabel,
        deferPtyStart,
        deferXtermOpen,
        loadingEl,
        loadingClassTarget: paneEl,
        loadingLabel: getTerminalLoadingLabel(profileId),
        loadingDelayMs,
        initialSettings,
        skipSettingsReload: Boolean(initialSettings),
      });
    rememberWslProfile(profileId);

    const pane = {
      paneId,
      paneEl,
      headerEl,
      titleEl,
      closeBtn,
      contentEl,
      terminalManager,
      floatActionsEl,
      copyOutputBtn,
      pinBtn,
      toastEl,
      toastTimer: null,
      summaryEl,
      autoTitle: title || `Terminal ${tab.index}`,
      lastCwd: null,
      tabId: tab.tabId,
      sessionSnapshotDirty: false,
        sessionSnapshotHash: '',
        imagePreviewDisposable: null,
        mdPreviewDisposable: null,
        profileId: profileId || null,
      };
    historyManager?.updatePaneLabel?.(paneId, titleEl.textContent || 'Terminal');

    // 閉じるボタンのイベント
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closePane(tab, paneId);
    });

    // Copy output button click
    copyOutputBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pinManager?.copyPaneOutput?.(paneId, pane);
    });

    // Pin button click
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pinManager?.pinPaneOutput?.(paneId, pane);
    });

    // Update tooltips with shortcuts
    pinManager?.updatePaneTooltips?.(pane);

    pane.imagePreviewDisposable = imagePreviewManager?.registerLinkProvider?.(terminalManager.terminal);
    pane.mdPreviewDisposable = mdPreviewManager?.registerLinkProvider?.(terminalManager.terminal);
    bindPaneHandlers(tab, pane);
    bindPaneDragEvents(tab, pane);

    tab.panes.set(paneId, pane);
    updateTabWslIndicator(tab);
    syncTabStatusIndicator(tab);
    return pane;
  };

  const splitPane = async (tab, paneId, direction, side) => {
    if (!tab || !paneId || !tab.panes.has(paneId)) return null;
    if (!canSplitPane(tab, paneId, direction)) return null;
    const sourcePane = tab.panes.get(paneId);
    if (!sourcePane) return null;
    const sourceCwd = sourcePane.terminalManager.getCwd?.();
    const sourceProfileId = sourcePane.profileId || sourcePane.terminalManager?.profileId || null;
    const newPane = await createPane(tab, { sourceCwd, profileId: sourceProfileId, initialSettings: settingsSnapshot });
    const target = findPaneNode(tab.paneTree, paneId);
    if (!target) return null;
    const newNode = buildPaneNode(newPane.paneId);
    const oldNode = target.node;
    const splitNode = {
      type: 'split',
      direction,
      ratio: 0.5,
      a: side === 'before' ? newNode : oldNode,
      b: side === 'before' ? oldNode : newNode,
    };
    if (!target.parent) {
      tab.paneTree = splitNode;
    } else if (target.parentSide === 'a') {
      target.parent.a = splitNode;
    } else {
      target.parent.b = splitNode;
    }
    renderPaneTree(tab);
    setActivePane(tab, newPane.paneId);
    return newPane.paneId;
  };

  const closePane = async (tab, paneId) => {
    if (!tab || !paneId) return;
    if ((tab.panes?.size || 0) <= 1) {
      closeTab(tab.tabId);
      return;
    }
    const target = findPaneNode(tab.paneTree, paneId);
    if (!target || !target.parent) return;
    const pane = tab.panes.get(paneId);
    if (pane) {
      window.statusAPI?.sendPaneEvent?.({
        pane_id: paneId,
        tab_id: tab.tabId,
        event: 'close',
        timestamp: Date.now(),
      });
      pane.imagePreviewDisposable?.dispose?.();
      pane.mdPreviewDisposable?.dispose?.();
      pane.terminalManager.destroy();
      await window.terminalAPI.close(paneId);
      pane.paneEl.remove();
      tab.panes.delete(paneId);
      historyManager?.handlePaneClose?.(paneId);
    }
    const sibling = target.parentSide === 'a' ? target.parent.b : target.parent.a;
    if (!target.grandParent) {
      tab.paneTree = sibling;
    } else if (target.grandParent.a === target.parent) {
      target.grandParent.a = sibling;
    } else {
      target.grandParent.b = sibling;
    }
    renderPaneTree(tab);
    const fallbackPaneId = tab.activePaneId && tab.panes.has(tab.activePaneId)
      ? tab.activePaneId
      : Array.from(tab.panes.keys())[0];
    if (fallbackPaneId) {
      setActivePane(tab, fallbackPaneId);
    } else {
      updateTabWslIndicator(tab);
    }
    syncTabStatusIndicator(tab);
  };

  // タブのショートカット表示を更新（タブバーの順序に基づく）
  const updateTabShortcuts = () => {
    const tabEls = Array.from(tabsBar.querySelectorAll('.terminal-tab'));
    tabEls.forEach((el, index) => {
      const tabId = el.dataset.tabId;
      const tab = tabs.get(tabId);
      if (!tab?.shortcutEl) return;
      if (index < 9) {
        let label = '';
        if (shortcutManager) {
          const binding = shortcutManager.getBindings(`tab:activate-${index + 1}`)[0];
          if (binding) {
            label = shortcutManager.formatLabel(binding, shortcutManager.platformKey === 'mac');
          }
        }
        if (!label) {
          const mac = window.windowAPI?.platform === 'darwin';
          const modKey = mac ? '⌘' : '⌃';
          label = `${modKey}${index + 1}`;
        }
        tab.shortcutEl.textContent = label;
      } else {
        tab.shortcutEl.textContent = '';
      }
    });
  };

  const activateTab = (tabId) => {
    const target = tabs.get(tabId);
    if (!target) return;
    activeTabId = tabId;
    tabs.forEach((tab, id) => {
      const isActive = id === tabId;
      tab.container.style.display = isActive ? 'block' : 'none';
      tab.tabEl.classList.toggle('active', isActive);
      if (isActive) {
        tab.tabEl.classList.remove('has-activity');
      }
    });
    pinManager?.setActiveTab?.(tabId);
    historyManager?.setActiveTab?.(tabId);
    historyManager?.setActiveTabLabel?.(target.titleEl?.textContent || tabId);
    markTabViewed(target);
    const paneId = target.activePaneId || Array.from(target.panes.keys())[0];
    if (paneId) {
      setActivePane(target, paneId);
      setTimeout(() => requestPaneResize(target), 50);
    }
  };

  const activatePaneById = (paneId) => {
    if (!paneId) return false;
    for (const [tabId, tab] of tabs.entries()) {
      if (!tab?.panes?.has?.(paneId)) continue;
      activateTab(tabId);
      setActivePane(tab, paneId);
      tab.panes.get(paneId)?.terminalManager?.focus?.();
      return true;
    }
    return false;
  };

  const createTab = async (options = {}) => {
    if (isCreating) return null;
    const {
      activate = true,
      tabId: providedId,
      attachExisting = false,
      title,
      customTitle = false,
      snapshot,
      restoreSession = false,
      startCwd,
      profileId,
      insertBeforeEl,
      paneLayout,
      panes: panePayloads,
      activePaneId: providedActivePaneId,
      deferPtyStart = false,
      initialSettings = null,
      deferXtermOpen = false,
    } = options;
    const effectiveInitialSettings = initialSettings || settingsSnapshot || null;
    isCreating = true;
    try {
      tabCounter += 1;
      const tabId = providedId || `tab-${windowId}-${Date.now()}-${tabCounter}`;

      const container = document.createElement('div');
      container.className = 'terminal-instance';
      container.dataset.tabId = tabId;
      container.style.display = 'none';
      stack.appendChild(container);

      const paneRoot = document.createElement('div');
      paneRoot.className = 'terminal-pane-root';
      container.appendChild(paneRoot);

      const tabEl = document.createElement('div');
      tabEl.className = 'terminal-tab';
      tabEl.dataset.tabId = tabId;

      const statusDotEl = document.createElement('span');
      statusDotEl.className = 'terminal-tab-status-dot';

      const titleEl = document.createElement('span');
      titleEl.className = 'terminal-tab-title';
      titleEl.textContent = title || `Terminal ${tabCounter}`;

      const wslBadgeEl = document.createElement('span');
      wslBadgeEl.className = 'terminal-tab-wsl';
      wslBadgeEl.textContent = 'WSL';
      wslBadgeEl.title = 'WSL';
      wslBadgeEl.setAttribute('aria-hidden', 'true');

      const closeBtn = document.createElement('button');
      closeBtn.className = 'terminal-tab-close';
      closeBtn.setAttribute('aria-label', 'Close');
      closeBtn.textContent = '×';

      const splitIndicator = document.createElement('span');
      splitIndicator.className = 'terminal-tab-split';

      const shortcutEl = document.createElement('span');
      shortcutEl.className = 'terminal-tab-shortcut';

      tabEl.appendChild(statusDotEl);
      tabEl.appendChild(titleEl);
      tabEl.appendChild(wslBadgeEl);
      tabEl.appendChild(splitIndicator);
      tabEl.appendChild(shortcutEl);
      tabEl.appendChild(closeBtn);
      if (insertBeforeEl && insertBeforeEl.parentNode === tabsBar) {
        tabsBar.insertBefore(tabEl, insertBeforeEl);
      } else {
        tabsBar.insertBefore(tabEl, addBtn);
      }

      tabEl.addEventListener('click', () => {
        if (dragState.suppressClick) {
          dragState.suppressClick = false;
          return;
        }
        activateTab(tabId);
      });
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(tabId);
      });
      tabEl.addEventListener('pointerdown', (e) => {
        if (e.button === 1) {
          if (e.target?.closest?.('.terminal-tab-rename')) return;
          e.preventDefault();
          e.stopPropagation();
          closeTab(tabId);
          return;
        }
        if (e.button !== 0) return;
        if (e.target?.closest?.('.terminal-tab-close')) return;
        if (e.target?.closest?.('.terminal-tab-rename')) return;
        activateTab(tabId);
        if (beginPointerDrag(tabId, tabEl, e)) {
          e.preventDefault();
        }
      });

      const tab = {
        tabId,
        container,
        tabEl,
        titleEl,
        statusDotEl,
        wslBadgeEl,
        shortcutEl,
        splitIndicatorEl: splitIndicator,
        paneRoot,
        panes: new Map(),
        paneCounter: 0,
        paneTree: null,
        activePaneId: null,
        customTitle: customTitle ? titleEl.textContent : null,
        autoTitle: titleEl.textContent,
        isEditing: false,
        index: tabCounter,
        resizeRaf: null,
        lastCompletedAt: 0,
        lastViewedAt: 0,
      };

      tabs.set(tabId, tab);

      if (paneLayout && Array.isArray(panePayloads) && panePayloads.length > 0) {
        for (const panePayload of panePayloads) {
          const allowPrefill = !restoreSession || restorePrefillEnabled;
          await createPane(tab, {
            paneId: panePayload.paneId,
            attachExisting,
            snapshot: allowPrefill ? panePayload.snapshot : null,
            title: panePayload.title || titleEl.textContent,
            startCwd: panePayload.cwd || null,
            profileId: panePayload.profileId || profileId,
            prefillLabel: allowPrefill && restoreSession ? '--- Restored snapshot ---' : null,
            deferPtyStart,
            initialSettings: effectiveInitialSettings,
            deferXtermOpen,
          });
        }
        tab.paneTree = paneLayout;
        tab.activePaneId = (providedActivePaneId && tab.panes.has(providedActivePaneId))
          ? providedActivePaneId
          : panePayloads[0].paneId;
        renderPaneTree(tab);
        setActivePane(tab, tab.activePaneId);
      } else {
        const allowPrefill = !restoreSession || restorePrefillEnabled;
        const firstPane = await createPane(tab, {
          attachExisting,
          snapshot: allowPrefill ? snapshot : null,
          title: titleEl.textContent,
          startCwd: startCwd || null,
          profileId,
          prefillLabel: allowPrefill && restoreSession ? '--- Restored snapshot ---' : null,
          deferPtyStart,
          initialSettings: effectiveInitialSettings,
          deferXtermOpen,
        });
        tab.paneTree = buildPaneNode(firstPane.paneId);
        tab.activePaneId = firstPane.paneId;
        renderPaneTree(tab);
        setActivePane(tab, firstPane.paneId);
      }

      if (customTitle) {
        tabEl.classList.add('custom');
      }

      syncTabStatusIndicator(tab);

      if (activate) {
        activateTab(tabId);
      }

      if (initialTabTimer) {
        clearTimeout(initialTabTimer);
        initialTabTimer = null;
      }

      // タブ追加後にレイアウト更新（スクロールボタン、narrowクラス）
      requestAnimationFrame(() => {
        updateTabsLayout();
        updateTabShortcuts();
      });
      return tabId;
    } finally {
      isCreating = false;
    }
  };

  const removeTab = async (tabId, { keepPty = false } = {}) => {
    const tab = tabs.get(tabId);
    if (!tab) return;

    historyManager?.handleTabClose?.(tabId, Array.from(tab.panes.keys()));

    const ordered = getOrderedTabIds();
    const index = ordered.indexOf(tabId);
    const nextId = ordered[index + 1] || ordered[index - 1];

    if (!keepPty) {
      for (const pane of tab.panes.values()) {
        const pid = pane?.paneId;
        if (!pid) continue;
        window.statusAPI?.sendPaneEvent?.({
          pane_id: pid,
          tab_id: tab.tabId,
          event: 'close',
          timestamp: Date.now(),
        });
      }
      for (const pane of tab.panes.values()) {
        await window.terminalAPI.close(pane.paneId);
      }
    }
    tab.panes.forEach((pane) => {
      pane.terminalManager.destroy?.();
      pane.imagePreviewDisposable?.dispose?.();
      pane.mdPreviewDisposable?.dispose?.();
    });
    tab.container.remove();

    // タブ閉じるアニメーション
    const tabEl = tab.tabEl;
    tabEl.classList.add('closing');
    tabs.delete(tabId);
    pinManager?.removeTab?.(tabId);

    // アクティブタブの切り替えを先に行う
    if (activeTabId === tabId && nextId) {
      activateTab(nextId);
    }

    // アニメーション完了後にDOM削除
    let removed = false;
    const onAnimationEnd = () => {
      if (removed) return;
      removed = true;
      tabEl.remove();
      // タブ削除後にレイアウト更新
      updateTabsLayout();
      updateTabShortcuts();
    };
    tabEl.addEventListener('transitionend', onAnimationEnd, { once: true });
    // フォールバック: transitionendが発火しない場合
    setTimeout(onAnimationEnd, 180);

    if (tabs.size === 0) {
      window.windowAPI?.close?.();
      return;
    }
  };

  const closeTab = async (tabId) => removeTab(tabId, { keepPty: false });
  const detachTab = async (tabId, options = {}) => removeTab(tabId, { keepPty: true, ...options });

  // 他のタブを全て閉じる
  const closeOtherTabs = async (tabId) => {
    const ordered = getOrderedTabIds();
    for (const id of ordered) {
      if (id !== tabId) {
        await closeTab(id);
      }
    }
  };

  // 右側のタブを全て閉じる
  const closeTabsToRight = async (tabId) => {
    const ordered = getOrderedTabIds();
    const index = ordered.indexOf(tabId);
    if (index === -1) return;
    for (let i = ordered.length - 1; i > index; i--) {
      await closeTab(ordered[i]);
    }
  };

  const importTab = async (payload, { insertBeforeEl } = {}) => {
    if (!payload?.tabId) return null;
    if (tabs.has(payload.tabId)) {
      activateTab(payload.tabId);
      return payload.tabId;
    }
    const paneLayout = normalizePaneLayout(payload.splitLayout);
    const panePayloads = Array.isArray(payload.panes) ? payload.panes : null;
    return await createTab({
      tabId: payload.tabId,
      activate: true,
      attachExisting: true,
      title: payload.title,
      customTitle: Boolean(payload.customTitle),
      snapshot: payload.snapshot,
      insertBeforeEl,
      paneLayout,
      panes: panePayloads,
      activePaneId: payload.activePaneId,
    });
  };

  const consumeDropInsertBeforeEl = () => {
    const el = dragState.lastDropBeforeEl;
    dragState.lastDropBeforeEl = null;
    if (!el || !tabsBar.contains(el)) return null;
    return el;
  };

  const newTab = ({ profileId = null, title, insertBeforeEl, startCwd: requestedCwd } = {}) => {
    const startCwd = requestedCwd || getStartCwdForNewTab(profileId);
    return createTab({
      activate: true,
      title,
      startCwd,
      profileId,
      insertBeforeEl,
      initialSettings: settingsSnapshot,
    });
  };
  const closeActiveTab = () => {
    if (activeTabId) {
      closeTab(activeTabId);
    }
  };
  const nextTab = () => {
    const ordered = getOrderedTabIds();
    if (ordered.length < 2) return;
    const index = ordered.indexOf(activeTabId);
    const nextId = ordered[(index + 1) % ordered.length];
    activateTab(nextId);
  };
  const previousTab = () => {
    const ordered = getOrderedTabIds();
    if (ordered.length < 2) return;
    const index = ordered.indexOf(activeTabId);
    const prevId = ordered[(index - 1 + ordered.length) % ordered.length];
    activateTab(prevId);
  };
  const goToNotifiedTab = () => {
    return false;
  };

  const buildTabSnapshot = (predicate) => {
    const ordered = getOrderedTabIds();
    const result = [];
    for (const tabId of ordered) {
      const tab = tabs.get(tabId);
      if (!tab) continue;
      const isNotified = false;
      const isCurrent = tabId === activeTabId;
      if (predicate && !predicate({ isNotified, isCurrent })) continue;
      const title = tab.customTitle || tab.autoTitle || `Terminal ${tab.index}`;
      const activePane = tab.panes.get(tab.activePaneId);
      const previewHtml = activePane?.terminalManager.getPreviewHtml?.(200) || null;
      result.push({ tabId, title, previewHtml, isNotified, isCurrent });
    }
    return result;
  };

  // 通知タブ一覧を取得（スイッチャー用）- アクティブタブも含む
  const getNotifiedTabs = () => buildTabSnapshot(({ isNotified, isCurrent }) => isNotified || isCurrent);

  // 全タブ一覧を取得（スイッチャー用）
  const getAllTabs = () => buildTabSnapshot(() => true);

  const getActiveTab = () => tabs.get(activeTabId) || null;

  const blinkTab = (tabId) => {
    if (!tabId) return;
    const tab = tabs.get(tabId);
    if (!tab?.tabEl) return;
    tab.tabEl.classList.remove('is-resume-blink');
    void tab.tabEl.offsetWidth;
    tab.tabEl.classList.add('is-resume-blink');
    setTimeout(() => tab.tabEl.classList.remove('is-resume-blink'), 1200);
  };

  const blinkActiveTab = () => blinkTab(activeTabId);

  const hidePaneToast = (pane) => {
    if (!pane?.toastEl) return;
    if (pane.toastTimer) {
      clearTimeout(pane.toastTimer);
      pane.toastTimer = null;
    }
    pane.toastEl.classList.remove('show', 'error', 'persistent');
  };

  const ensureToastLayout = (pane) => {
    const toastEl = pane?.toastEl;
    if (!toastEl) return null;
    if (toastEl._ktLayout) return toastEl._ktLayout;
    toastEl.innerHTML = '';
    const textEl = document.createElement('div');
    textEl.className = 'terminal-toast-text';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'terminal-toast-close';
    closeBtn.type = 'button';
    closeBtn.textContent = 'x';
    closeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      hidePaneToast(pane);
    });
    toastEl.appendChild(textEl);
    toastEl.appendChild(closeBtn);
    toastEl._ktLayout = { textEl, closeBtn };
    return toastEl._ktLayout;
  };

  const showPaneToast = (pane, message, { tone, persistent } = {}) => {
    if (!pane?.toastEl) return false;
    const text = String(message || '').trim();
    if (!text) return false;
    const layout = ensureToastLayout(pane);
    if (!layout) return false;
    const toastEl = pane.toastEl;
    if (pane.toastTimer) {
      clearTimeout(pane.toastTimer);
      pane.toastTimer = null;
    }
    layout.textEl.textContent = text;
    const isPersistent = Boolean(persistent);
    toastEl.classList.toggle('error', tone === 'error');
    toastEl.classList.toggle('persistent', isPersistent);
    toastEl.classList.add('show');
    if (!isPersistent) {
      pane.toastTimer = setTimeout(() => {
        toastEl.classList.remove('show');
        pane.toastTimer = null;
      }, TERMINAL_TOAST_DURATION_MS);
    }
    return true;
  };

  const showActivePaneToast = (message, { tone, persistent } = {}) => {
    const tab = getActiveTab();
    const pane = tab?.activePaneId ? tab.panes.get(tab.activePaneId) : null;
    return showPaneToast(pane, message, { tone, persistent });
  };

  const showTabPaneToast = (tabId, message, { tone, persistent } = {}) => {
    if (!tabId) return false;
    const tab = tabs.get(tabId);
    if (!tab) return false;
    const pane = tab.activePaneId
      ? tab.panes.get(tab.activePaneId)
      : Array.from(tab.panes.values())[0];
    return showPaneToast(pane, message, { tone, persistent });
  };

  const activatePaneAtPoint = (clientX, clientY) => {
    const el = document.elementFromPoint(clientX, clientY);
    const paneEl = el?.closest?.('.terminal-pane');
    if (!paneEl) return;
    const tab = getActiveTab();
    if (!tab) return;
    const paneId = paneEl.dataset.paneId;
    if (paneId && tab.panes.has(paneId)) {
      setActivePane(tab, paneId);
    }
  };

  const canSplitActivePane = (direction) => {
    const tab = getActiveTab();
    if (!tab) return false;
    const paneId = tab.activePaneId;
    return canSplitPane(tab, paneId, direction);
  };

  const splitActivePane = async (direction, side = 'after') => {
    const tab = getActiveTab();
    if (!tab) return null;
    const paneId = tab.activePaneId;
    return await splitPane(tab, paneId, direction, side);
  };

  const canCloseActivePane = () => {
    const tab = getActiveTab();
    if (!tab) return false;
    return (tab.panes?.size || 0) > 0;
  };

  const closeActivePane = async () => {
    const tab = getActiveTab();
    if (!tab) return;
    const paneId = tab.activePaneId;
    if (!paneId) return;
    await closePane(tab, paneId);
  };

  let settingsListener = null;
  const updateSettingsAll = (settings) => {
    tabs.forEach(tab => {
      tab.panes.forEach(pane => pane.terminalManager.updateSettings(settings));
    });
    const snapshot = mergeTerminalSettings(settingsSnapshot, settings);
    settingsSnapshot = snapshot;
    if (settingsListener) {
      settingsListener(snapshot);
    }
    if (window.settingsAPI?.update) {
      window.settingsAPI.update({ terminal: snapshot });
    }
  };
  const getSettings = () => getActiveTerminal()?.getSettings() || settingsSnapshot || DEFAULT_TERMINAL_SETTINGS;

  addBtn.addEventListener('click', () => newTab());

  if (profileBtn && profileMenu) {
    const PROFILE_CACHE_MS = 3000;
    const profileState = { profiles: [], fetchedAt: 0, pending: null };
    profileBtn.classList.add('hidden');
    profileBtn.disabled = true;

    const normalizeProfiles = (profiles) => {
      const list = Array.isArray(profiles) ? profiles : [];
      return list.map((profile) => {
        const id = typeof profile?.id === 'string' ? profile.id.trim() : '';
        if (!id) return null;
        const label = typeof profile?.label === 'string' ? profile.label.trim() : '';
        return {
          id,
          label: label || id,
          isDefault: Boolean(profile?.isDefault),
        };
      }).filter(Boolean);
    };

    const loadProfiles = async (force = false) => {
      if (!window.terminalAPI?.listProfiles) return [];
      const now = Date.now();
      if (!force && profileState.profiles.length && now - profileState.fetchedAt < PROFILE_CACHE_MS) {
        return profileState.profiles;
      }
      if (profileState.pending) return profileState.pending;
      profileState.pending = (async () => {
        try {
          const result = await window.terminalAPI.listProfiles();
          return normalizeProfiles(result?.profiles);
        } catch (_) {
          return [];
        }
      })();
      const profiles = await profileState.pending;
      profileState.pending = null;
      profileState.profiles = profiles;
      profileState.fetchedAt = Date.now();
      return profiles;
    };

    const setProfileButtonState = (profiles) => {
      const show = Array.isArray(profiles) && profiles.length > 1;
      profileBtn.classList.toggle('hidden', !show);
      profileBtn.disabled = !show;
    };

    const hideProfileMenu = () => {
      profileMenu.classList.remove('show');
    };

    const buildProfileMenu = (profiles) => {
      profileMenu.innerHTML = '';
      for (const profile of profiles) {
        const item = document.createElement('div');
        item.className = 'tab-menu-item';
        item.textContent = profile.label || profile.id;
        item.dataset.profileId = profile.id;
        item.dataset.profileLabel = profile.label || profile.id;
        item.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          hideProfileMenu();
          newTab({
            profileId: item.dataset.profileId,
            title: item.dataset.profileLabel,
          });
        });
        profileMenu.appendChild(item);
      }
    };

    const showProfileMenu = async () => {
      const profiles = await loadProfiles(true);
      setProfileButtonState(profiles);
      if (!profiles || profiles.length <= 1) return;
      buildProfileMenu(profiles);
      profileMenu.classList.add('show');
      const rect = profileMenu.getBoundingClientRect();
      const buttonRect = profileBtn.getBoundingClientRect();
      let left = buttonRect.right - rect.width;
      left = Math.min(left, window.innerWidth - rect.width - 8);
      left = Math.max(8, left);
      let top = buttonRect.bottom + 6;
      top = Math.min(top, window.innerHeight - rect.height - 8);
      top = Math.max(8, top);
      profileMenu.style.left = `${left}px`;
      profileMenu.style.top = `${top}px`;
    };

    const toggleProfileMenu = async () => {
      if (profileMenu.classList.contains('show')) {
        hideProfileMenu();
        return;
      }
      await showProfileMenu();
    };

    profileBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void toggleProfileMenu();
    });

    document.addEventListener('click', (event) => {
      if (profileMenu.contains(event.target) || event.target === profileBtn) return;
      hideProfileMenu();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hideProfileMenu();
      }
    });

    void loadProfiles(true).then(setProfileButtonState).catch(() => setProfileButtonState([]));
  }

  if (tabMenu) {
      const renameItem = tabMenu.querySelector('[data-action="rename"]');
    const resetItem = tabMenu.querySelector('[data-action="reset"]');
    const closeItem = tabMenu.querySelector('[data-action="close"]');
    let menuTabId = null;

    const hideMenu = () => tabMenu.classList.remove('show');

    const showMenu = (x, y) => {
      tabMenu.classList.add('show');
      const rect = tabMenu.getBoundingClientRect();
      const left = Math.min(x, window.innerWidth - rect.width - 8);
      const top = Math.min(y, window.innerHeight - rect.height - 8);
      tabMenu.style.left = `${Math.max(8, left)}px`;
      tabMenu.style.top = `${Math.max(8, top)}px`;
    };

    tabsBar.addEventListener('contextmenu', (e) => {
      const tabEl = e.target.closest('.terminal-tab');
      if (!tabEl) return;
      e.preventDefault();
      menuTabId = tabEl.dataset.tabId;
      const tab = tabs.get(menuTabId);
      resetItem?.classList.toggle('disabled', !tab?.customTitle);
      showMenu(e.clientX, e.clientY);
    });

    document.addEventListener('click', () => hideMenu());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        hideMenu();
      }
    });

    renameItem?.addEventListener('click', () => {
      if (menuTabId) {
        startRename(menuTabId);
      }
      hideMenu();
    });

    resetItem?.addEventListener('click', () => {
      const tab = tabs.get(menuTabId);
      if (tab && tab.customTitle) {
        tab.customTitle = null;
        tab.titleEl.textContent = tab.autoTitle || `Terminal ${tab.index}`;
        tab.tabEl.classList.remove('custom');
      }
      hideMenu();
    });

    closeItem?.addEventListener('click', () => {
      if (menuTabId) {
        closeTab(menuTabId);
      }
      hideMenu();
    });

    // 他のタブを閉じる
    const closeOthersItem = tabMenu.querySelector('[data-action="close-others"]');
    closeOthersItem?.addEventListener('click', () => {
      if (menuTabId) {
        closeOtherTabs(menuTabId);
      }
      hideMenu();
    });

    // 右側のタブを閉じる
    const closeRightItem = tabMenu.querySelector('[data-action="close-right"]');
    closeRightItem?.addEventListener('click', () => {
      if (menuTabId) {
        closeTabsToRight(menuTabId);
      }
      hideMenu();
    });
  }

  const exportSessionState = () => {
    const ordered = getOrderedTabIds();
    const tabsOut = [];
    for (const tabId of ordered) {
      const tab = tabs.get(tabId);
      if (!tab) continue;
        const panesOut = Array.from(tab.panes.values()).map((pane) => ({
          paneId: pane.paneId,
          title: pane.titleEl?.textContent || 'Terminal',
          cwd: pane.terminalManager.getCwd?.() || null,
          profileId: pane.profileId || pane.terminalManager?.profileId || null,
        }));
      tabsOut.push({
        tabId: tab.tabId,
        title: tab.titleEl?.textContent || `Terminal ${tab.index}`,
        customTitle: Boolean(tab.customTitle),
        activePaneId: tab.activePaneId || null,
        paneLayout: tab.paneTree || null,
        panes: panesOut,
      });
    }
    return { activeTabId: activeTabId || null, tabs: tabsOut };
  };

  const hashString = (text) => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  };

  const collectDirtySnapshots = ({ maxLines, maxChars } = {}) => {
    const lines = Number.isFinite(maxLines) ? Math.max(1, maxLines) : 500;
    const chars = Number.isFinite(maxChars) ? Math.max(1, maxChars) : 200_000;
    const result = [];
    for (const tab of tabs.values()) {
      if (!tab) continue;
      for (const pane of tab.panes.values()) {
        if (!pane?.sessionSnapshotDirty) continue;
        pane.sessionSnapshotDirty = false;
        const content = pane.terminalManager.getScreenContent?.({ maxLines: lines, maxChars: chars }) || '';
        if (!content) continue;
        const nextHash = hashString(content);
        if (nextHash === pane.sessionSnapshotHash) continue;
        pane.sessionSnapshotHash = nextHash;
        result.push({ paneId: pane.paneId, content });
      }
    }
    return result;
  };

  const initialSession = options?.initialSession || null;
  const startupCwd = typeof options?.startupCwd === 'string' ? options.startupCwd.trim() : '';
  const shouldRestore = Boolean(options?.restoreSession)
    && Array.isArray(initialSession?.tabs)
    && initialSession.tabs.length > 0;

  if (shouldRestore) {
    const deferPtyStart = Boolean(options?.deferPtyStart);
    const initialSettings = options?.initialTerminalSettings || null;
    const candidate = initialSession.activeTabId;
    const primaryTabId = (candidate && initialSession.tabs.some(t => t?.tabId === candidate))
      ? candidate
      : initialSession.tabs[0]?.tabId;
    for (const tabPayload of initialSession.tabs) {
      if (!tabPayload?.tabId) continue;
      const paneLayout = tabPayload.paneLayout || null;
      const panePayloads = Array.isArray(tabPayload.panes) ? tabPayload.panes : null;
      await createTab({
        tabId: tabPayload.tabId,
        activate: false,
        attachExisting: false,
        title: tabPayload.title,
        customTitle: Boolean(tabPayload.customTitle),
        restoreSession: true,
        paneLayout,
        panes: panePayloads,
        activePaneId: tabPayload.activePaneId,
        snapshot: tabPayload.snapshot,
        deferPtyStart,
        initialSettings,
        deferXtermOpen: tabPayload.tabId !== primaryTabId,
      });
    }
    const toActivate = primaryTabId && tabs.has(primaryTabId)
      ? primaryTabId
      : initialSession.tabs[0]?.tabId;
    if (toActivate) {
      activateTab(toActivate);
    }
  } else if (waitForAdopt) {
    initialTabTimer = setTimeout(() => {
      if (tabs.size === 0) {
        createTab({
          activate: true,
          startCwd: startupCwd || null,
          deferPtyStart: Boolean(options?.deferPtyStart),
          initialSettings: options?.initialTerminalSettings || null,
        });
      }
    }, 1200);
  } else {
    await createTab({
      activate: true,
      startCwd: startupCwd || null,
      deferPtyStart: Boolean(options?.deferPtyStart),
      initialSettings: options?.initialTerminalSettings || null,
    });
  }

  tabManager = {
    newTab,
    closeActiveTab,
    nextTab,
    previousTab,
    goToNotifiedTab,
    getNotifiedTabs,
    getAllTabs,
    getActiveTab,
    blinkActiveTab,
    showActivePaneToast,
    showTabPaneToast,
    activateTab,
    activatePaneById,
    detachTab,
    importTab,
    consumeDropInsertBeforeEl,
    splitActivePane,
    closeActivePane,
    canSplitActivePane,
    canCloseActivePane,
    activatePaneAtPoint,
    focusPaneByDirection,
    hasTab: (tabId) => tabs.has(tabId),
    getOrderedTabIds,
    exportSessionState,
    collectDirtySnapshots,
    updateSettingsAll,
    getSettings,
    getActiveTerminal,
    launchCommandInNewTab,
    warmupHistoryWsl: warmupWslForHistory,
    updateTabShortcuts,
    syncTabStatusIndicators: syncAllTabStatusIndicators,
    setSettingsListener: (listener) => {
      settingsListener = listener;
    },
  };
  return tabManager;
}

  window.TerminalTabs = {
    initTerminalTabs,
  };
})();
