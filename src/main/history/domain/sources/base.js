class HistorySource {
  constructor({ id, capabilities } = {}) {
    this.id = String(id || '').trim();
    this.capabilities = capabilities || {};
  }

  async getMeta() {
    return { source: this.id, signature: '', file_count: 0, latest_mtime: 0, latest_size: 0 };
  }

  async listSessions() {
    return { sessions: [], maybe_more: false, next_cursor: null };
  }

  async listSearchEntries() {
    return { entries: [], error: null };
  }

  async scanSearchEntry() {
    return null;
  }

  async loadSession() {
    return { blocks: [], error: 'Unsupported source' };
  }

  async createTimeMachine() {
    return { success: false, error: 'Unsupported source' };
  }
}

module.exports = HistorySource;
