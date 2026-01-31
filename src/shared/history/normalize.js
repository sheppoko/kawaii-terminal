/* global module */
(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else {
    root.HistoryNormalize = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : Function('return this')(), () => {
  function normalizeSessionSummary(session, fallbackSource = '') {
    if (!session || typeof session !== 'object') return;
    if (!session.source && fallbackSource && fallbackSource !== 'all') {
      session.source = fallbackSource;
    }
    const createdRaw = session.created_at ?? session.createdAt ?? null;
    if (typeof createdRaw === 'string') {
      const ms = Date.parse(createdRaw);
      if (Number.isFinite(ms)) session.created_at = ms;
    } else if (typeof createdRaw === 'number') {
      session.created_at = createdRaw;
    }
    const lastRaw = session.last_output_at ?? session.lastOutputAt ?? null;
    if (typeof lastRaw === 'string') {
      const ms = Date.parse(lastRaw);
      if (Number.isFinite(ms)) session.last_output_at = ms;
    } else if (typeof lastRaw === 'number') {
      session.last_output_at = lastRaw;
    }
    if (!session.last_output_at && session.created_at) {
      session.last_output_at = session.created_at;
    }
  }

  return {
    normalizeSessionSummary,
  };
});
