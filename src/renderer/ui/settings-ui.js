(function () {
  'use strict';

  const clampValue = window.KawaiiUtils?.clampNumber;
  function initSettingsWheelInputs() {
    const inputs = document.querySelectorAll('.settings-input[type="number"]');
    if (!inputs.length) return;
    inputs.forEach((input) => {
      input.addEventListener('wheel', (event) => {
        if (!input.matches(':hover') && document.activeElement !== input) return;
        event.preventDefault();
        const stepRaw = parseFloat(input.step || '1');
        const step = Number.isFinite(stepRaw) && stepRaw > 0 ? stepRaw : 1;
        const minRaw = parseFloat(input.min || '');
        const maxRaw = parseFloat(input.max || '');
        const min = Number.isFinite(minRaw) ? minRaw : null;
        const max = Number.isFinite(maxRaw) ? maxRaw : null;
        let current = parseFloat(input.value || '');
        if (!Number.isFinite(current)) current = 0;
        const delta = event.deltaY < 0 ? step : -step;
        let next = current + delta;
        if (min !== null) next = Math.max(min, next);
        if (max !== null) next = Math.min(max, next);
        const stepText = String(step);
        const decimals = stepText.includes('.') ? stepText.split('.')[1].length : 0;
        if (decimals > 0) {
          const factor = 10 ** decimals;
          next = Math.round(next * factor) / factor;
        } else {
          next = Math.round(next);
        }
        if (next === current) return;
        input.value = String(next);
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, { passive: false });
    });
  }

  function initTerminalSettingsUI(tabManager) {
    const fontSizeInput = document.getElementById('terminal-font-size');
    const fontFamilyInput = document.getElementById('terminal-font-family');
    const scrollbackInput = document.getElementById('terminal-scrollback');
    const webglToggle = document.getElementById('terminal-webgl');
    if (!fontSizeInput || !scrollbackInput) return;

    const updateUI = () => {
      const settings = tabManager.getSettings();
      fontSizeInput.value = settings.fontSize;
      if (fontFamilyInput) {
        fontFamilyInput.value = settings.fontFamily || '';
      }
      scrollbackInput.value = settings.scrollback;
      if (webglToggle) {
        webglToggle.checked = Boolean(settings.webglEnabled);
      }
    };

    updateUI();
    tabManager.setSettingsListener?.(updateUI);
    setTimeout(updateUI, 150);

    fontSizeInput.addEventListener('change', () => {
      const currentSettings = tabManager.getSettings();
      const value = clampValue(fontSizeInput.value, 10, 32, currentSettings.fontSize);
      fontSizeInput.value = value;
      tabManager.updateSettingsAll({ fontSize: value });
    });

    fontFamilyInput?.addEventListener('change', () => {
      const defaults = window.TerminalSettings?.defaults || {};
      const fallback = typeof defaults.fontFamily === 'string' ? defaults.fontFamily : '';
      const raw = String(fontFamilyInput.value || '').trim();
      const value = raw || fallback;
      fontFamilyInput.value = value;
      tabManager.updateSettingsAll({ fontFamily: value });
    });

    scrollbackInput.addEventListener('change', () => {
      const currentSettings = tabManager.getSettings();
      const value = clampValue(scrollbackInput.value, 1000, 50000, currentSettings.scrollback);
      scrollbackInput.value = value;
      tabManager.updateSettingsAll({ scrollback: value });
    });

    webglToggle?.addEventListener('change', () => {
      tabManager.updateSettingsAll({ webglEnabled: webglToggle.checked });
    });
  }

  function initThemeSettingsUI() {
    const themeSelect = document.getElementById('theme-select');
    if (!themeSelect) return;

    const resolveTheme = () => {
      return window.KawaiiThemeRuntime?.getCurrentTheme?.() || 'dark';
    };

    const applyValue = (value) => {
      const options = Array.from(themeSelect.options || []);
      const match = options.some((opt) => opt.value === value);
      themeSelect.value = match ? value : 'dark';
    };

    const updateFromEvent = (event) => {
      const name = event?.detail?.name || resolveTheme();
      applyValue(name);
    };

    applyValue(resolveTheme());
    window.addEventListener('kawaii-theme-change', updateFromEvent);

    themeSelect.addEventListener('change', async () => {
      const next = themeSelect.value || 'dark';
      const prev = resolveTheme();
      if (next === prev) return;
      themeSelect.disabled = true;
      try {
        if (window.KawaiiThemeRuntime?.loadTheme) {
          await window.KawaiiThemeRuntime.loadTheme(next);
        } else if (window.KawaiiTheme?.loadTheme) {
          await window.KawaiiTheme.loadTheme(`theme/themes/${next}.json`);
          window.dispatchEvent(new CustomEvent('kawaii-theme-change', { detail: { name: next } }));
        }
      } catch (err) {
        console.error('[SettingsUI] Theme switch failed:', err);
        applyValue(prev);
      } finally {
        themeSelect.disabled = false;
      }
    });
  }

  function initShortcutSettingsUI(shortcutManager) {
    const list = document.getElementById('shortcut-list');
    const resetAllBtn = document.getElementById('shortcut-reset-all');
    const platformLabel = document.getElementById('shortcut-platform-label');
    const settingsPanel = document.getElementById('settings-panel');
    if (!list || !shortcutManager) return;

    if (platformLabel) {
      platformLabel.textContent = shortcutManager.platformKey === 'mac' ? 'macOS' : 'Windows';
    }

    const MOD_DISPLAY_MAC = { Cmd: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };
    const MOD_DISPLAY_WIN = { Cmd: 'Win', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
    const modDisplay = shortcutManager.platformKey === 'mac' ? MOD_DISPLAY_MAC : MOD_DISPLAY_WIN;
    const labelById = new Map(shortcutManager.commands.map(cmd => [cmd.id, cmd.title]));

    let recording = null;
    let captureState = null;
    let captureOverlay = null;
    let captureModal = null;
    let captureTitleEl = null;
    let captureDisplayEl = null;
    let captureHintEl = null;

    const buildBindingString = (mods, key) => {
      if (!key) return '';
      const tokens = [];
      if (mods?.Cmd) tokens.push('Cmd');
      if (mods?.Ctrl) tokens.push('Ctrl');
      if (mods?.Alt) tokens.push('Alt');
      if (mods?.Shift) tokens.push('Shift');
      tokens.push(key);
      return tokens.join('+');
    };

    const renderCaptureDisplay = () => {
      if (!captureDisplayEl) return;
      captureDisplayEl.innerHTML = '';
      const candidate = captureState?.candidate || null;
      if (candidate && candidate.key) {
        const binding = buildBindingString(candidate.mods, candidate.key);
        const parts = binding ? shortcutManager.formatParts(binding) : [];
        parts.forEach((part) => {
          const kbd = document.createElement('kbd');
          kbd.textContent = part;
          captureDisplayEl.appendChild(kbd);
        });
        if (captureHintEl) captureHintEl.textContent = 'Press Enter to save.';
        return;
      }

      const mods = captureState?.mods || {};
      const modParts = ['Cmd', 'Ctrl', 'Alt', 'Shift']
        .filter((mod) => mods[mod])
        .map((mod) => modDisplay[mod] || mod);
      if (modParts.length === 0) {
        const placeholder = document.createElement('div');
        placeholder.className = 'shortcut-capture-placeholder';
        placeholder.textContent = 'Press a shortcut.';
        captureDisplayEl.appendChild(placeholder);
        if (captureHintEl) captureHintEl.textContent = '';
        return;
      }
      modParts.forEach((part) => {
        const kbd = document.createElement('kbd');
        kbd.textContent = part;
        captureDisplayEl.appendChild(kbd);
      });
      if (captureHintEl) captureHintEl.textContent = '';
    };

    const ensureCaptureModal = () => {
      if (captureOverlay) return;
      captureOverlay = document.createElement('div');
      captureOverlay.className = 'shortcut-capture-overlay';
      captureModal = document.createElement('div');
      captureModal.className = 'shortcut-capture-modal';

      captureTitleEl = document.createElement('div');
      captureTitleEl.className = 'shortcut-capture-title';
      captureTitleEl.textContent = 'Set Shortcut';

      captureDisplayEl = document.createElement('div');
      captureDisplayEl.className = 'shortcut-capture-display';

      captureHintEl = document.createElement('div');
      captureHintEl.className = 'shortcut-capture-hint';
      captureHintEl.textContent = '';

      captureModal.appendChild(captureTitleEl);
      captureModal.appendChild(captureDisplayEl);
      captureModal.appendChild(captureHintEl);
      captureOverlay.appendChild(captureModal);
      document.body.appendChild(captureOverlay);
    };

    const openCaptureModal = (commandId) => {
      ensureCaptureModal();
      const title = labelById.get(commandId);
      captureTitleEl.textContent = title ? `Set Shortcut: ${title}` : 'Set Shortcut';
      captureOverlay.classList.add('show');
      renderCaptureDisplay();
    };

    const closeCaptureModal = () => {
      if (!captureOverlay) return;
      captureOverlay.classList.remove('show');
    };

    const stopRecording = () => {
      if (!recording) return;
      recording = null;
      captureState = null;
      shortcutManager.setCapturing(false);
      document.removeEventListener('keydown', handleCaptureKeyDown, true);
      document.removeEventListener('keyup', handleCaptureKeyUp, true);
      document.removeEventListener('mousedown', handleCapturePointer, true);
      closeCaptureModal();
    };

    const commitRecording = () => {
      if (!recording) return;
      const candidate = captureState?.candidate || null;
      if (!candidate || !candidate.key) {
        stopRecording();
        render();
        return;
      }
      const binding = buildBindingString(candidate.mods, candidate.key);
      if (!binding) {
        stopRecording();
        render();
        return;
      }
      const { commandId, bindingIndex } = recording;
      if (bindingIndex === null) {
        shortcutManager.addBinding(commandId, binding);
      } else {
        shortcutManager.replaceBinding(commandId, bindingIndex, binding);
      }
      stopRecording();
      render();
    };

    const handleCaptureKeyDown = (event) => {
      if (!recording) return;
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        stopRecording();
        render();
        return;
      }

      if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key === 'Enter') {
        commitRecording();
        return;
      }

      const parts = window.Shortcuts?.eventToShortcutParts?.(event);
      if (!parts) return;

      captureState.mods = parts.mods || captureState.mods;
      if (parts.key) {
        const hasPrimary = Boolean(parts.mods?.Cmd || parts.mods?.Ctrl || parts.mods?.Alt);
        if (hasPrimary) {
          captureState.candidate = { key: parts.key, mods: parts.mods };
        } else {
          captureState.candidate = null;
        }
      }
      renderCaptureDisplay();
    };

    const handleCaptureKeyUp = (event) => {
      if (!recording) return;
      const parts = window.Shortcuts?.eventToShortcutParts?.(event);
      if (!parts) return;
      captureState.mods = parts.mods || captureState.mods;
      if (!captureState.candidate) {
        renderCaptureDisplay();
      }
    };

    const handleCapturePointer = (event) => {
      if (!recording) return;
      if (captureModal && captureModal.contains(event.target)) return;
      commitRecording();
    };

    const startRecording = (commandId, bindingIndex = null) => {
      if (window.LOCKED_SHORTCUT_COMMAND_IDS?.has?.(commandId)) return;
      if (recording) stopRecording();
      recording = { commandId, bindingIndex };
      captureState = { mods: { Cmd: false, Ctrl: false, Alt: false, Shift: false }, candidate: null };
      shortcutManager.setCapturing(true);
      openCaptureModal(commandId);
      document.addEventListener('keydown', handleCaptureKeyDown, true);
      document.addEventListener('keyup', handleCaptureKeyUp, true);
      document.addEventListener('mousedown', handleCapturePointer, true);
      render();
    };

    const render = () => {
      list.innerHTML = '';
      const conflicts = shortcutManager.getConflicts();

      const groupMap = new Map();
      shortcutManager.commands.forEach((cmd) => {
        if (window.LOCKED_SHORTCUT_COMMAND_IDS?.has?.(cmd.id)) return;
        if (!groupMap.has(cmd.category)) groupMap.set(cmd.category, []);
        groupMap.get(cmd.category).push(cmd);
      });

      groupMap.forEach((commands, category) => {
        const group = document.createElement('div');
        group.className = 'settings-shortcut-group';

        const sectionLabel = document.createElement('div');
        sectionLabel.className = 'settings-section-label';
        sectionLabel.textContent = category;
        group.appendChild(sectionLabel);

        commands.forEach((cmd) => {
          const row = document.createElement('div');
          row.className = 'settings-shortcut-row';
          if (recording && recording.commandId === cmd.id) {
            row.classList.add('recording');
          }

          const info = document.createElement('div');
          info.className = 'settings-shortcut-info';
          const title = document.createElement('div');
          title.className = 'settings-shortcut-title';
          title.textContent = cmd.title;
          const desc = document.createElement('div');
          desc.className = 'settings-shortcut-desc';
          desc.textContent = cmd.description || '';
          info.appendChild(title);
          info.appendChild(desc);

          const keys = document.createElement('div');
          keys.className = 'settings-shortcut-keys';
          const chips = document.createElement('div');
          chips.className = 'settings-shortcut-chips';

          const bindings = shortcutManager.getBindings(cmd.id);
          bindings.forEach((binding, index) => {
            const chip = document.createElement('div');
            chip.className = 'settings-shortcut-chip';
            if (conflicts.has(binding)) {
              chip.classList.add('conflict');
            }

            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'settings-shortcut-edit';

            const parts = shortcutManager.formatParts(binding);
            parts.forEach((part) => {
              const kbd = document.createElement('kbd');
              kbd.textContent = part;
              editBtn.appendChild(kbd);
            });

            editBtn.addEventListener('click', () => startRecording(cmd.id, index));

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'settings-shortcut-remove';
            removeBtn.textContent = '×';
            removeBtn.addEventListener('click', () => shortcutManager.removeBinding(cmd.id, index));

            chip.appendChild(editBtn);
            chip.appendChild(removeBtn);
            chips.appendChild(chip);
          });

          const rowActions = document.createElement('div');
          rowActions.className = 'settings-shortcut-row-actions';
          const addBtn = document.createElement('button');
          addBtn.type = 'button';
          addBtn.className = 'settings-shortcut-add';
          addBtn.textContent = 'Add';
          addBtn.addEventListener('click', () => startRecording(cmd.id, null));

          const resetBtn = document.createElement('button');
          resetBtn.type = 'button';
          resetBtn.className = 'settings-shortcut-reset';
          resetBtn.textContent = 'Reset';
          resetBtn.addEventListener('click', () => {
            stopRecording();
            shortcutManager.resetCommand(cmd.id);
          });

          rowActions.appendChild(addBtn);
          rowActions.appendChild(resetBtn);

          const warning = document.createElement('div');
          warning.className = 'settings-shortcut-warning';
          const conflictLabels = new Set();
          bindings.forEach((binding) => {
            const conflict = conflicts.get(binding);
            if (!conflict) return;
            conflict.forEach((id) => {
              if (id !== cmd.id) conflictLabels.add(labelById.get(id) || id);
            });
          });
          if (conflictLabels.size > 0) {
            warning.textContent = `Conflicts with ${Array.from(conflictLabels).join(', ')}`;
          }

          keys.appendChild(chips);
          keys.appendChild(rowActions);
          if (warning.textContent) keys.appendChild(warning);

          row.appendChild(info);
          row.appendChild(keys);
          group.appendChild(row);
        });

        list.appendChild(group);
      });
    };

    resetAllBtn?.addEventListener('click', () => {
      stopRecording();
      shortcutManager.resetAll();
    });

    if (settingsPanel) {
      const observer = new MutationObserver(() => {
        if (!settingsPanel.classList.contains('show')) {
          stopRecording();
        }
      });
      observer.observe(settingsPanel, { attributes: true, attributeFilter: ['class'] });
    }

    shortcutManager.onChange(render);
    render();
  }

  function initShortcutSheet(getDispatchAction, shortcutManager) {
    const sheet = document.getElementById('shortcut-sheet');
    const content = document.getElementById('shortcut-sheet-content');
    const hint = document.getElementById('shortcut-sheet-hint');
    if (!sheet || !content) {
      return {
        show: () => {},
        hide: () => {},
        toggle: () => {},
        render: () => {},
      };
    }

    let isShowing = false;
    sheet.setAttribute('tabindex', '-1');

    const render = () => {
      if (!shortcutManager) return;
      content.innerHTML = '';
      const groups = new Map();
      shortcutManager.commands.forEach((cmd) => {
        const bindings = shortcutManager.getBindings(cmd.id);
        if (!bindings || bindings.length === 0) return;
        if (!groups.has(cmd.category)) {
          groups.set(cmd.category, []);
        }
        groups.get(cmd.category).push(cmd);
      });

      groups.forEach((commands, category) => {
        const section = document.createElement('div');
        section.className = 'shortcut-section';
        const title = document.createElement('div');
        title.className = 'shortcut-section-title';
        title.textContent = category;
        section.appendChild(title);

        commands.forEach((cmd) => {
          const bindings = shortcutManager.getBindings(cmd.id);
          const binding = bindings[0] || '';
          const item = document.createElement('div');
          item.className = 'shortcut-item';

          const keys = document.createElement('span');
          keys.className = 'shortcut-keys';
          const parts = shortcutManager.formatParts(binding);
          parts.forEach((part) => {
            const kbd = document.createElement('kbd');
            kbd.textContent = part;
            keys.appendChild(kbd);
          });

          const desc = document.createElement('span');
          desc.className = 'shortcut-desc';
          desc.textContent = cmd.title;

          item.appendChild(keys);
          item.appendChild(desc);
          section.appendChild(item);
        });

        content.appendChild(section);
      });

      if (hint) {
        const shortcutBindings = shortcutManager.getBindings('view:shortcuts');
        const binding = shortcutBindings[0] || '';
        const label = binding ? shortcutManager.formatLabel(binding, shortcutManager.platformKey === 'mac') : '';
        hint.textContent = label ? `Press ${label} to show` : '';
      }
    };

    const showSheet = () => {
      if (isShowing) return;
      isShowing = true;
      sheet.classList.add('show');
      try {
        sheet.focus({ preventScroll: true });
      } catch {
        sheet.focus();
      }
    };

    const hideSheet = () => {
      if (!isShowing) return;
      isShowing = false;
      sheet.classList.remove('show');
    };

    const toggleSheet = () => {
      if (isShowing) hideSheet();
      else showSheet();
    };

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isShowing) {
        e.preventDefault();
        e.stopPropagation();
        hideSheet();
      }
    }, true);

    window.addEventListener('blur', () => {
      hideSheet();
    });

    sheet.addEventListener('mousedown', (e) => {
      if (!isShowing) return;
      if (e.target === sheet) {
        hideSheet();
      }
    });

    if (shortcutManager) {
      shortcutManager.onChange(render);
    }
    render();

    return {
      show: showSheet,
      hide: hideSheet,
      toggle: toggleSheet,
      render,
    };
  }

  // 応援メッセージUI
  function initCheerUI(cheerManager) {
    const bubble = document.getElementById('cheer-bubble');
    const settingsBtn = document.getElementById('settings-btn');
    const settingsPanel = document.getElementById('settings-panel');
    const settingsClose = document.getElementById('settings-close');
    const settingsWindow = settingsPanel?.querySelector('.settings-window');
    const navItems = settingsPanel?.querySelectorAll('.settings-nav-item') || [];
    const panes = settingsPanel?.querySelectorAll('.settings-pane') || [];

    // 設定要素
    const enabledCheckbox = document.getElementById('cheer-enabled');
    const languageSelect = document.getElementById('cheer-language');
    const intervalInput = document.getElementById('cheer-interval');
    const intervalMin = intervalInput ? parseFloat(intervalInput.min || '1') : 1;
    const intervalMax = intervalInput ? parseFloat(intervalInput.max || '60') : 60;

    const normalizeIntervalMinutes = (value, fallback) => clampValue(value, intervalMin, intervalMax, fallback);
    const secondsToMinutes = (seconds, fallbackMinutes) => {
      const raw = Number(seconds) / 60;
      const rounded = Number.isFinite(raw) ? Math.round(raw) : NaN;
      return normalizeIntervalMinutes(rounded, fallbackMinutes);
    };
    const minutesToSeconds = (minutes) => Math.round(minutes * 60);
    const syncIntervalInput = (value) => {
      if (!intervalInput) return;
      intervalInput.value = String(value);
    };

    const updateUI = () => {
      const settings = cheerManager.getSettings();
      window.kawaiiDebugLog('[CheerUI] updateUI called, settings:', settings);
      window.kawaiiDebugLog('[CheerUI] Elements:', {
        enabledCheckbox: !!enabledCheckbox,
        languageSelect: !!languageSelect,
        intervalInput: !!intervalInput
      });
      enabledCheckbox.checked = settings.enabled;
      languageSelect.value = settings.language;
      syncIntervalInput(secondsToMinutes(settings.minInterval, intervalMin));
      window.kawaiiDebugLog('[CheerUI] After update:', {
        checked: enabledCheckbox.checked,
        language: languageSelect.value,
        interval: intervalInput?.value
      });
    };

    // 設定を読み込んでUIに反映
    updateUI();

    // 遅延して再度UIを更新（設定反映タイミング対策）
    setTimeout(updateUI, 150);

    const setActiveSection = (section) => {
      panes.forEach((pane) => {
        pane.classList.toggle('active', pane.dataset.settingsPanel === section);
      });
      navItems.forEach((item) => {
        item.classList.toggle('active', item.dataset.settingsSection === section);
      });
    };

    navItems.forEach((item) => {
      item.addEventListener('click', () => setActiveSection(item.dataset.settingsSection));
    });

    const openSettings = () => {
      settingsPanel.classList.add('show');
      settingsPanel.setAttribute('aria-hidden', 'false');
      settingsBtn.classList.add('active');
      settingsWindow?.focus();
    };

    const closeSettings = () => {
      settingsPanel.classList.remove('show');
      settingsPanel.setAttribute('aria-hidden', 'true');
      settingsBtn.classList.remove('active');
    };

    // 設定ウィンドウ開閉
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isShowing = settingsPanel.classList.contains('show');
      if (isShowing) {
        closeSettings();
      } else {
        openSettings();
      }
    });

    settingsClose.addEventListener('click', closeSettings);

    settingsPanel.addEventListener('click', (e) => {
      if (e.target === settingsPanel) {
        closeSettings();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && settingsPanel.classList.contains('show')) {
        closeSettings();
      }
    });

    // 設定変更時の保存
    enabledCheckbox.addEventListener('change', () => {
      cheerManager.updateSettings({ enabled: enabledCheckbox.checked });
      if (!enabledCheckbox.checked && bubble) {
        bubble.classList.remove('show');
        bubble.textContent = '';
      }
    });

    languageSelect.addEventListener('change', () => {
      cheerManager.updateSettings({ language: languageSelect.value });
    });

    // インターバル入力
    if (intervalInput) {
      intervalInput.addEventListener('change', () => {
        const value = parseFloat(intervalInput.value);
        const fallbackMinutes = secondsToMinutes(cheerManager.getSettings().minInterval, intervalMin);
        const normalizedMinutes = normalizeIntervalMinutes(value, fallbackMinutes);
        syncIntervalInput(normalizedMinutes);
        cheerManager.updateSettings({ minInterval: minutesToSeconds(normalizedMinutes) });
      });
    }

    // Boostモード用（外部からアクセス可能に）
    window.cheerUIUpdateInterval = (seconds) => {
      const fallbackMinutes = secondsToMinutes(cheerManager.getSettings().minInterval, intervalMin);
      const normalizedMinutes = secondsToMinutes(seconds, fallbackMinutes);
      syncIntervalInput(normalizedMinutes);
      cheerManager.updateSettings({ minInterval: minutesToSeconds(normalizedMinutes) });
    };
  }

  function initAutoConfigUI() {
    const applyBtn = document.getElementById('hooks-notify-apply');
    const statusEl = document.getElementById('hooks-notify-status');
    if (!applyBtn || !statusEl) return;

    const hookLabels = {
      configured: 'Claude: Configured',
      partial: 'Claude: Not configured',
      missing: 'Claude: Not configured',
      error: 'Claude: Not configured',
      unavailable: 'Claude: Not configured',
    };
    const toneMap = {
      configured: 'success',
      partial: 'error',
      missing: 'error',
      error: 'error',
      unavailable: 'error',
    };

    const setStatus = (text, tone) => {
      statusEl.textContent = text || '';
      if (tone) {
        statusEl.dataset.tone = tone;
      } else {
        statusEl.removeAttribute('data-tone');
      }
    };

    const refreshHookStatus = async () => {
      if (!window.onboardingAPI?.getStatus) {
        setStatus('Status unavailable', null);
        return;
      }
      try {
        const status = await window.onboardingAPI.getStatus();
        if (!status) {
          setStatus('Status unavailable', null);
          return;
        }
        const claudePresent = Boolean(status?.local?.claude?.present);
        if (!claudePresent) {
          setStatus('Claude ✕', 'error');
          return;
        }
        const localState = status?.local?.claude?.hooks?.status || 'missing';
        const label = hookLabels[localState] || `Claude ${localState}`;
        const tone = toneMap[localState] || null;
        setStatus(label, tone);
      } catch (_) {
        setStatus('Status unavailable', null);
      }
    };

    setStatus('Checking...', 'info');
    void refreshHookStatus();

    applyBtn.addEventListener('click', async () => {
      if (!window.configAPI?.applyAutoConfig) return;
      setStatus('Applying...', 'info');
      try {
        const result = await window.configAPI.applyAutoConfig({ enableWsl: true });
        if (!result?.success) {
          setStatus(result?.error || 'Apply failed', 'error');
          return;
        }
        await refreshHookStatus();
      } catch (e) {
        setStatus(e?.message || 'Apply failed', 'error');
      }
    });
  }

  function initSummarySettingsUI() {
    const enabledCheckbox = document.getElementById('summary-enabled');
    const paneCheckbox = document.getElementById('summary-pane-enabled');
    const providerRow = document.getElementById('summary-provider-row');
    const geminiKeyRow = document.getElementById('summary-gemini-key-row');
    const paneRow = document.getElementById('summary-pane-row');
    const providerSelect = document.getElementById('summary-provider');
    const providerStatus = document.getElementById('summary-provider-status');
    const keyInput = document.getElementById('summary-gemini-api-key');
    const keyStatus = document.getElementById('summary-gemini-key-status');
    if (!enabledCheckbox || !paneCheckbox || !providerSelect || !keyInput) return;

    const applyVisibility = (enabled, provider) => {
      const isEnabled = Boolean(enabled);
      const isGemini = String(provider || '').toLowerCase() === 'gemini';
      if (providerRow) providerRow.hidden = !isEnabled;
      if (paneRow) paneRow.hidden = !isEnabled;
      if (geminiKeyRow) geminiKeyRow.hidden = !isEnabled || !isGemini;
    };

    const applySettings = (settings) => {
      const summaries = settings?.summaries || {};
      const enabled = typeof summaries.enabled === 'boolean' ? summaries.enabled : true;
      const showInPane = typeof summaries.showInPane === 'boolean' ? summaries.showInPane : true;
      const provider = typeof summaries.provider === 'string' && summaries.provider.trim()
        ? summaries.provider.trim().toLowerCase()
        : 'gemini';
      const hasKey = Boolean(summaries?.gemini?.apiKey);

      enabledCheckbox.checked = enabled;
      paneCheckbox.checked = showInPane;
      providerSelect.value = provider;
      if (keyStatus) {
        keyStatus.textContent = hasKey ? 'Saved' : 'Not set';
      }
      keyInput.placeholder = hasKey ? 'Saved' : 'Not set';
      applyVisibility(enabled, provider);
    };

    const refreshProviderStatus = async () => {
      const checkAvailability = window.aiProviderAPI?.check
        ? () => window.aiProviderAPI.check({ feature: 'summary' })
        : window.summaryAPI?.check
          ? () => window.summaryAPI.check()
          : null;
      if (!checkAvailability) return;
      const label = 'Session Summaries で使う提供元';
      try {
        const result = await checkAvailability();
        const claudeAvailable = Boolean(result?.providers?.claude?.available);
        if (providerStatus) {
          providerStatus.textContent = claudeAvailable
            ? `${label} / Claude CLI: Available`
            : `${label} / Claude CLI: Missing`;
        }
        const claudeOption = providerSelect.querySelector('option[value="claude"]');
        if (claudeOption) {
          claudeOption.disabled = !claudeAvailable;
        }
        if (!claudeAvailable && providerSelect.value === 'claude') {
          updateSettings({ summaries: { provider: 'gemini' } });
        }
      } catch (_) {
        if (providerStatus) {
          providerStatus.textContent = `${label} / Claude CLI: Unknown`;
        }
      }
    };

    const updateSettings = async (patch) => {
      if (!window.settingsAPI?.update) return;
      try {
        const result = await window.settingsAPI.update(patch || {});
        if (result?.settings) {
          applySettings(result.settings);
        }
      } catch (_) {
        // ignore
      }
    };

    const loadSettings = async () => {
      if (!window.settingsAPI?.get) return;
      try {
        const settings = await window.settingsAPI.get();
        applySettings(settings || {});
      } catch (_) {
        // ignore
      }
    };

    enabledCheckbox.addEventListener('change', () => {
      updateSettings({ summaries: { enabled: enabledCheckbox.checked } });
      applyVisibility(enabledCheckbox.checked, providerSelect.value);
    });

    paneCheckbox.addEventListener('change', () => {
      updateSettings({ summaries: { showInPane: paneCheckbox.checked } });
    });

    providerSelect.addEventListener('change', () => {
      const value = String(providerSelect.value || '').trim();
      if (!value) return;
      updateSettings({ summaries: { provider: value } });
      applyVisibility(enabledCheckbox.checked, value);
    });

    const saveKey = () => {
      const value = String(keyInput.value || '').trim();
      if (!value) return;
      updateSettings({ summaries: { gemini: { apiKey: value } } });
      keyInput.value = '';
    };

    keyInput.addEventListener('change', saveKey);
    keyInput.addEventListener('blur', saveKey);
    keyInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      saveKey();
      keyInput.blur();
    });

    if (window.settingsAPI?.onChange) {
      window.settingsAPI.onChange((payload) => {
        if (payload?.settings) {
          applySettings(payload.settings);
        }
        refreshProviderStatus();
      });
    }

    loadSettings();
    refreshProviderStatus();
  }

  window.SettingsUI = {
    initSettingsWheelInputs,
    initTerminalSettingsUI,
    initThemeSettingsUI,
    initShortcutSettingsUI,
    initShortcutSheet,
    initCheerUI,
    initAutoConfigUI,
    initSummarySettingsUI,
  };
})();
