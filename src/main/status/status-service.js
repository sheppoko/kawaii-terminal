const { EventEmitter } = require('events');

function normalizeStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'needs_permission') return 'waiting_user';
  if (raw === 'working' || raw === 'waiting_user' || raw === 'completed' || raw === 'stopped') return raw;
  if (raw === 'running') return 'working';
  if (raw === 'done') return 'completed';
  if (raw === 'waiting') return 'waiting_user';
  if (raw === 'permission' || raw === 'permission_prompt') return 'waiting_user';
  return '';
}

function normalizeTimestamp(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function buildSessionKey(source, sessionId) {
  const src = String(source || '').trim().toLowerCase();
  const sid = String(sessionId || '').trim();
  if (!src || !sid) return '';
  return `${src}:${sid}`;
}

class StatusService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.statusBySession = new Map();
    this.sessionToPane = new Map();
    this.paneToSession = new Map();
    this.maxEntries = Number.isFinite(options.maxEntries) ? Math.max(1, Math.floor(options.maxEntries)) : 5000;
  }

  snapshot() {
    return {
      version: 1,
      generated_at: Date.now(),
      entries: Array.from(this.statusBySession.values()),
    };
  }

  getBoundPane(sessionKey) {
    const key = String(sessionKey || '').trim();
    if (!key) return '';
    return this.sessionToPane.get(key) || '';
  }

  applyObservation(obs) {
    if (!obs || typeof obs !== 'object') return null;
    const source = String(obs.source || '').trim().toLowerCase();
    const sessionId = String(obs.session_id || '').trim();
    const status = normalizeStatus(obs.status);
    if (!source || !sessionId || !status) return null;

    const sessionKey = buildSessionKey(source, sessionId);
    if (!sessionKey) return null;

    const now = Date.now();
    const ts = normalizeTimestamp(obs.timestamp);
    const updatedAt = Number.isFinite(ts) ? ts : now;
    const paneId = String(obs.pane_id || '').trim();
    if (paneId) {
      this._setBinding(sessionKey, paneId);
    }
    const boundPane = paneId || this.sessionToPane.get(sessionKey) || '';

    const prev = this.statusBySession.get(sessionKey);
    if (prev && Number.isFinite(prev.updated_at) && updatedAt <= prev.updated_at) {
      if (paneId && prev.pane_id !== boundPane) {
        const next = { ...prev, pane_id: boundPane };
        this.statusBySession.set(sessionKey, next);
        this.emitUpdate({ entries: [next], removed: [] });
      }
      return prev;
    }

    const flags = { ...(prev?.flags || {}) };
    if (flags.defaultCompleted) {
      delete flags.defaultCompleted;
    }
    const next = {
      session_key: sessionKey,
      source,
      session_id: sessionId,
      status,
      pane_id: boundPane,
      updated_at: updatedAt,
      flags,
    };
    this.statusBySession.set(sessionKey, next);
    this.emitUpdate({ entries: [next], removed: [] });
    this.pruneByLimit();

    return next;
  }

  bindSessionToPane({ source, sessionId, paneId } = {}) {
    const src = String(source || '').trim().toLowerCase();
    const sid = String(sessionId || '').trim();
    const pid = String(paneId || '').trim();
    if (!src || !sid || !pid) return false;
    const sessionKey = `${src}:${sid}`;
    const defaultStatus = src === 'codex' ? 'completed' : '';
    const applyDefaultStatus = (entry) => {
      if (!entry || entry.status || !defaultStatus) return entry;
      const updatedAt = Number(entry.updated_at) || Date.now();
      const flags = { ...(entry.flags || {}) };
      flags.defaultCompleted = true;
      return { ...entry, status: defaultStatus, updated_at: updatedAt, flags };
    };

    const prevPane = this.sessionToPane.get(sessionKey);
    const prev = this.statusBySession.get(sessionKey);
    if (prevPane === pid) {
      if (!prev) {
        let next = {
          session_key: sessionKey,
          source: src,
          session_id: sid,
          status: '',
          pane_id: pid,
          updated_at: null,
          flags: {},
        };
        next = applyDefaultStatus(next);
        this.statusBySession.set(sessionKey, next);
        this.emitUpdate({ entries: [next], removed: [] });
        this.pruneByLimit();
        return true;
      }
      if (prev && !prev.status && defaultStatus) {
        const next = applyDefaultStatus(prev);
        this.statusBySession.set(sessionKey, next);
        this.emitUpdate({ entries: [next], removed: [] });
        this.pruneByLimit();
        return true;
      }
      return false;
    }
    this._setBinding(sessionKey, pid);

    if (prev) {
      const next = applyDefaultStatus({ ...prev, pane_id: pid });
      this.statusBySession.set(sessionKey, next);
      this.emitUpdate({ entries: [next], removed: [] });
      this.pruneByLimit();
      return true;
    }

    let next = {
      session_key: sessionKey,
      source: src,
      session_id: sid,
      status: '',
      pane_id: pid,
      updated_at: null,
      flags: {},
    };
    next = applyDefaultStatus(next);
    this.statusBySession.set(sessionKey, next);
    this.emitUpdate({ entries: [next], removed: [] });
    this.pruneByLimit();
    return true;
  }

  removeOtherSessionsForPane(paneId, keepSessionKey = '') {
    const pid = String(paneId || '').trim();
    if (!pid) return [];
    const keep = String(keepSessionKey || '').trim();
    const existing = this.paneToSession.get(pid);
    if (!existing || (keep && existing === keep)) return [];
    this.paneToSession.delete(pid);
    this.statusBySession.delete(existing);
    this.sessionToPane.delete(existing);
    this.emitUpdate({ entries: [], removed: [existing] });
    return [existing];
  }

  _setBinding(sessionKey, paneId) {
    // Enforce 1:1 pane binding (remove any other session bound to this pane).
    this.removeOtherSessionsForPane(paneId, sessionKey);

    const prevPane = this.sessionToPane.get(sessionKey);
    if (prevPane && prevPane !== paneId) {
      const prevSession = this.paneToSession.get(prevPane);
      if (prevSession === sessionKey) this.paneToSession.delete(prevPane);
    }
    this.sessionToPane.set(sessionKey, paneId);
    this.paneToSession.set(paneId, sessionKey);
  }

  clearBindingsForPane(paneId) {
    const pid = String(paneId || '').trim();
    if (!pid) return;
    const sessionKey = this.paneToSession.get(pid);
    if (!sessionKey) return;
    this.sessionToPane.delete(sessionKey);
    const prev = this.statusBySession.get(sessionKey);
    if (prev && prev.pane_id) {
      const next = { ...prev, pane_id: '' };
      this.statusBySession.set(sessionKey, next);
      this.emitUpdate({ entries: [next], removed: [] });
    }
    this.paneToSession.delete(pid);
  }

  removeSessionsForPane(paneId) {
    const pid = String(paneId || '').trim();
    if (!pid) return [];
    const sessionKey = this.paneToSession.get(pid);
    if (!sessionKey) return [];
    this.statusBySession.delete(sessionKey);
    this.sessionToPane.delete(sessionKey);
    this.paneToSession.delete(pid);
    this.emitUpdate({ entries: [], removed: [sessionKey] });
    return [sessionKey];
  }

  setOutputIdle(paneId, idle) {
    const pid = String(paneId || '').trim();
    if (!pid) return;
    const sessionKey = this.paneToSession.get(pid);
    if (!sessionKey) return;
    const prev = this.statusBySession.get(sessionKey);
    if (!prev) return;
    const flags = { ...(prev.flags || {}), output_idle: Boolean(idle) };
    const next = { ...prev, flags };
    this.statusBySession.set(sessionKey, next);
    this.emitUpdate({ entries: [next], removed: [] });
    this.pruneByLimit();
  }

  removeSession(sessionKey) {
    const key = String(sessionKey || '').trim();
    if (!key) return false;
    const prev = this.statusBySession.get(key);
    if (!prev) return false;
    this.statusBySession.delete(key);
    const paneId = this.sessionToPane.get(key);
    if (paneId) {
      const bound = this.paneToSession.get(paneId);
      if (bound === key) this.paneToSession.delete(paneId);
      this.sessionToPane.delete(key);
    }
    this.emitUpdate({ entries: [], removed: [key] });
    return true;
  }

  pruneByLimit() {
    const limit = Number.isFinite(this.maxEntries) ? this.maxEntries : 0;
    if (!limit || this.statusBySession.size <= limit) return;
    const entries = Array.from(this.statusBySession.values());
    entries.sort((a, b) => {
      const aTime = Number(a?.updated_at) || 0;
      const bTime = Number(b?.updated_at) || 0;
      return aTime - bTime;
    });
    const over = entries.length - limit;
    if (over <= 0) return;
    for (let i = 0; i < over; i += 1) {
      const entry = entries[i];
      const key = String(entry?.session_key || '').trim();
      if (!key) continue;
      this.removeSession(key);
    }
  }

  emitUpdate(payload) {
    const entries = Array.isArray(payload?.entries) ? payload.entries : [];
    const removed = Array.isArray(payload?.removed) ? payload.removed : [];
    this.emit('update', { version: 1, entries, removed });
  }
}

module.exports = {
  StatusService,
  normalizeStatus,
  buildSessionKey,
};
