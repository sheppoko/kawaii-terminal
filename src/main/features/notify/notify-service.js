const fs = require('fs');
const path = require('path');
const DEFAULT_POLL_MS = 400;

function ensureDir(dirPath) {
  if (!dirPath) return;
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (_) {
    // ignore
  }
}

function normalizeSource(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'claude' || raw === 'codex') return raw;
  return '';
}

function normalizeEvent(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'needs_permission') return 'waiting_user';
  if (raw === 'working' || raw === 'waiting_user' || raw === 'completed' || raw === 'stopped') return raw;
  if (raw === 'running') return 'working';
  if (raw === 'done') return 'completed';
  if (raw === 'waiting') return 'waiting_user';
  if (raw === 'permission' || raw === 'permission_prompt') return 'waiting_user';
  return '';
}

class NotifyService {
  constructor({ userDataDir, onEvent, logger } = {}) {
    this.userDataDir = userDataDir || process.cwd();
    this.log = typeof logger === 'function' ? logger : () => {};
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    this.notifyPath = '';
    this.offset = 0;
    this.buffer = '';
    this.watching = false;
    this.reading = false;
    this.pending = false;
  }

  getNotifyPath() {
    if (this.notifyPath) return this.notifyPath;
    const instanceId = process.env.KAWAII_TERMINAL_INSTANCE_ID || 'instance';
    const safeId = String(instanceId).replace(/[^A-Za-z0-9._-]/g, '_');
    const dir = path.join(this.userDataDir, 'notify');
    this.notifyPath = path.join(dir, `notify-${safeId}.jsonl`);
    return this.notifyPath;
  }

  start() {
    if (this.watching) return;
    const notifyPath = this.getNotifyPath();
    ensureDir(path.dirname(notifyPath));
    this.watching = true;
    fs.watchFile(notifyPath, { interval: DEFAULT_POLL_MS }, () => {
      this.readNew();
    });
    // initial read if file already exists
    this.readNew();
  }

  stop() {
    if (!this.watching) return;
    this.watching = false;
    const notifyPath = this.getNotifyPath();
    fs.unwatchFile(notifyPath);
  }

  async readNew() {
    if (this.reading) {
      this.pending = true;
      return;
    }
    this.reading = true;
    do {
      this.pending = false;
      await this.readOnce();
    } while (this.pending);
    this.reading = false;
  }

  async readOnce() {
    const notifyPath = this.getNotifyPath();
    let stat;
    try {
      stat = await fs.promises.stat(notifyPath);
    } catch (_) {
      return;
    }
    if (!stat || !Number.isFinite(stat.size)) return;
    if (stat.size < this.offset) {
      this.offset = 0;
      this.buffer = '';
    }
    if (stat.size === this.offset) return;

    const length = stat.size - this.offset;
    if (length <= 0) return;
    let handle;
    try {
      handle = await fs.promises.open(notifyPath, 'r');
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, this.offset);
      this.offset = stat.size;
      this.buffer += buf.toString('utf8');
    } catch (error) {
      this.log('notify.read error', { message: error?.message });
      return;
    } finally {
      try {
        await handle?.close?.();
      } catch (_) {
        // ignore
      }
    }

    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.processLine(line);
    }
  }

  processLine(line) {
    const raw = String(line || '').trim();
    if (!raw) return;
    if (raw.length > 20000) return;
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch (_) {
      return;
    }
    if (!entry || typeof entry !== 'object') return;

    const source = normalizeSource(entry.source);
    const event = normalizeEvent(entry.event);
    const sessionId = typeof entry.session_id === 'string' ? entry.session_id.trim() : '';
    const paneId = typeof entry.pane_id === 'string' ? entry.pane_id.trim() : '';
    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp.trim() : '';
    const hook = typeof entry.hook === 'string' ? entry.hook.trim() : '';
    if (!source || !event || !sessionId || !paneId) return;

    const payload = {
      source,
      event,
      session_id: sessionId,
      pane_id: paneId,
      timestamp,
      hook,
    };
    if (this.onEvent) {
      try {
        this.onEvent(payload);
      } catch (_) {
        // ignore
      }
    }
  }
}

module.exports = NotifyService;
