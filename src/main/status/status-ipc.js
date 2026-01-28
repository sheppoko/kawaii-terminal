const { BrowserWindow } = require('electron');

function extractTabIdFromPaneId(paneId) {
  const raw = String(paneId || '').trim();
  if (!raw.startsWith('pane-')) return '';
  const lastDash = raw.lastIndexOf('-');
  if (lastDash <= 5) return '';
  return raw.slice(5, lastDash);
}

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

function registerStatusIpc({ ipcMain, statusService, tabRegistry, isTrustedIpcSender, codexCommandSource, paneLifecycleSource } = {}) {
  if (!ipcMain || !statusService) return;

  ipcMain.handle('status:snapshot', (event) => {
    if (!isTrustedIpcSender?.(event)) {
      return { version: 1, generated_at: Date.now(), entries: [] };
    }
    return statusService.snapshot();
  });

  ipcMain.on('status:command', (event, payload = {}) => {
    if (!isTrustedIpcSender?.(event)) return;
    const paneId = String(payload.pane_id || '').trim();
    const command = typeof payload.command === 'string' ? payload.command : '';
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
    const tabId = String(payload.tab_id || '').trim() || extractTabIdFromPaneId(paneId);
    if (tabId) {
      const mapped = tabRegistry?.getWebContentsId?.(tabId);
      if (mapped && mapped !== event.sender.id) return;
    }
    codexCommandSource?.handleCommand?.({ paneId, command, cwd });
  });

  ipcMain.on('status:pane', (event, payload = {}) => {
    if (!isTrustedIpcSender?.(event)) return;
    const paneId = String(payload.pane_id || '').trim();
    const tabId = String(payload.tab_id || '').trim() || extractTabIdFromPaneId(paneId);
    if (tabId) {
      const mapped = tabRegistry?.getWebContentsId?.(tabId);
      if (mapped && mapped !== event.sender.id) return;
    }
    const action = String(payload.event || '').trim().toLowerCase();
    const timestamp = payload.timestamp ? payload.timestamp : Date.now();
    if (action === 'close') {
      paneLifecycleSource?.handlePaneClose?.({ paneId, timestamp });
      return;
    }
    if (action === 'open') {
      paneLifecycleSource?.handlePaneOpen?.({ paneId, timestamp });
      return;
    }
    if (action === 'prompt' || action === 'cwd') {
      paneLifecycleSource?.handlePromptReturn?.({ paneId, timestamp });
      return;
    }
  });

  statusService.on('update', (payload) => {
    broadcastToAllWindows('status:update', payload);
  });
}

module.exports = {
  registerStatusIpc,
  extractTabIdFromPaneId,
};
