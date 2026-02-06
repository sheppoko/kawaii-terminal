(() => {
  const DISMISS_VERSION = 2;

  const statusLabels = {
    present: 'Detected',
    missing: 'Missing',
  };

  const hookLabels = {
    configured: 'Ready',
    partial: 'Partial',
    missing: 'Not set',
    error: 'Error',
    unavailable: 'N/A',
  };

  const toneMap = {
    present: 'success',
    configured: 'success',
    partial: 'info',
    missing: 'error',
    error: 'error',
    unavailable: null,
  };

  const toStatusLabel = (value, fallback) => hookLabels[value] || statusLabels[value] || fallback || '';

  const getSettings = async () => {
    if (!window.settingsAPI?.get) return null;
    return window.settingsAPI.get();
  };

  const setSettings = async (patch) => {
    if (!window.settingsAPI?.update) return { ok: false };
    return window.settingsAPI.update(patch || {});
  };

  const fetchStatus = async () => {
    if (!window.onboardingAPI?.getStatus) return null;
    return window.onboardingAPI.getStatus();
  };

  const shouldShowOnboarding = (settings, status) => {
    const dismissedVersion = Number(settings?.onboarding?.dismissedVersion || 0);
    if (dismissedVersion >= DISMISS_VERSION) return false;
    if (!status?.local?.claude?.present) return false;
    const localHooks = status?.local?.claude?.hooks?.status;
    const localNeeds = localHooks !== 'configured';
    return Boolean(localNeeds);
  };

  const setStatus = (el, status, fallback) => {
    if (!el) return;
    el.textContent = toStatusLabel(status, fallback);
    const tone = toneMap[status] || null;
    if (tone) {
      el.dataset.tone = tone;
    } else {
      el.removeAttribute('data-tone');
    }
  };

  const initOnboarding = async () => {
    const overlay = document.getElementById('onboarding-overlay');
    if (!overlay) return;

    const windowEl = overlay.querySelector('.onboarding-window');
    const applyBtn = document.getElementById('onboarding-apply');
    const laterBtn = document.getElementById('onboarding-later');
    const dismissLink = document.getElementById('onboarding-dismiss-link');
    const includeWslCheck = document.getElementById('onboarding-include-wsl');
    const applyStatus = document.getElementById('onboarding-apply-status');
    const closeBtn = document.getElementById('onboarding-close');
    const detailsToggle = document.getElementById('onboarding-details-toggle');
    const detailsPanel = document.getElementById('onboarding-details');
    const resultText = document.getElementById('onboarding-result-text');
    const setApplyStatus = (text, tone) => {
      if (!applyStatus) return;
      applyStatus.textContent = text || '';
      if (tone) {
        applyStatus.dataset.tone = tone;
      } else {
        applyStatus.removeAttribute('data-tone');
      }
    };

    const claudeLocalStatus = document.getElementById('onboarding-claude-local');
    const claudeWslRow = document.getElementById('onboarding-claude-wsl-row');
    const claudeWslStatus = document.getElementById('onboarding-claude-wsl');
    const codexLocalStatus = document.getElementById('onboarding-codex-local');
    const codexWslRow = document.getElementById('onboarding-codex-wsl-row');
    const codexWslStatus = document.getElementById('onboarding-codex-wsl');

    const hooksLocalStatus = document.getElementById('onboarding-hooks-local');
    const hooksWslRow = document.getElementById('onboarding-hooks-wsl-row');
    const hooksWslStatus = document.getElementById('onboarding-hooks-wsl');
    const includeWslRow = document.getElementById('onboarding-include-wsl-row');

    const settings = await getSettings();
    const status = await fetchStatus();
    if (!status) return;
    if (!shouldShowOnboarding(settings, status)) return;

    const resetView = () => {
      if (windowEl) {
        windowEl.classList.remove('is-result');
        windowEl.removeAttribute('data-result');
      }
      if (resultText) resultText.textContent = '';
      setApplyStatus('', null);
      if (applyBtn) applyBtn.disabled = false;
    };

    const showResult = (type, message) => {
      if (!windowEl) return;
      windowEl.classList.add('is-result');
      windowEl.dataset.result = type;
      if (resultText) resultText.textContent = message || '';
    };

    const errorReason = (errorText) => {
      const raw = String(errorText || '').trim();
      const message = raw.toLowerCase();
      if (message.includes('json parse')) return 'settings.json is invalid';
      if (message.includes('eacces') || message.includes('eperm') || message.includes('permission')) {
        return 'write access was denied';
      }
      if (message.includes('enoent') || message.includes('not found') || message.includes('read')) {
        return 'settings.json could not be read';
      }
      return 'an unexpected error occurred';
    };

    const open = () => {
      overlay.classList.add('show');
      overlay.setAttribute('aria-hidden', 'false');
      resetView();
    };
    const close = () => {
      overlay.classList.remove('show');
      overlay.setAttribute('aria-hidden', 'true');
    };

    const updateStatusUI = (nextStatus) => {
      const localClaudePresent = Boolean(nextStatus?.local?.claude?.present);
      const localCodexPresent = Boolean(nextStatus?.local?.codex?.present);
      const wslClaudePresent = Boolean(nextStatus?.wsl?.claude?.present);
      const wslCodexPresent = Boolean(nextStatus?.wsl?.codex?.present);

      setStatus(claudeLocalStatus, localClaudePresent ? 'present' : 'missing');
      setStatus(codexLocalStatus, localCodexPresent ? 'present' : 'missing');

      if (wslClaudePresent) {
        claudeWslRow?.classList.remove('onboarding-hidden');
        setStatus(claudeWslStatus, 'present');
      } else if (claudeWslRow) {
        claudeWslRow.classList.add('onboarding-hidden');
      }

      if (wslCodexPresent) {
        codexWslRow?.classList.remove('onboarding-hidden');
        setStatus(codexWslStatus, 'present');
      } else if (codexWslRow) {
        codexWslRow.classList.add('onboarding-hidden');
      }

      setStatus(hooksLocalStatus, nextStatus?.local?.claude?.hooks?.status || 'missing');

      if (wslClaudePresent) {
        hooksWslRow?.classList.remove('onboarding-hidden');
        setStatus(hooksWslStatus, nextStatus?.wsl?.claude?.hooks?.status || 'missing');
        includeWslRow?.classList.remove('onboarding-hidden');
        if (includeWslCheck) {
          includeWslCheck.checked = true;
          includeWslCheck.disabled = false;
        }
      } else if (hooksWslRow) {
        hooksWslRow.classList.add('onboarding-hidden');
        includeWslRow?.classList.add('onboarding-hidden');
        if (includeWslCheck) {
          includeWslCheck.checked = false;
          includeWslCheck.disabled = true;
        }
      }
    };

    updateStatusUI(status);
    open();

    const handleDismiss = async () => {
      await setSettings({ onboarding: { dismissedVersion: DISMISS_VERSION } });
      close();
    };

    applyBtn?.addEventListener('click', async () => {
      if (!window.configAPI?.applyAutoConfig) return;
      applyBtn.disabled = true;
      setApplyStatus('Applying...', 'info');
      try {
        const enableWsl = includeWslCheck ? Boolean(includeWslCheck.checked) : true;
        const result = await window.configAPI.applyAutoConfig({ enableWsl });
        if (!result?.success) {
          const reason = errorReason(result?.error);
          showResult('error', `Update skipped - ${reason}. No changes were made.`);
          setTimeout(close, 1200);
          return;
        }
        const refreshed = await fetchStatus();
        if (refreshed) {
          updateStatusUI(refreshed);
        }
        showResult('success', '');
        setTimeout(close, 900);
      } catch (e) {
        const reason = errorReason(e?.message);
        showResult('error', `Update skipped - ${reason}. No changes were made.`);
        setTimeout(close, 1200);
      } finally {
        applyBtn.disabled = false;
      }
    });

    laterBtn?.addEventListener('click', handleDismiss);
    closeBtn?.addEventListener('click', close);
    dismissLink?.addEventListener('click', handleDismiss);
    detailsToggle?.addEventListener('click', () => {
      if (!detailsPanel) return;
      const isHidden = detailsPanel.classList.contains('onboarding-hidden');
      detailsPanel.classList.toggle('onboarding-hidden', !isHidden);
      detailsToggle.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
    });
  };

  window.OnboardingUI = {
    initOnboarding,
  };
})();
