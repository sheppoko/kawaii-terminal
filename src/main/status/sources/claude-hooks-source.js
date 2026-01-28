const { buildSessionKey } = require('../status-service');

class ClaudeHooksSource {
  constructor({ statusService } = {}) {
    this.statusService = statusService || null;
  }

  handleNotifyEvent(payload) {
    if (!payload || typeof payload !== 'object') return;
    const source = String(payload.source || '').trim().toLowerCase();
    if (source !== 'claude') return;
    const status = String(payload.event || '').trim().toLowerCase();
    const sessionId = String(payload.session_id || '').trim();
    const paneId = String(payload.pane_id || '').trim();
    const hook = String(payload.hook || '').trim();
    const timestamp = payload.timestamp || null;
    if (!sessionId || !status) return;
    this.statusService?.applyObservation?.({
      source,
      session_id: sessionId,
      status,
      pane_id: paneId,
      hook,
      timestamp,
    });
    if (hook === 'SessionEnd' && sessionId) {
      const sessionKey = buildSessionKey(source, sessionId);
      if (sessionKey) {
        this.statusService?.removeSession?.(sessionKey);
      } else if (paneId) {
        this.statusService?.removeSessionsForPane?.(paneId);
      }
    }
  }
}

module.exports = { ClaudeHooksSource };
