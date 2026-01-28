(function () {
  'use strict';

  const pendingAdopts = [];
  const pendingTransfers = [];
  let tabManager = null;
  let windowId = 'win';
  let initialized = false;

  const resolveSourceWindowId = (payload) => {
    if (!payload) return null;
    return payload.sourceWindowId || payload.windowId || null;
  };

  const handleAdoptTab = async (payload) => {
    if (!payload?.tabId) return;
    if (!tabManager) {
      pendingAdopts.push(payload);
      return;
    }

    if (tabManager.hasTab?.(payload.tabId)) {
      tabManager.activateTab(payload.tabId);
    } else {
      const insertBeforeEl = tabManager.consumeDropInsertBeforeEl?.();
      await tabManager.importTab(payload, { insertBeforeEl });
    }
    const sourceWindowId = resolveSourceWindowId(payload);
    if (sourceWindowId && String(sourceWindowId) !== String(windowId)) {
      window.windowAPI?.notifyTabTransferred?.(sourceWindowId, payload.tabId);
    }
  };

  const handleTabTransferred = (payload) => {
    if (!payload?.tabId) return;
    if (!tabManager) {
      pendingTransfers.push(payload);
      return;
    }
    tabManager.detachTab?.(payload.tabId, { closeWindowOnEmpty: true });
  };

  const handleTabDropAccepted = (payload) => {
    if (!payload?.tabId) return;
  };

  const flushPending = async () => {
    while (pendingAdopts.length) {
      await handleAdoptTab(pendingAdopts.shift());
    }
    while (pendingTransfers.length) {
      handleTabTransferred(pendingTransfers.shift());
    }
  };

  const init = ({ windowId: nextWindowId } = {}) => {
    if (initialized) return;
    initialized = true;
    if (typeof nextWindowId === 'string' && nextWindowId.trim()) {
      windowId = nextWindowId.trim();
    }
    window.windowAPI?.onAdoptTab?.(handleAdoptTab);
    window.windowAPI?.onTabTransferred?.(handleTabTransferred);
    window.windowAPI?.onTabDropAccepted?.(handleTabDropAccepted);
  };

  const setTabManager = (nextTabManager) => {
    tabManager = nextTabManager || null;
    void flushPending();
  };

  window.TabTransfer = {
    init,
    setTabManager,
  };
})();
