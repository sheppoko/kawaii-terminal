(function () {
  'use strict';

  function updateSidebarAgo(manager) {
    if (!manager?.store || document.hidden) return;
    const updateContainer = (root) => {
      if (!root) return;
      const items = root.querySelectorAll('.session-item');
      if (!items.length) return;
      items.forEach((item) => {
        const ts = Number(item.dataset.timestamp || '');
        if (!Number.isFinite(ts)) return;
        const agoEl = item.querySelector('.session-item-ago')
          || item.querySelector('.session-item-toggle-ago');
        if (!agoEl) return;
        const next = manager.store.formatAgo(ts);
        if (agoEl.textContent !== next) {
          agoEl.textContent = next;
        }
      });
    };
    updateContainer(document.getElementById('session-group-list'));
    updateContainer(document.getElementById('active-session-group-list'));
    updateContainer(manager.searchUI?.getListElement?.());
  }

  function startSessionTimeTicker(manager) {
    if (!manager || manager.sessionTimeInterval) return;
    manager.sessionTimeInterval = setInterval(() => {
      updateSidebarAgo(manager);
    }, 60000);
  }

  function scheduleRender(manager) {
    if (!manager) return;
    if (manager.renderPending) {
      manager.renderQueued = true;
      return;
    }
    if (!manager.sidebarDirty) return;
    manager.renderPending = true;
    requestAnimationFrame(() => {
      manager.renderPending = false;
      if (manager.sidebarDirty) renderSidebar(manager);
      if (manager.renderQueued) {
        manager.renderQueued = false;
        scheduleRender(manager);
      }
    });
  }

  function renderSidebar(manager) {
    if (!manager?.sidebarUI && !manager?.activeSidebarUI) return;
    manager.sidebarDirty = false;
    manager.sidebarUI?.renderSidebar?.({ loadingSessions: manager.loadingSessions });
    manager.activeSidebarUI?.renderSidebar?.({ loadingSessions: manager.loadingSessions });
  }

  function showHistoryToast(manager, message, { tone } = {}) {
    if (!manager) return;
    if (manager.sidebarUI?.showHistoryToast) {
      manager.sidebarUI.showHistoryToast(message, { tone });
      return;
    }
    const toastEl = document.getElementById('terminal-preview-toast');
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.toggle('error', tone === 'error');
    toastEl.classList.add('show');
    setTimeout(() => {
      toastEl.classList.remove('show');
    }, manager.HISTORY_TOAST_DURATION_MS || 3000);
  }

  window.HistoryManagerUI = {
    updateSidebarAgo,
    startSessionTimeTicker,
    scheduleRender,
    renderSidebar,
    showHistoryToast,
  };
})();
