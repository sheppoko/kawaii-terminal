class PaneLifecycleSource {
  constructor({ statusService, codexCommandSource } = {}) {
    this.statusService = statusService || null;
    this.codexCommandSource = codexCommandSource || null;
  }

  handlePaneClose({ paneId } = {}) {
    const pid = String(paneId || '').trim();
    if (!pid) return;
    this.statusService?.removeSessionsForPane?.(pid);
    this.codexCommandSource?.clearPendingForPane?.(pid);
  }

  handlePromptReturn({ paneId } = {}) {
    const pid = String(paneId || '').trim();
    if (!pid) return;
    this.statusService?.removeSessionsForPane?.(pid);
    this.codexCommandSource?.clearPendingForPane?.(pid);
  }

  handlePaneOpen() {
    // reserved for future use
  }
}

module.exports = { PaneLifecycleSource };
