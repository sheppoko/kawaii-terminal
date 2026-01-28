(function () {
  'use strict';

  const clampValue = window.KawaiiUtils?.clampNumber
    || ((value, min, max, fallbackValue) => {
      const num = Number(value);
      if (Number.isNaN(num)) return fallbackValue;
      return Math.min(max, Math.max(min, num));
    });

  const safeJsonStringify = (value) => {
    try {
      return JSON.stringify(value);
    } catch (_) {
      return '';
    }
  };

  const startSessionPersistence = ({ tabManager, windowKey, snapshotConfig } = {}) => {
    if (!tabManager || !windowKey) return () => {};
    if (!window.sessionAPI?.updateWindow || !window.sessionAPI?.saveSnapshots) return () => {};

    const snapshotDefaults = {
      enabled: true,
      intervalMs: 30_000,
      maxLinesPerPane: 500,
      maxCharsPerPane: 200_000,
    };
    const snapshot = { ...snapshotDefaults, ...(snapshotConfig || {}) };

    let lastStateJson = '';
    const pushState = () => {
      const state = tabManager.exportSessionState?.();
      if (!state) return;
      const json = safeJsonStringify(state);
      if (!json || json === lastStateJson) return;
      lastStateJson = json;
      window.sessionAPI.updateWindow(windowKey, state);
    };

    const saveSnapshotsOnce = () => {
      if (!snapshot.enabled) return;
      const maxLines = clampValue(snapshot.maxLinesPerPane, 50, 5000, snapshotDefaults.maxLinesPerPane);
      const maxChars = clampValue(snapshot.maxCharsPerPane, 10_000, 2_000_000, snapshotDefaults.maxCharsPerPane);
      const payloads = tabManager.collectDirtySnapshots?.({ maxLines, maxChars }) || [];
      if (!payloads.length) return;
      window.sessionAPI.saveSnapshots(payloads).catch(() => {});
    };

    pushState();
    const stateTimer = setInterval(pushState, 1000);

    const intervalMs = clampValue(snapshot.intervalMs, 5000, 300_000, snapshotDefaults.intervalMs);
    const snapshotTimer = setInterval(saveSnapshotsOnce, intervalMs);

    const handleBeforeUnload = () => {
      clearInterval(stateTimer);
      clearInterval(snapshotTimer);
      pushState();
      saveSnapshotsOnce();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      clearInterval(stateTimer);
      clearInterval(snapshotTimer);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  };

  window.SessionPersistence = {
    startSessionPersistence,
  };
})();
