const { BrowserWindow } = require('electron');

function broadcastToAllWindows(channel, payload) {
  const windows = BrowserWindow.getAllWindows();
  windows.forEach((win) => {
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send(channel, payload);
    } catch (_) {
      // ignore
    }
  });
}

function buildEmptySnapshot(source = '') {
  const safeSource = String(source || '').trim().toLowerCase() || 'all';
  return {
    version: 1,
    generated_at: Date.now(),
    source: safeSource,
    sessions: [],
    meta: {
      source: safeSource,
      file_count: 0,
      latest_mtime: 0,
      latest_size: 0,
      signature: '',
    },
    has_more: false,
    next_cursor: null,
  };
}

function registerHistoryIpc({
  ipcMain,
  historySyncService,
  getHistorySyncService,
  waitForHistorySyncService,
  isTrustedIpcSender,
} = {}) {
  if (!ipcMain) return { bind: () => {} };

  let boundService = null;
  const deltaListener = (payload) => broadcastToAllWindows('history:delta', payload);
  const invalidateListener = (payload) => broadcastToAllWindows('history:invalidate', payload);

  const resolveService = () => {
    if (historySyncService) return historySyncService;
    if (typeof getHistorySyncService === 'function') return getHistorySyncService();
    return null;
  };

  const bind = (service) => {
    if (!service) return;
    if (boundService && boundService !== service) {
      boundService.removeListener('delta', deltaListener);
      boundService.removeListener('invalidate', invalidateListener);
    }
    boundService = service;
    boundService.on('delta', deltaListener);
    boundService.on('invalidate', invalidateListener);
  };

  ipcMain.handle('history:snapshot', async (event, payload = {}) => {
    if (!isTrustedIpcSender?.(event)) return buildEmptySnapshot(payload?.source);
    let service = resolveService();
    if (!service?.getSnapshot && typeof waitForHistorySyncService === 'function') {
      try {
        service = await waitForHistorySyncService();
      } catch (_) {
        service = null;
      }
    }
    if (!service?.getSnapshot) return buildEmptySnapshot(payload?.source);
    const source = payload?.source;
    const limit = payload?.limit;
    try {
      return await service.getSnapshot({ source, limit });
    } catch (_) {
      return buildEmptySnapshot(source);
    }
  });

  ipcMain.on('history:ack', (event, payload = {}) => {
    if (!isTrustedIpcSender?.(event)) return;
    const service = resolveService();
    service?.handleAck?.(payload);
  });

  if (historySyncService) {
    bind(historySyncService);
  }

  return { bind };
}

module.exports = {
  registerHistoryIpc,
};
