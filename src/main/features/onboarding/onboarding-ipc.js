const { getOnboardingStatus } = require('./onboarding-service');

function registerOnboardingIpc({ ipcMain, isTrustedIpcSender } = {}) {
  if (!ipcMain) return () => {};

  ipcMain.handle('onboarding:status', async (event) => {
    if (!isTrustedIpcSender?.(event)) return null;
    return getOnboardingStatus();
  });

  return () => {
    ipcMain.removeHandler('onboarding:status');
  };
}

module.exports = {
  registerOnboardingIpc,
};
