const { webContents } = require('electron');

function registerSettingsIpc({ ipcMain, settingsStore, isTrustedIpcSender } = {}) {
  if (!ipcMain || !settingsStore) return () => {};

  const broadcastChange = (payload) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      contents.send('settings:changed', payload);
    }
  };

  settingsStore.on('change', broadcastChange);

  ipcMain.handle('settings:get', (event) => {
    if (!isTrustedIpcSender?.(event)) return null;
    return settingsStore.get();
  });

  ipcMain.handle('settings:update', (event, patch = {}) => {
    if (!isTrustedIpcSender?.(event)) {
      return { ok: false, error: 'Untrusted sender' };
    }
    return settingsStore.update(patch, { source: 'ipc' });
  });

  return () => {
    settingsStore.off('change', broadcastChange);
    ipcMain.removeHandler('settings:get');
    ipcMain.removeHandler('settings:update');
  };
}

module.exports = {
  registerSettingsIpc,
};
