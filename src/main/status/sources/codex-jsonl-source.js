const { buildSessionKey } = require('../status-service');

class CodexJsonlStatusSource {
  constructor({ statusService, codexCommandSource } = {}) {
    this.statusService = statusService || null;
    this.codexCommandSource = codexCommandSource || null;
  }

  normalizeActivityAt(value) {
    if (value == null) return 0;
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value > 0 && value < 1e12) return Math.round(value * 1000);
      return Math.round(value);
    }
    const raw = String(value || '').trim();
    if (!raw) return 0;
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      if (numeric > 0 && numeric < 1e12) return Math.round(numeric * 1000);
      return Math.round(numeric);
    }
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  inferStatusFromSummary(session) {
    if (!session || typeof session !== 'object') return '';
    const hint = String(session.status_hint || '').trim().toLowerCase();
    if (hint === 'working' || hint === 'waiting_user' || hint === 'completed') {
      return hint;
    }
    return '';
  }

  maybeBindFromIndexEntry(entry, { activityAt } = {}) {
    if (!entry || typeof entry !== 'object') return false;
    const sessionId = String(entry.sessionId || entry.session_id || '').trim();
    if (!sessionId) return false;
    const sessionKey = buildSessionKey('codex', sessionId);
    if (!sessionKey) return false;
    const existingPane = this.statusService?.getBoundPane?.(sessionKey);
    if (existingPane) return false;
    const fallbackAt = entry?.file?.mtime ?? entry?.file?.mtimeMs ?? 0;
    const normalizedAt = this.normalizeActivityAt(activityAt ?? fallbackAt);
    if (!normalizedAt) return false;
    return Boolean(this.codexCommandSource?.matchPendingLaunch?.({ sessionId, activityAt: normalizedAt }));
  }

  applySessionSummary(session, { allowBind = true } = {}) {
    if (!session || typeof session !== 'object') return false;
    const source = String(session.source || '').trim().toLowerCase();
    if (source !== 'codex') return false;
    const sessionId = String(session.session_id || '').trim();
    if (!sessionId) return false;
    const sessionKey = buildSessionKey('codex', sessionId);
    const alreadyBound = sessionKey ? this.statusService?.getBoundPane?.(sessionKey) : '';
    const sessionCwd = String(session.cwd || session.pane_id || session.paneId || '').trim();
    const status = this.inferStatusFromSummary(session);
    if (!status) return false;
    const hint = String(session.status_hint || '').trim().toLowerCase();
    const hintTs = this.normalizeActivityAt(session.status_hint_ts ?? session.statusHintTs ?? 0);
    let activityAt = this.normalizeActivityAt(
      session.last_output_at ?? session.created_at ?? session.timestamp ?? session.updated_at ?? 0
    );
    if (hint && status === hint && hintTs > 0) {
      activityAt = hintTs;
    }
    if (allowBind && !alreadyBound && Number.isFinite(activityAt) && activityAt > 0) {
      this.codexCommandSource?.matchPendingLaunch?.({ sessionId, activityAt, sessionCwd });
    }
    this.statusService?.applyObservation?.({
      source: 'codex',
      session_id: sessionId,
      status,
      timestamp: activityAt || Date.now(),
    });
    return true;
  }
}

module.exports = { CodexJsonlStatusSource };
