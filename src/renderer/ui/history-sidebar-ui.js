(function () {
  'use strict';

  const OUTPUT_PREVIEW_CHARS = 180;
  const HISTORY_TOAST_DURATION_MS = 3000;
  function logHistoryDebug(payload) {
    if (window.debugAPI?.logHistory) {
      window.debugAPI.logHistory(payload);
    }
  }

  function getPathTail(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = normalized.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : raw;
  }

  function looksLikePath(value) {
    const raw = String(value || '').trim();
    if (!raw) return false;
    return raw.includes('/') || raw.includes('\\') || /^[A-Za-z]:/.test(raw);
  }

  function normalizeCwdPath(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    let normalized = raw.replace(/\\/g, '/');
    normalized = normalized.replace(/\/{2,}/g, '/');
    normalized = normalized.replace(/\/+$/, '');
    if (/^[A-Za-z]:\//.test(normalized)) {
      normalized = normalized.toLowerCase();
    }
    if (normalized.startsWith('//')) {
      const uncMatch = normalized.match(/^\/\/([^/]+)(\/.*)?$/);
      if (uncMatch) {
        const host = uncMatch[1].toLowerCase();
        normalized = `//${host}${uncMatch[2] || ''}`;
      }
    }
    return normalized;
  }

  function buildCwdKey(normalizedPath, wslDistro) {
    const pathValue = String(normalizedPath || '').trim();
    if (!pathValue) return '';
    const distro = String(wslDistro || '').trim();
    if (distro) return `wsl:${distro}|${pathValue}`;
    return pathValue;
  }

  function displayCwdFromKey(key) {
    const raw = String(key || '').trim();
    if (!raw) return '';
    if (raw.startsWith('wsl:')) {
      const divider = raw.indexOf('|');
      if (divider !== -1) return raw.slice(divider + 1) || raw;
    }
    return raw;
  }

  function chooseDisplayCwd(prev, next) {
    const prevText = String(prev || '').trim();
    const nextText = String(next || '').trim();
    if (!prevText) return nextText;
    if (!nextText) return prevText;
    const prevHasSep = /[\\/]/.test(prevText);
    const nextHasSep = /[\\/]/.test(nextText);
    if (nextHasSep && !prevHasSep) return nextText;
    if (prevHasSep === nextHasSep && nextText.length > prevText.length) return nextText;
    return prevText;
  }

  class HistorySidebarUI {
    constructor(options = {}) {
      this.store = options.store || null;
      this.tracker = options.tracker || null;
      this.historySource = String(options.historySource || 'all').trim().toLowerCase();
      this.onResume = typeof options.onResume === 'function' ? options.onResume : null;
      this.onTimeMachine = typeof options.onTimeMachine === 'function' ? options.onTimeMachine : null;
      this.summaryProvider = options.summaryProvider || null;
      const displayScope = String(options.displayScope || 'all').trim().toLowerCase();
      this.displayScope = displayScope === 'active' || displayScope === 'history' ? displayScope : 'all';

      const listId = String(options.listId || '').trim();
      const countId = String(options.countId || '').trim();
      this.sidebarEl = options.sidebarEl
        || document.getElementById(listId || 'session-group-list');
      this.sidebarCountEl = options.sidebarCountEl
        || document.getElementById(countId || 'session-sidebar-count');
      this.groupOpenState = new Map();
      this.sidebarSections = null;
      this.tooltipEl = null;
      this.tooltipTimer = null;
      this.tooltipTarget = null;
      this.tooltipHoverTarget = null;
      this.tooltipHoveringOverlay = false;
      this.tooltipDragging = false;
      this.tooltipHideTimer = null;
      this.tooltipLastOutsideAt = 0;
      this.tooltipPinned = false;
      this.tooltipDataMap = new WeakMap();
      this.tooltipLastWidth = 0;
      this.tooltipPointer = { x: 0, y: 0 };
      this.tooltipLastRect = null;
      this.tooltipLastTargetRect = null;
      this.tooltipLastPosition = null;
      this.historyToastTimer = null;
      this.missingCwdLogged = new Set();
      this.sessionStatusCache = new Map();
      this.sessionViewAt = new Map();
      this.gitState = new Map();
      this.gitAiAvailability = null;
      this.gitAiAvailabilityPromise = null;
      this.gitMenuOpenEl = null;
    }

    setHistorySource(source) {
      this.historySource = String(source || '').trim().toLowerCase() || 'all';
    }

    setHandlers({ onResume, onTimeMachine } = {}) {
      if (typeof onResume === 'function') this.onResume = onResume;
      if (typeof onTimeMachine === 'function') this.onTimeMachine = onTimeMachine;
    }

    setSummaryProvider(provider) {
      this.summaryProvider = provider || null;
    }

    init() {
      if (this.sidebarEl) {
        this.setupFancyTooltip();
        this.sidebarEl.addEventListener('click', (event) => {
          if (this.isTextSelectionInElement(event.currentTarget)) return;
          const toggleTimelineForItem = (sessionItem, { forceOpen = false } = {}) => {
            if (!sessionItem) return false;
            const sessionId = sessionItem.dataset.sessionId || '';
            const source = sessionItem.dataset.source || '';
            const blockId = sessionItem.dataset.blockId || '';
            if (!sessionId || !blockId) return false;
            const sessionKey = sessionItem.dataset.sessionKey || '';
            if (sessionKey) {
              this.markSessionViewed(sessionKey);
            }

            const updateToggleAria = () => {
              const expander = sessionItem.querySelector('.session-item-expander');
              if (!expander) return;
              expander.setAttribute('aria-expanded', sessionItem.classList.contains('show-timeline') ? 'true' : 'false');
            };

            const isCurrentlyOpen = sessionItem.classList.contains('show-timeline');
            if (isCurrentlyOpen) {
              if (forceOpen) return true;
              sessionItem.classList.remove('show-timeline');
              updateToggleAria();
              return true;
            }

            sessionItem.classList.add('show-timeline');
            this.loadSessionTimeline(sessionId, source, blockId, sessionItem);
            updateToggleAria();
            return true;
          };

          // Handle group header collapse/expand
          const groupHeader = event.target.closest('.session-group-header');
          if (groupHeader) {
            const groupEl = groupHeader.closest('.session-group');
            if (groupEl) {
              const groupKey = groupHeader.dataset.groupKey || groupHeader.dataset.cwd || '';
              const scope = groupHeader.dataset.scope || groupEl.dataset.scope || 'history';
              if (groupKey) {
                const isOpen = groupEl.classList.contains('open');
                groupEl.classList.toggle('open');
                const stateKey = this.getGroupStateKey(groupKey, scope);
                this.groupOpenState.set(stateKey, !isOpen);
                if (!isOpen) {
                  this.ensureGroupBodyRendered(groupEl, { scope, groupKey });
                }
              }
            }
            return;
          }

          // Handle timeline expander (left chevron)
          const expander = event.target.closest('.session-item-expander');
          if (expander) {
            event.stopPropagation();
            const sessionItem = expander.closest('.session-item');
            if (!sessionItem) return;
            toggleTimelineForItem(sessionItem, { forceOpen: false });
            return;
          }

          const timelineEntry = event.target.closest('.session-timeline-entry');
          if (timelineEntry) return;

          if (event.target.closest('.session-timeline')) {
            return;
          }

          const sessionItem = event.target.closest('.session-item');
          if (!sessionItem) return;
          event.stopPropagation();
          const sessionId = sessionItem.dataset.sessionId || '';
          const source = sessionItem.dataset.source || '';
          const cwd = sessionItem.dataset.cwd || '';
          const wslDistro = sessionItem.dataset.wslDistro || '';
          const sessionKey = sessionItem.dataset.sessionKey || '';
          if (!sessionId) return;
          const rawSource = String(source || '').trim().toLowerCase();
          const safeSource = rawSource === 'all' ? '' : rawSource;
          if (sessionKey) {
            this.markSessionViewed(sessionKey);
          }
          if (this.onResume) {
            this.onResume({ sessionId, source: safeSource, cwd, wslDistro, fromEl: sessionItem });
          }
        });
      }
    }

    isTextSelectionInElement(element) {
      if (!element) return false;
      const selection = window.getSelection?.();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
      const { anchorNode, focusNode } = selection;
      const anchorEl = anchorNode?.nodeType === 1 ? anchorNode : anchorNode?.parentElement;
      const focusEl = focusNode?.nodeType === 1 ? focusNode : focusNode?.parentElement;
      if (!anchorEl && !focusEl) return false;
      return element.contains(anchorEl) || element.contains(focusEl);
    }

    setupFancyTooltip() {
      if (!this.sidebarEl) return;
      if (!this.tooltipEl) {
        const tooltip = document.createElement('div');
        tooltip.className = 'fancy-tooltip-overlay';
        document.body.appendChild(tooltip);
        this.tooltipEl = tooltip;
      }

      const applyPinnedState = () => {
        if (!this.tooltipEl) return;
        this.tooltipEl.classList.toggle('pinned', this.tooltipPinned);
        const scrollables = this.tooltipEl.querySelectorAll('[data-scrollable="true"]');
        scrollables.forEach((el) => {
          el.classList.toggle('tooltip-value-scrollable', this.tooltipPinned);
        });
      };

      const updateTooltipWidthCache = () => {
        if (!this.tooltipEl) return;
        const rect = this.tooltipEl.getBoundingClientRect();
        if (rect.width > 0) {
          this.tooltipLastWidth = Math.ceil(rect.width);
        }
      };

      const getFullTooltipData = (target) => {
        const timelineEntry = target.closest('.session-timeline-entry');
        if (timelineEntry) {
          const stored = this.tooltipDataMap?.get(timelineEntry) || null;
          if (stored) return stored;
          const blockId = timelineEntry.dataset.blockId || '';
          const block = blockId ? this.tracker?.getBlockById?.(blockId) : null;
          return this.store?.buildFullTooltipData?.(block) || null;
        }
        const sessionItem = target.closest('.session-item');
        if (sessionItem) {
          const sessionKey = sessionItem.dataset.sessionKey || '';
          let block = null;
          if (sessionKey && this.store?.sessionMap?.has?.(sessionKey)) {
            block = this.store.sessionMap.get(sessionKey);
          } else {
            const source = sessionItem.dataset.source || this.historySource;
            const cache = this.store?.getSessionCache?.(source);
            block = sessionKey ? cache?.sessionMap?.get(sessionKey) || null : null;
          }
          if (!block) {
            const blockId = sessionItem.dataset.blockId || '';
            block = blockId ? this.tracker?.getBlockById?.(blockId) : null;
          }
          return this.store?.buildFullTooltipData?.(block) || null;
        }
        return null;
      };

      const positionTooltip = (target, { preservePosition = false } = {}) => {
        if (!this.tooltipEl || !target) return;
        const rect = target.getBoundingClientRect();
        const margin = 12;
        const viewportPadding = 8;
        this.tooltipEl.style.left = '0px';
        this.tooltipEl.style.top = '0px';
        const maxHeight = Math.max(0, window.innerHeight - viewportPadding * 2);
        this.tooltipEl.style.maxHeight = `${Math.floor(maxHeight)}px`;
        this.tooltipEl.style.overflowY = 'auto';
        const tipRect = this.tooltipEl.getBoundingClientRect();
        if (preservePosition && this.tooltipLastPosition) {
          const prevLeft = Number(this.tooltipLastPosition.left);
          const prevTop = Number(this.tooltipLastPosition.top);
          const fits = Number.isFinite(prevLeft) && Number.isFinite(prevTop)
            && prevLeft >= viewportPadding
            && prevTop >= viewportPadding
            && prevLeft + tipRect.width <= window.innerWidth - viewportPadding
            && prevTop + tipRect.height <= window.innerHeight - viewportPadding;
          if (fits) {
            this.tooltipEl.style.left = `${Math.round(prevLeft)}px`;
            this.tooltipEl.style.top = `${Math.round(prevTop)}px`;
            this.tooltipLastTargetRect = rect;
            this.tooltipLastRect = this.tooltipEl.getBoundingClientRect();
            this.tooltipLastPosition = { left: prevLeft, top: prevTop };
            return;
          }
        }
        let left = rect.right + margin;
        if (left + tipRect.width > window.innerWidth - viewportPadding) {
          left = rect.left - tipRect.width - margin;
        }
        if (left < viewportPadding) left = viewportPadding;
        let top = rect.top + 2;
        if (top + tipRect.height > window.innerHeight - viewportPadding) {
          const aboveTop = rect.bottom - tipRect.height - 2;
          top = aboveTop >= viewportPadding
            ? aboveTop
            : Math.max(viewportPadding, window.innerHeight - tipRect.height - viewportPadding);
        }
        if (top < viewportPadding) top = viewportPadding;
        this.tooltipEl.style.left = `${Math.round(left)}px`;
        this.tooltipEl.style.top = `${Math.round(top)}px`;
        this.tooltipLastTargetRect = rect;
        this.tooltipLastRect = this.tooltipEl.getBoundingClientRect();
        this.tooltipLastPosition = { left, top };
      };

      const renderTooltip = (target, { pinned = false } = {}) => {
        if (!this.tooltipEl || !target) return false;
        const text = target.getAttribute('data-tooltip') || '';
        if (!text) return false;
        this.tooltipTarget = target;
        this.tooltipEl.replaceChildren();
        const fullData = pinned ? getFullTooltipData(target) : null;
        const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
        const labelKeys = new Set(['Input', 'Output', 'CWD']);
        const scrollableKeys = new Set(['Input', 'Output']);

        const appendLabeledRow = (labelText, valueText, { scrollable = false, useTextarea = false } = {}) => {
          const row = document.createElement('div');
          row.className = 'tooltip-row';
          row.dataset.label = labelText;
          const label = document.createElement('div');
          label.className = 'tooltip-label';
          label.textContent = labelText;
          let value;
          if (useTextarea) {
            value = document.createElement('textarea');
            value.className = 'tooltip-value tooltip-value-textarea';
            value.readOnly = true;
            value.spellcheck = false;
            value.value = valueText;
          } else {
            value = document.createElement('div');
            value.className = 'tooltip-value';
            value.textContent = valueText;
          }
          if (scrollable) {
            value.dataset.scrollable = 'true';
          }
          row.appendChild(label);
          row.appendChild(value);
          this.tooltipEl.appendChild(row);
        };

        lines.forEach((line) => {
          const match = line.match(/^([^:]+):\s*(.*)$/);
          if (match && labelKeys.has(match[1])) {
            const label = match[1];
            const value = match[2] || '';
            appendLabeledRow(label, value, { scrollable: scrollableKeys.has(label) });
          } else {
            const row = document.createElement('div');
            row.className = 'tooltip-row tooltip-plain';
            row.textContent = line;
            this.tooltipEl.appendChild(row);
          }
        });

        if (pinned && fullData) {
          const labelMap = new Map();
          this.tooltipEl.querySelectorAll('.tooltip-row').forEach((row) => {
            const label = row?.dataset?.label;
            if (!label) return;
            labelMap.set(label, row);
          });

          const setRowValue = (label, value, { scrollable = false, useTextarea = false } = {}) => {
            if (!value) return;
            const existing = labelMap.get(label);
            if (!existing) {
              appendLabeledRow(label, value, { scrollable, useTextarea });
              return;
            }
            let valueEl = existing.querySelector('.tooltip-value');
            if (useTextarea) {
              if (!valueEl || valueEl.tagName.toLowerCase() !== 'textarea') {
                const textarea = document.createElement('textarea');
                textarea.className = 'tooltip-value tooltip-value-textarea';
                textarea.readOnly = true;
                textarea.spellcheck = false;
                existing.replaceChildren(existing.querySelector('.tooltip-label'), textarea);
                valueEl = textarea;
              }
              valueEl.value = value;
              const minHeight = Number.parseFloat(getComputedStyle(valueEl).minHeight) || 64;
              const maxHeight = 200;
              valueEl.style.height = 'auto';
              const nextHeight = Math.min(Math.max(valueEl.scrollHeight, minHeight), maxHeight);
              valueEl.style.height = `${Math.ceil(nextHeight)}px`;
            } else if (valueEl) {
              valueEl.textContent = value;
            }
            if (scrollable && valueEl) {
              valueEl.dataset.scrollable = 'true';
            }
          };

          setRowValue('Input', fullData.input, { scrollable: true, useTextarea: true });
          setRowValue('Output', fullData.output, { scrollable: true, useTextarea: true });
          setRowValue('CWD', fullData.cwd);
          setRowValue('Time', fullData.timeText);
        }

        if (!pinned) {
          const hint = document.createElement('div');
          hint.className = 'tooltip-hint';
          const hintKey = document.createElement('div');
          hintKey.className = 'tooltip-hint-key';
          hintKey.textContent = 'Shift';
          const hintText = document.createElement('div');
          hintText.className = 'tooltip-hint-text';
          hintText.textContent = 'to expand tooltip';
          hint.appendChild(hintKey);
          hint.appendChild(hintText);
          this.tooltipEl.appendChild(hint);
        } else {
          const closeBtn = document.createElement('button');
          closeBtn.type = 'button';
          closeBtn.className = 'tooltip-close';
          closeBtn.setAttribute('aria-label', 'Close tooltip');
          closeBtn.textContent = '×';
          closeBtn.addEventListener('click', () => {
            hideTooltip({ force: true });
          });
          this.tooltipEl.appendChild(closeBtn);
        }

        this.tooltipPinned = Boolean(pinned);
        this.tooltipEl.style.width = '';
        this.tooltipEl.classList.add('show');
        applyPinnedState();
        updateTooltipWidthCache();
        return true;
      };

      const hideTooltip = ({ force = false } = {}) => {
        if (!this.tooltipEl) return;
        if (this.tooltipPinned && !force) return;
        this.tooltipPinned = false;
        this.tooltipLastWidth = 0;
        this.tooltipEl.style.width = '';
        this.tooltipEl.classList.remove('pinned');
        this.tooltipEl.classList.remove('show');
        this.tooltipTarget = null;
        this.tooltipHoveringOverlay = false;
        this.tooltipDragging = false;
        if (this.tooltipTimer) {
          clearTimeout(this.tooltipTimer);
          this.tooltipTimer = null;
        }
      };

      const pinTooltip = () => {
        if (!this.tooltipEl || !this.tooltipTarget || this.tooltipPinned) return;
        if (!this.tooltipEl.classList.contains('show')) return;
        const rect = this.tooltipEl.getBoundingClientRect();
        const keepWidth = this.tooltipLastWidth || Math.ceil(rect.width);
        this.tooltipPinned = true;
        renderTooltip(this.tooltipTarget, { pinned: true });
        applyPinnedState();
        if (keepWidth) {
          this.tooltipEl.style.width = `${keepWidth}px`;
        }
        positionTooltip(this.tooltipTarget, { preservePosition: true });
      };

      const shouldIgnoreHide = (target) => {
        if (!target) return false;
        if (this.tooltipEl && this.tooltipEl.contains(target)) return true;
        if (this.tooltipTarget && this.tooltipTarget.contains(target)) return true;
        return false;
      };

      const SHOW_DELAY_MS = 5;
      const HIDE_DELAY_MS = 120;
      const SWITCH_WINDOW_MS = 100;
      const BRIDGE_GRACE_MS = 240;

      const isPointInRect = (x, y, rect, margin = 0) => {
        if (!rect) return false;
        return x >= rect.left - margin
          && x <= rect.right + margin
          && y >= rect.top - margin
          && y <= rect.bottom + margin;
      };

      const getBridgeRect = (targetRect, tipRect, margin = 6) => {
        if (!targetRect || !tipRect) return null;
        if (tipRect.left >= targetRect.right) {
          return {
            left: targetRect.right,
            right: tipRect.left,
            top: Math.min(targetRect.top, tipRect.top) - margin,
            bottom: Math.max(targetRect.bottom, tipRect.bottom) + margin,
          };
        }
        if (targetRect.left >= tipRect.right) {
          return {
            left: tipRect.right,
            right: targetRect.left,
            top: Math.min(targetRect.top, tipRect.top) - margin,
            bottom: Math.max(targetRect.bottom, tipRect.bottom) + margin,
          };
        }
        if (tipRect.top >= targetRect.bottom) {
          return {
            left: Math.min(targetRect.left, tipRect.left) - margin,
            right: Math.max(targetRect.right, tipRect.right) + margin,
            top: targetRect.bottom,
            bottom: tipRect.top,
          };
        }
        if (targetRect.top >= tipRect.bottom) {
          return {
            left: Math.min(targetRect.left, tipRect.left) - margin,
            right: Math.max(targetRect.right, tipRect.right) + margin,
            top: tipRect.bottom,
            bottom: targetRect.top,
          };
        }
        return null;
      };

      const isWithinBridge = (x, y) => {
        const bridge = getBridgeRect(this.tooltipLastTargetRect, this.tooltipLastRect);
        return isPointInRect(x, y, bridge, 6);
      };

      const cancelHide = () => {
        if (this.tooltipHideTimer) {
          clearTimeout(this.tooltipHideTimer);
          this.tooltipHideTimer = null;
        }
      };

      const scheduleHide = () => {
        if (this.tooltipPinned) return;
        if (this.tooltipDragging) return;
        cancelHide();
        this.tooltipHideTimer = setTimeout(() => {
          this.tooltipHideTimer = null;
          if (this.tooltipPinned || this.tooltipDragging) return;
          const pointer = this.tooltipPointer || { x: -1, y: -1 };
          const hoveringTarget = this.tooltipTarget?.matches?.(':hover');
          if (this.tooltipHoveringOverlay || hoveringTarget) return;
          if (isWithinBridge(pointer.x, pointer.y)) {
            const sinceOutside = this.tooltipLastOutsideAt
              ? Date.now() - this.tooltipLastOutsideAt
              : 0;
            if (sinceOutside < BRIDGE_GRACE_MS) {
              scheduleHide();
              return;
            }
          }
          hideTooltip({ force: true });
        }, HIDE_DELAY_MS);
      };

      const updatePointer = (event) => {
        this.tooltipPointer = { x: event.clientX, y: event.clientY };
        if (!this.tooltipEl || !this.tooltipEl.classList.contains('show')) return;
        if (this.tooltipPinned || this.tooltipDragging) return;
        const hoveringTarget = this.tooltipTarget?.matches?.(':hover');
        if (this.tooltipHoveringOverlay || hoveringTarget || isWithinBridge(event.clientX, event.clientY)) {
          cancelHide();
        }
      };

      if (!this.tooltipPointerListenerAttached) {
        document.addEventListener('pointermove', updatePointer, { passive: true });
        document.addEventListener('pointerup', () => {
          this.tooltipDragging = false;
        });
        this.tooltipPointerListenerAttached = true;
      }

      if (this.tooltipEl && !this.tooltipOverlayListenersAttached) {
        this.tooltipEl.addEventListener('pointerenter', () => {
          this.tooltipHoveringOverlay = true;
          cancelHide();
        });
        this.tooltipEl.addEventListener('pointerleave', () => {
          this.tooltipHoveringOverlay = false;
          scheduleHide();
        });
        this.tooltipEl.addEventListener('pointerdown', (event) => {
          if (event.button === 0) {
            this.tooltipDragging = true;
          }
          cancelHide();
        });
        this.tooltipOverlayListenersAttached = true;
      }

      const showTooltip = (event) => {
        if (this.tooltipPinned) return;
        const target = event.target.closest('.fancy-tooltip[data-tooltip]');
        if (!target) return;
        this.tooltipPointer = { x: event.clientX, y: event.clientY };
        this.tooltipHoverTarget = target;
        cancelHide();

        if (this.tooltipTimer) {
          clearTimeout(this.tooltipTimer);
          this.tooltipTimer = null;
        }

        const isSameTarget = this.tooltipTarget === target;
        const isShowing = Boolean(this.tooltipEl?.classList.contains('show'));
        if (isShowing) {
          if (isSameTarget) return;
          const sinceOutside = this.tooltipLastOutsideAt
            ? Date.now() - this.tooltipLastOutsideAt
            : 0;
          if (!this.tooltipLastOutsideAt || sinceOutside <= SWITCH_WINDOW_MS) {
            if (!renderTooltip(target)) return;
            positionTooltip(target);
            return;
          }
        }

        this.tooltipTimer = setTimeout(() => {
          this.tooltipTimer = null;
          if (this.tooltipHoverTarget !== target) return;
          if (!target.isConnected) return;
          if (!target.matches(':hover')) return;
          if (!renderTooltip(target)) return;
          positionTooltip(target);
        }, SHOW_DELAY_MS);
      };

      const clearTooltip = (event) => {
        const from = event.target.closest('.fancy-tooltip[data-tooltip]');
        if (!from) return;
        if (this.tooltipHoverTarget === from) {
          this.tooltipHoverTarget = null;
        }
        const to = event.relatedTarget;
        const toTooltip = to?.closest?.('.fancy-tooltip[data-tooltip]');
        const toOverlay = this.tooltipEl && to && this.tooltipEl.contains(to);
        if (toTooltip || toOverlay) {
          this.tooltipLastOutsideAt = 0;
          if (this.tooltipTimer) {
            clearTimeout(this.tooltipTimer);
            this.tooltipTimer = null;
          }
          return;
        }
        if (this.tooltipTimer) {
          clearTimeout(this.tooltipTimer);
          this.tooltipTimer = null;
        }
        if (this.tooltipTarget !== from) return;
        this.tooltipLastOutsideAt = Date.now();
        scheduleHide();
      };

      this.sidebarEl.addEventListener('pointerenter', showTooltip, true);
      this.sidebarEl.addEventListener('pointerleave', clearTooltip, true);
      this.sidebarEl.addEventListener('pointerleave', (event) => {
        const to = event.relatedTarget;
        const toOverlay = this.tooltipEl && to && this.tooltipEl.contains(to);
        if (toOverlay || this.tooltipHoveringOverlay) return;
        this.tooltipHoverTarget = null;
        this.tooltipLastOutsideAt = Date.now();
        scheduleHide();
      });
      document.addEventListener('keydown', (event) => {
        if (!this.tooltipEl || !this.tooltipEl.classList.contains('show')) return;
        if (event.key === 'Shift') {
          pinTooltip();
          return;
        }
        if (event.key === 'Escape') {
          hideTooltip({ force: true });
        }
      });

      document.addEventListener('pointerdown', (event) => {
        if (!this.tooltipEl || !this.tooltipEl.classList.contains('show')) return;
        if (shouldIgnoreHide(event.target)) return;
        hideTooltip({ force: true });
      });

      document.addEventListener('focusin', (event) => {
        if (!this.tooltipEl || !this.tooltipEl.classList.contains('show')) return;
        if (shouldIgnoreHide(event.target)) return;
        hideTooltip({ force: true });
      });

      const scrollEl = this.sidebarEl.closest('.session-sidebar-body');
      scrollEl?.addEventListener('scroll', () => hideTooltip({ force: true }), { passive: true });
      window.addEventListener('resize', () => hideTooltip({ force: true }));
      window.addEventListener('blur', () => hideTooltip({ force: true }));
    }

    getGroupStateKey(groupKey, scope) {
      const safeScope = String(scope || 'history').trim() || 'history';
      const safeKey = String(groupKey || '').trim();
      return `${safeScope}:${safeKey}`;
    }

    ensureGroupOpenState(groups, scope, defaultOpen) {
      if (!Array.isArray(groups) || groups.length === 0) return;
      const safeScope = String(scope || 'history').trim() || 'history';
      const openByDefault = Boolean(defaultOpen);
      for (const group of groups) {
        const stateKey = this.getGroupStateKey(group.key, safeScope);
        if (!this.groupOpenState.has(stateKey)) {
          this.groupOpenState.set(stateKey, openByDefault);
        }
      }
    }

    ensureGroupBodyRendered(groupEl, { scope, groupKey } = {}) {
      if (!groupEl || !this.store) return;
      if (!groupEl.classList.contains('open')) return;
      const body = groupEl.querySelector('.session-group-body');
      if (!body || body.dataset.rendered) return;
      const scopeKey = scope || groupEl.dataset.scope || 'history';
      const key = groupKey || groupEl.dataset.groupKey || groupEl.dataset.cwd || '';
      if (!key) return;
      const sourceKey = this.store.getSourceKey?.(this.historySource) || this.historySource;
      const cache = this.store.getSessionCache?.(sourceKey);
      const sessions = cache?.sessions || [];
      const { activeSessions } = this.splitSessionsByBinding(sessions);
      const list = scopeKey === 'active' ? activeSessions : sessions;
      const groups = this.groupSessionsByCwd(list);
      const match = groups.find(group => group.key === key);
      if (!match) return;
      body.dataset.rendered = '1';
      this.patchSidebarSessionItems(body, match.sessions);
    }

    buildBoundSessionPlaceholder(entry) {
      if (!entry || typeof entry !== 'object') return null;
      const sessionKey = String(entry.session_key || '').trim();
      if (!sessionKey) return null;
      const source = String(entry.source || '').trim().toLowerCase() || this.historySource || 'all';
      let sessionId = String(entry.session_id || '').trim();
      if (!sessionId && sessionKey.includes(':')) {
        sessionId = sessionKey.split(':').slice(1).join(':');
      }
      if (!sessionId) return null;
      const paneId = String(entry.pane_id || '').trim();
      const timestamp = Number(entry.updated_at) || Date.now();
      const cwd = String(entry.cwd || '').trim()
        || this.tracker?.getPaneCwd?.(paneId)
        || '';
      const wslDistro = String(entry.wsl_distro || '').trim();
      return {
        id: `bound:${sessionKey}`,
        block_id: `bound:${sessionKey}`,
        session_id: sessionId,
        source,
        created_at: timestamp,
        last_output_at: timestamp,
        cwd,
        wsl_distro: wslDistro,
        pane_id: paneId,
        inputs: [],
        input: '',
        output_text: '',
      };
    }

    splitSessionsByBinding(sessions) {
      const activeSessions = [];
      const historySessions = [];
      const list = Array.isArray(sessions) ? sessions : [];
      const boundEntries = this.tracker?.getBoundSessionEntries?.() || [];
      const boundKeys = new Set();
      boundEntries.forEach((entry) => {
        const key = String(entry?.session_key || '').trim();
        if (key) boundKeys.add(key);
      });
      if (list.length === 0) {
        if (boundEntries.length === 0) {
          return { activeSessions, historySessions };
        }
        for (const entry of boundEntries) {
          const placeholder = this.buildBoundSessionPlaceholder(entry);
          if (placeholder) activeSessions.push(placeholder);
        }
        return { activeSessions, historySessions };
      }
      if (boundKeys.size === 0) {
        return { activeSessions, historySessions: list.slice() };
      }
      const seenKeys = new Set();
      for (const session of list) {
        const key = this.store?.buildSessionKey?.(session) || '';
        if (key) seenKeys.add(key);
        if (key && boundKeys.has(key)) {
          activeSessions.push(session);
        } else {
          historySessions.push(session);
        }
      }
      if (boundEntries.length) {
        for (const entry of boundEntries) {
          const key = String(entry?.session_key || '').trim();
          if (!key || seenKeys.has(key)) continue;
          const placeholder = this.buildBoundSessionPlaceholder(entry);
          if (!placeholder) continue;
          activeSessions.push(placeholder);
          seenKeys.add(key);
        }
      }
      return { activeSessions, historySessions };
    }

    buildSidebarSection(sectionKey, titleText) {
      const section = document.createElement('div');
      section.className = `session-section session-section-${sectionKey}`;
      section.dataset.section = sectionKey;

      const header = document.createElement('div');
      header.className = 'session-section-header';

      const title = document.createElement('span');
      title.className = 'session-sidebar-title';
      title.textContent = titleText;
      header.appendChild(title);
      section.appendChild(header);

      const list = document.createElement('div');
      list.className = `session-group-list session-group-list-${sectionKey}`;
      section.appendChild(list);

      return { section, header, title, list };
    }

    ensureSidebarSections() {
      if (!this.sidebarEl) return null;
      const activeSection = this.sidebarEl.querySelector('.session-section-active');
      const historySection = this.sidebarEl.querySelector('.session-section-history');
      const activeList = activeSection?.querySelector('.session-group-list');
      const historyList = historySection?.querySelector('.session-group-list');
      const scope = this.displayScope || 'all';

      if (scope === 'active') {
        if (activeSection && activeList) {
          activeSection.classList.add('is-compact');
          historySection?.remove?.();
          this.sidebarSections = {
            activeSection,
            historySection: null,
            activeList,
            historyList: null,
          };
          return this.sidebarSections;
        }
        const active = this.buildSidebarSection('active', 'Active Agents');
        active.section.classList.add('is-compact');
        this.sidebarEl.replaceChildren(active.section);
        this.sidebarSections = {
          activeSection: active.section,
          historySection: null,
          activeList: active.list,
          historyList: null,
        };
        return this.sidebarSections;
      }

      if (scope === 'history') {
        if (historySection && historyList) {
          historySection.classList.add('is-compact');
          activeSection?.remove?.();
          this.sidebarSections = {
            activeSection: null,
            historySection,
            activeList: null,
            historyList,
          };
          return this.sidebarSections;
        }
        const history = this.buildSidebarSection('history', 'History');
        history.section.classList.add('is-compact');
        this.sidebarEl.replaceChildren(history.section);
        this.sidebarSections = {
          activeSection: null,
          historySection: history.section,
          activeList: null,
          historyList: history.list,
        };
        return this.sidebarSections;
      }

      if (activeSection && historySection && activeList && historyList) {
        this.sidebarSections = {
          activeSection,
          historySection,
          activeList,
          historyList,
        };
        return this.sidebarSections;
      }

      const active = this.buildSidebarSection('active', 'Active Agents');
      const history = this.buildSidebarSection('history', 'History');
      this.sidebarEl.replaceChildren(active.section, history.section);

      this.sidebarSections = {
        activeSection: active.section,
        historySection: history.section,
        activeList: active.list,
        historyList: history.list,
      };
      return this.sidebarSections;
    }

    renderActiveEmptyState(container) {
      if (!container) return;
      const empty = document.createElement('div');
      empty.className = 'session-section-empty';
      empty.textContent = 'No active agents right now';
      container.replaceChildren(empty);
    }

    clearActiveEmptyState(container) {
      if (!container) return;
      const empty = container.querySelector('.session-section-empty');
      if (empty) empty.remove();
    }

    renderSidebar({ loadingSessions = false } = {}) {
      if (!this.sidebarEl) return;
      const key = this.store?.getSourceKey?.(this.historySource) || this.historySource;
      const cache = this.store?.getSessionCache?.(key);
      const sessions = cache?.sessions || [];
      const { activeSessions } = this.splitSessionsByBinding(sessions);
      const scope = this.displayScope || 'all';
      const count = scope === 'active'
        ? activeSessions.length
        : scope === 'history'
          ? sessions.length
          : sessions.length;

      if (this.sidebarCountEl) {
        this.sidebarCountEl.textContent = String(count);
      }

      if (loadingSessions && sessions.length === 0) {
        const loading = document.createElement('div');
        loading.className = 'session-sidebar-loading';
        loading.textContent = 'Loading...';
        this.sidebarEl.replaceChildren(loading);
        this.sidebarSections = null;
        return;
      }

      if (scope !== 'active' && sessions.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'session-sidebar-empty';
        empty.textContent = 'No sessions yet.';
        this.sidebarEl.replaceChildren(empty);
        this.sidebarSections = null;
        return;
      }

      const sections = this.ensureSidebarSections();
      if (!sections) return;

      if (scope === 'active') {
        const activeGroups = this.groupSessionsByCwd(activeSessions);
        this.ensureGroupOpenState(activeGroups, 'active', true);
        if (activeSessions.length === 0) {
          this.renderActiveEmptyState(sections.activeList);
        } else {
          this.clearActiveEmptyState(sections.activeList);
          this.patchSidebarGroups(sections.activeList, activeGroups, { scope: 'active' });
        }
        return;
      }

      if (scope === 'history') {
        const historyGroups = this.groupSessionsByCwd(sessions);
        this.ensureGroupOpenState(historyGroups, 'history', false);
        this.patchSidebarGroups(sections.historyList, historyGroups, { scope: 'history' });
        return;
      }

      sections.activeSection?.classList.remove('is-hidden');
      sections.historySection?.classList.remove('is-compact');

      const activeGroups = this.groupSessionsByCwd(activeSessions);
      const historyGroups = this.groupSessionsByCwd(sessions);

      this.ensureGroupOpenState(activeGroups, 'active', true);
      this.ensureGroupOpenState(historyGroups, 'history', false);

      if (activeSessions.length === 0) {
        this.renderActiveEmptyState(sections.activeList);
      } else {
        this.clearActiveEmptyState(sections.activeList);
        this.patchSidebarGroups(sections.activeList, activeGroups, { scope: 'active' });
      }
      this.patchSidebarGroups(sections.historyList, historyGroups, { scope: 'history' });
    }

    patchSidebarGroups(container, groups, { scope } = {}) {
      if (!container) return;
      const existingGroups = new Map();
      for (const groupEl of container.querySelectorAll('.session-group')) {
        const header = groupEl.querySelector('.session-group-header');
        const key = groupEl.dataset.groupKey || groupEl.dataset.cwd || header?.dataset?.groupKey || header?.dataset?.cwd || '';
        if (key) {
          groupEl.dataset.groupKey = key;
          groupEl.dataset.cwd = key;
          if (scope) {
            groupEl.dataset.scope = scope;
          }
          existingGroups.set(key, groupEl);
        }
      }

      const orderedGroups = [];
      const seenKeys = new Set();

      for (const group of groups) {
        let groupEl = existingGroups.get(group.key);
        if (!groupEl) {
          groupEl = this.renderCwdGroup(group, { scope });
        } else {
          this.updateCwdGroup(groupEl, group, { scope });
        }
        orderedGroups.push(groupEl);
        seenKeys.add(group.key);
      }

      for (const [key, groupEl] of existingGroups) {
        if (!seenKeys.has(key)) {
          groupEl.remove();
        }
      }
      if (scope === 'active') {
        for (const key of this.gitState.keys()) {
          if (!seenKeys.has(key)) {
            this.gitState.delete(key);
          }
        }
      }

      let cursor = container.firstElementChild;
      for (const groupEl of orderedGroups) {
        if (groupEl === cursor) {
          cursor = cursor.nextElementSibling;
          continue;
        }
        container.insertBefore(groupEl, cursor);
      }
    }

    getGitState(key) {
      if (!key) return null;
      if (!this.gitState.has(key)) {
        this.gitState.set(key, {
          availability: null,
          action: '',
          panelOpen: false,
          status: null,
          statusLoading: false,
          message: '',
          result: null,
          aiAvailable: null,
          aiLoading: false,
        });
      }
      return this.gitState.get(key);
    }

    async ensureGitAiAvailability() {
      if (this.gitAiAvailability !== null) return this.gitAiAvailability;
      if (this.gitAiAvailabilityPromise) return this.gitAiAvailabilityPromise;
      if (!window.aiProviderAPI?.check) {
        this.gitAiAvailability = false;
        return this.gitAiAvailability;
      }
      this.gitAiAvailabilityPromise = window.aiProviderAPI.check({ feature: 'commitMessage' })
        .then((result) => {
          const available = Boolean(result?.available);
          this.gitAiAvailability = available;
          return available;
        })
        .catch(() => {
          this.gitAiAvailability = false;
          return false;
        })
        .finally(() => {
          this.gitAiAvailabilityPromise = null;
        });
      return this.gitAiAvailabilityPromise;
    }

    async requestGitAvailability(group) {
      const key = group?.key;
      const state = this.getGitState(key);
      if (!state || state.availability) return;
      if (!window.gitAPI?.check) {
        state.availability = { available: false, reason: 'missing-api' };
        return;
      }
      const payload = { cwd: group?.cwd || '', wslDistro: group?.wslDistro || '' };
      try {
        const result = await window.gitAPI.check(payload);
        state.availability = result || { available: false, reason: 'unknown' };
      } catch (_) {
        state.availability = { available: false, reason: 'error' };
      }
    }

    ensureGitMenuCloseHandlers() {
      if (this.gitMenuHandlerAttached) return;
      document.addEventListener('click', (event) => {
        if (!this.gitMenuOpenEl) return;
        if (this.gitMenuOpenEl.contains(event.target)) return;
        this.gitMenuOpenEl.classList.remove('show');
        this.gitMenuOpenEl = null;
      });
      this.gitMenuHandlerAttached = true;
    }

    getGitActionMeta(state) {
      const status = state?.status || null;
      const total = status?.counts?.total;
      const ahead = Number(status?.ahead || 0);
      const hasChanges = Number.isFinite(total) ? total > 0 : null;
      const canPush = Number.isFinite(total) ? ahead > 0 : null;
      const autoAction = hasChanges ? 'commit' : (canPush ? 'push' : 'commit');
      return {
        action: state?.action || autoAction,
        hasChanges,
        canPush,
        ahead,
      };
    }

    async loadGitStatus(group, state, panelEl) {
      if (!window.gitAPI?.status) return;
      if (state.statusLoading) return;
      state.statusLoading = true;
      try {
        const result = await window.gitAPI.status({ cwd: group?.cwd || '', wslDistro: group?.wslDistro || '' });
        if (result?.ok) {
          state.status = result;
        } else {
          state.status = null;
        }
      } catch (_) {
        state.status = null;
      } finally {
        state.statusLoading = false;
        this.renderGitPanel(panelEl, group, state);
      }
    }

    attachGitControls(groupEl, header, group) {
      if (!groupEl || !header) return;
      const key = group?.key || '';
      const state = this.getGitState(key);
      if (!state) return;
      this.ensureGitMenuCloseHandlers();

      let actions = header.querySelector('.session-group-git-actions');
      if (!actions) {
        actions = document.createElement('div');
        actions.className = 'session-group-git-actions';
        actions.classList.add('is-hidden');

        const mainBtn = document.createElement('button');
        mainBtn.className = 'session-group-git-main';
        mainBtn.type = 'button';
        mainBtn.title = 'Commit';
        mainBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 12h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M16 12h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
        mainBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          this.toggleGitPanel(groupEl, group, { open: true, focusInput: true });
        });

        actions.appendChild(mainBtn);
        header.appendChild(actions);
      }

      if (!state.availability) {
        void this.requestGitAvailability(group).then(() => {
          this.updateGitControls(groupEl, group);
        });
      } else {
        this.updateGitControls(groupEl, group);
      }
    }

    updateGitControls(groupEl, group) {
      const key = group?.key || '';
      const state = this.getGitState(key);
      if (!state) return;
      const header = groupEl?.querySelector?.('.session-group-header');
      const actions = header?.querySelector?.('.session-group-git-actions');
      if (!actions) return;
      const available = Boolean(state.availability?.available);
      actions.classList.toggle('is-hidden', !available);
    }

    async triggerCommitMessageAI(group, state, panelEl) {
      if (!window.commitMessageAPI?.generate) return;
      state.aiLoading = true;
      this.renderGitPanel(panelEl, group, state);
      try {
        const result = await window.commitMessageAPI.generate({
          cwd: group?.cwd || '',
          wslDistro: group?.wslDistro || '',
        });
        if (result?.ok && result?.message) {
          state.message = result.message;
        } else {
          state.result = { tone: 'error', message: result?.error || 'AI generation failed' };
        }
      } catch (_) {
        state.result = { tone: 'error', message: 'AI generation failed' };
      } finally {
        state.aiLoading = false;
        this.renderGitPanel(panelEl, group, state);
      }
    }

    async runGitAction(group, state, panelEl) {
      if (!window.gitAPI) return;
      const { action } = this.getGitActionMeta(state);
      const cwd = group?.cwd || '';
      const wslDistro = group?.wslDistro || '';
      state.result = null;
      state.running = true;
      this.renderGitPanel(panelEl, group, state);
      try {
        if (action === 'push') {
          const result = await window.gitAPI.push({ cwd, wslDistro });
          if (result?.ok) {
            state.result = { tone: 'success', message: 'Pushed', details: [result.stdout, result.stderr].filter(Boolean).join('\n') };
          } else {
            state.result = { tone: 'error', message: 'Push failed', details: [result?.error, result?.stderr, result?.stdout].filter(Boolean).join('\n') };
          }
          return;
        }
        const message = String(state.message || '').trim();
        const commitResult = await window.gitAPI.commit({ cwd, wslDistro, message });
        if (!commitResult?.ok) {
          state.result = { tone: 'error', message: 'Commit failed', details: [commitResult?.error, commitResult?.stderr, commitResult?.stdout].filter(Boolean).join('\n') };
          return;
        }
        state.result = {
          tone: 'success',
          message: commitResult.hash ? `Committed ${commitResult.hash.slice(0, 7)}` : 'Committed',
          details: [commitResult.stdout, commitResult.stderr].filter(Boolean).join('\n'),
        };
        if (action === 'commit-push') {
          const pushResult = await window.gitAPI.push({ cwd, wslDistro });
          if (pushResult?.ok) {
            state.result = {
              tone: 'success',
              message: 'Committed + Pushed',
              details: [
                commitResult.stdout,
                commitResult.stderr,
                pushResult.stdout,
                pushResult.stderr,
              ].filter(Boolean).join('\n'),
            };
          } else {
            state.result = {
              tone: 'error',
              message: 'Push failed',
              details: [
                commitResult.stdout,
                commitResult.stderr,
                pushResult?.error,
                pushResult?.stderr,
                pushResult?.stdout,
              ].filter(Boolean).join('\n'),
            };
          }
        }
      } catch (_) {
        state.result = { tone: 'error', message: 'Git action failed' };
      } finally {
        state.running = false;
        this.renderGitPanel(panelEl, group, state);
        if (state.panelOpen) {
          void this.loadGitStatus(group, state, panelEl);
        }
      }
    }

    toggleGitPanel(groupEl, group, { open, action, focusInput } = {}) {
      const key = group?.key || '';
      const state = this.getGitState(key);
      if (!state || !groupEl) return;
      if (typeof action === 'string') {
        state.action = action;
      } else if (open === true) {
        state.action = '';
      }
      if (typeof open === 'boolean') {
        state.panelOpen = open;
      } else {
        state.panelOpen = !state.panelOpen;
      }
      let panelEl = groupEl.querySelector('.session-group-git-panel');
      if (state.panelOpen) {
        if (!panelEl) {
          panelEl = document.createElement('div');
          panelEl.className = 'session-group-git-panel';
          const body = groupEl.querySelector('.session-group-body');
          if (body) {
            groupEl.insertBefore(panelEl, body);
          } else {
            groupEl.appendChild(panelEl);
          }
        }
        this.renderGitPanel(panelEl, group, state);
        void this.ensureGitAiAvailability().then((available) => {
          state.aiAvailable = available;
          this.renderGitPanel(panelEl, group, state);
        });
        if (!state.statusLoading) {
          void this.loadGitStatus(group, state, panelEl);
        }
        if (focusInput) {
          const { action: resolvedAction } = this.getGitActionMeta(state);
          if (resolvedAction === 'commit' || resolvedAction === 'commit-push') {
            const input = panelEl.querySelector('.git-commit-input');
            input?.focus?.();
          }
        }
      } else if (panelEl) {
        panelEl.remove();
      }
    }

    renderGitPanel(panelEl, group, state) {
      if (!panelEl) return;
      const { action, hasChanges, canPush } = this.getGitActionMeta(state);
      const showInput = action === 'commit' || action === 'commit-push';
      const aiAvailable = state.aiAvailable === true;

      panelEl.replaceChildren();

      const header = document.createElement('div');
      header.className = 'git-panel-header';
      const title = document.createElement('span');
      title.textContent = 'Git';
      header.appendChild(title);
      const closeBtn = document.createElement('button');
      closeBtn.className = 'git-panel-close';
      closeBtn.type = 'button';
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        state.panelOpen = false;
        panelEl.remove();
      });
      header.appendChild(closeBtn);
      panelEl.appendChild(header);

      if (showInput) {
        const inputRow = document.createElement('div');
        inputRow.className = 'git-commit-row';
        const input = document.createElement('textarea');
        input.className = 'git-commit-input';
        input.placeholder = 'Commit message (subject + body)';
        input.rows = 2;
        input.value = state.message || '';
        input.addEventListener('input', () => {
          state.message = input.value;
        });
        inputRow.appendChild(input);
        if (aiAvailable) {
          const aiBtn = document.createElement('button');
          aiBtn.className = 'git-commit-ai';
          aiBtn.type = 'button';
          aiBtn.title = 'Generate message';
          aiBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6" fill="currentColor"/></svg><span class="git-commit-ai-spinner" aria-hidden="true"></span>';
          aiBtn.classList.toggle('is-loading', state.aiLoading);
          aiBtn.disabled = state.aiLoading;
          aiBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            void this.triggerCommitMessageAI(group, state, panelEl);
          });
          inputRow.appendChild(aiBtn);
        }
        panelEl.appendChild(inputRow);
      }

      const actions = document.createElement('div');
      actions.className = 'git-panel-actions';
      const actionGroup = document.createElement('div');
      actionGroup.className = 'git-panel-action-group';
      const primary = document.createElement('button');
      primary.className = 'git-panel-action';
      primary.type = 'button';
      const messageReady = !showInput || Boolean(String(state.message || '').trim());
      const statusKnown = hasChanges !== null && canPush !== null;
      let actionAllowed = true;
      if (statusKnown) {
        if (action === 'push') {
          actionAllowed = Boolean(canPush);
        } else {
          actionAllowed = Boolean(hasChanges);
        }
      }
      primary.disabled = Boolean(state.running || !messageReady || !actionAllowed);
      if (action === 'commit-push') {
        primary.textContent = state.running ? 'Committing…' : 'Commit + Push';
      } else if (action === 'push') {
        primary.textContent = state.running ? 'Pushing…' : 'Push';
      } else {
        primary.textContent = state.running ? 'Committing…' : 'Commit';
      }
      primary.addEventListener('click', (event) => {
        event.stopPropagation();
        void this.runGitAction(group, state, panelEl);
      });
      const menuBtn = document.createElement('button');
      menuBtn.className = 'git-panel-action-menu';
      menuBtn.type = 'button';
      menuBtn.title = 'Git actions';
      menuBtn.disabled = Boolean(state.running);
      menuBtn.innerHTML = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3l3 4 3-4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      const menu = document.createElement('div');
      menu.className = 'git-panel-action-menu-list';
      const buildMenuItem = (label, value) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'git-panel-action-menu-item';
        item.textContent = label;
        item.dataset.value = value;
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          state.action = value;
          menu.classList.remove('show');
          this.gitMenuOpenEl = null;
          this.renderGitPanel(panelEl, group, state);
        });
        return item;
      };
      menu.appendChild(buildMenuItem('Commit', 'commit'));
      menu.appendChild(buildMenuItem('Commit + Push', 'commit-push'));
      menu.appendChild(buildMenuItem('Push', 'push'));
      menuBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        const isOpen = menu.classList.toggle('show');
        if (isOpen) {
          if (this.gitMenuOpenEl && this.gitMenuOpenEl !== menu) {
            this.gitMenuOpenEl.classList.remove('show');
          }
          this.gitMenuOpenEl = menu;
        } else {
          this.gitMenuOpenEl = null;
        }
      });
      actionGroup.appendChild(primary);
      actionGroup.appendChild(menuBtn);
      actionGroup.appendChild(menu);
      actions.appendChild(actionGroup);
      panelEl.appendChild(actions);

      const result = state.result;
      if (result) {
        const resultEl = document.createElement('div');
        resultEl.className = `git-panel-result ${result.tone || ''}`.trim();
        const msg = document.createElement('div');
        msg.className = 'git-panel-result-message';
        msg.textContent = result.message || '';
        resultEl.appendChild(msg);
        if (result.details) {
          const details = document.createElement('details');
          details.className = 'git-panel-result-details';
          const summary = document.createElement('summary');
          summary.textContent = 'Details';
          const pre = document.createElement('pre');
          pre.textContent = result.details;
          details.appendChild(summary);
          details.appendChild(pre);
          resultEl.appendChild(details);
        }
        panelEl.appendChild(resultEl);
      }
    }

    triggerSessionItemGlint(sessionId) {
      const safeId = typeof sessionId === 'string' ? sessionId.trim() : String(sessionId || '').trim();
      if (!safeId || !this.sidebarEl) return;
      const escaped = typeof CSS?.escape === 'function' ? CSS.escape(safeId) : safeId;
      const item = this.sidebarEl.querySelector(`.session-item[data-session-id="${escaped}"]`);
      if (!item) return;
      item.classList.remove('is-resume-glint');
      void item.offsetWidth;
      item.classList.add('is-resume-glint');
      window.setTimeout(() => item.classList.remove('is-resume-glint'), 1200);
    }

    updateCwdGroup(groupEl, group, { scope } = {}) {
      if (!groupEl || !group) return;
      const scopeKey = scope || groupEl.dataset.scope || 'history';
      const stateKey = this.getGroupStateKey(group.key, scopeKey);
      groupEl.dataset.cwd = group.key;
      groupEl.dataset.groupKey = group.key;
      groupEl.dataset.scope = scopeKey;
      const isOpen = this.groupOpenState.get(stateKey) === true;
      groupEl.classList.toggle('open', isOpen);

      const header = groupEl.querySelector('.session-group-header');
      if (header) {
        header.dataset.cwd = group.key;
        header.dataset.groupKey = group.key;
        header.dataset.scope = scopeKey;
        const labelEl = header.querySelector('.session-group-cwd');
        const badgeEl = header.querySelector('.session-group-badge');
        const pathTail = getPathTail(group.cwd) || group.cwd;
        if (labelEl) {
          labelEl.textContent = pathTail;
          labelEl.title = group.cwd;
        }
        if (scopeKey === 'active') {
          badgeEl?.remove?.();
        } else if (badgeEl) {
          badgeEl.textContent = String(group.sessions.length);
        }
      }

      // if (scopeKey === 'active') {
      //   this.attachGitControls(groupEl, header, group);
      // }

      const body = groupEl.querySelector('.session-group-body');
      if (!body) return;
      if (!isOpen) return;
      if (!body.dataset.rendered) {
        body.dataset.rendered = '1';
      }
      this.patchSidebarSessionItems(body, group.sessions);
    }

    getSidebarSessionItemFields(block) {
      const sessionId = String(block?.session_id || '').trim();
      const source = String(block?.source || this.historySource || '').trim().toLowerCase();
      const sessionKey = sessionId ? `${source}:${sessionId}` : '';
      const blockId = block?.id || block?.block_id || '';
      const inputText = this.store?.getSessionInputPreview?.(block) || '';
      const outputText = this.store?.getSessionOutputPreview?.(block) || '';
      const summaryText = this.summaryProvider?.getSummaryForSession?.(sessionKey) || '';
      const timestamp = Number(block?.last_output_at || block?.created_at || Date.now());
      const safeTimestamp = Number.isFinite(timestamp) ? timestamp : Date.now();
      const timeText = this.store?.formatTime?.(safeTimestamp) || '';
      const timeAgo = this.store?.formatAgo?.(safeTimestamp) || '';
      const sourceLabel = this.store?.formatSourceLabel?.(source) || '';
      const cwd = String(block?.cwd || '').trim();
      const wslDistro = String(block?.wsl_distro || '').trim();
      const tooltipLines = [];
      const tooltipInput = inputText ? this.store?.clampText?.(this.store?.normalizePreviewText?.(inputText), 140) : '';
      const tooltipOutput = outputText ? this.store?.clampText?.(this.store?.normalizePreviewText?.(outputText), 140) : '';
      if (tooltipInput) tooltipLines.push(`Input: ${tooltipInput}`);
      if (tooltipOutput) tooltipLines.push(`Output: ${tooltipOutput}`);
      if (cwd) tooltipLines.push(`CWD: ${cwd}`);
      if (timeText) tooltipLines.push(timeText);
      const statusEntry = this.tracker?.getSessionStatus?.({ sessionId, source });
      const status = statusEntry?.status || '';
      const statusUpdatedAt = Number(statusEntry?.updated_at) || 0;
      const isDefaultCompleted = Boolean(statusEntry?.flags?.defaultCompleted);
      const paneId = String(statusEntry?.pane_id || '').trim();
      const activePaneId = this.tracker?.getActivePaneId?.() || this.tracker?.activePaneId || '';
      if (paneId && activePaneId && paneId === activePaneId) {
        this.markSessionViewed(sessionKey);
      }
      const viewedAt = this.sessionViewAt.get(sessionKey) || 0;
      const completedAt = status === 'completed' && !isDefaultCompleted ? statusUpdatedAt : 0;
      const statusUnread = Boolean(completedAt && completedAt > viewedAt);
      const statusDisplay = Boolean(statusEntry?.display);
      return {
        sessionId,
        source,
        sessionKey,
        blockId,
        inputText,
        outputText,
        summaryText,
        timeText,
        timeAgo,
        timestamp: safeTimestamp,
        sourceLabel,
        cwd,
        wslDistro,
        status,
        statusUpdatedAt,
        statusUnread,
        statusDisplay,
        tooltip: tooltipLines.join('\n'),
      };
    }

    getSidebarSessionItemSignature(fields) {
      return [
        fields.sessionKey || '',
        fields.blockId || '',
        fields.timestamp || '',
        fields.timeAgo || '',
        fields.inputText || '',
        fields.outputText || '',
        fields.summaryText || '',
        fields.source || '',
        fields.status || '',
        fields.statusDisplay ? '1' : '0',
        fields.statusUnread ? '1' : '0',
        fields.cwd || '',
        fields.wslDistro || '',
        fields.tooltip || '',
      ].join('\u0001');
    }

    applySessionStatus(item, status, display, isUnreadCompleted = false) {
      if (!item) return;
      const dot = item.querySelector('.session-status-dot');
      if (!dot) return;
      const classes = [
        'status-working',
        'status-waiting_user',
        'status-completed',
        'status-stopped',
        'status-stalled',
      ];
      dot.classList.remove(...classes);
      dot.classList.remove('is-unread');
      if (!status || !display) {
        dot.classList.remove('is-visible');
        return;
      }
      dot.classList.add('is-visible', `status-${status}`);
      if (status === 'completed') {
        dot.classList.toggle('is-unread', Boolean(isUnreadCompleted));
      }
    }

    markSessionViewed(sessionKey, viewedAt = Date.now()) {
      if (!sessionKey) return;
      const ts = Number(viewedAt) || Date.now();
      const prev = this.sessionViewAt.get(sessionKey) || 0;
      if (ts <= prev) return;
      this.sessionViewAt.set(sessionKey, ts);
    }

    isActiveSessionItem(item) {
      if (!item) return false;
      if (item.closest('.session-section-active')) return true;
      const group = item.closest('.session-group');
      if (group?.dataset?.scope) return group.dataset.scope === 'active';
      const section = item.closest('.session-section');
      return section?.dataset?.section === 'active';
    }

    maybeTriggerCompletionPop(item, fields) {
      const sessionKey = fields?.sessionKey || '';
      if (!sessionKey) return;
      const status = String(fields.status || '');
      const display = Boolean(fields.statusDisplay);
      const hadPrev = this.sessionStatusCache.has(sessionKey);
      const prevStatus = hadPrev ? this.sessionStatusCache.get(sessionKey) : '';
      this.sessionStatusCache.set(sessionKey, status);
      if (!hadPrev) return;
      if (!display || status !== 'completed' || prevStatus === 'completed') return;
      if (!this.isActiveSessionItem(item)) return;
      const dot = item.querySelector('.session-status-dot');
      if (!dot) return;
      dot.classList.remove('is-complete-pop');
      void dot.offsetWidth;
      dot.classList.add('is-complete-pop');
      window.setTimeout(() => dot.classList.remove('is-complete-pop'), 600);
    }

    updateSidebarSessionItem(item, block) {
      if (!item || !block) return false;
      const fields = this.getSidebarSessionItemFields(block);
      if (!fields.sessionKey) return false;
      const signature = this.getSidebarSessionItemSignature(fields);
      if (item.dataset.signature === signature) return false;

      item.dataset.sessionId = fields.sessionId;
      item.dataset.source = fields.source;
      item.dataset.sessionKey = fields.sessionKey;
      item.dataset.blockId = fields.blockId;
      item.dataset.cwd = fields.cwd || '';
      item.dataset.wslDistro = fields.wslDistro || '';
      item.dataset.timestamp = String(fields.timestamp || '');
      item.dataset.signature = signature;

      const inputEl = item.querySelector('.session-item-input');
      if (inputEl) {
        const emptyLabel = this.isActiveSessionItem(item) ? 'Ready' : '(no input)';
        inputEl.textContent = fields.inputText ? fields.inputText : emptyLabel;
      }
      const content = item.querySelector('.session-item-content');
      if (content) {
        const agoEl = content.querySelector('.session-item-ago');
        const providerEl = content.querySelector('.session-item-provider');
        if (fields.sourceLabel) {
          if (providerEl) {
            providerEl.textContent = fields.sourceLabel;
            providerEl.title = fields.sourceLabel;
            providerEl.className = `session-item-provider ${fields.source || ''}`.trim();
          } else {
            const provider = document.createElement('span');
            provider.className = `session-item-provider ${fields.source || ''}`.trim();
            provider.textContent = fields.sourceLabel;
            provider.title = fields.sourceLabel;
            if (agoEl) {
              content.insertBefore(provider, agoEl);
            } else {
              content.appendChild(provider);
            }
          }
        } else if (providerEl) {
          providerEl.remove();
        }
        if (agoEl) {
          agoEl.textContent = fields.timeAgo || '';
        }
        content.classList.remove('fancy-tooltip');
        content.removeAttribute('data-tooltip');
      }

      let summaryEl = item.querySelector('.session-item-summary');
      if (!summaryEl) {
        summaryEl = document.createElement('div');
        summaryEl.className = 'session-item-summary';
        const timelineEl = item.querySelector('.session-timeline');
        if (timelineEl) {
          item.insertBefore(summaryEl, timelineEl);
        } else {
          item.appendChild(summaryEl);
        }
      }
      summaryEl.textContent = fields.summaryText || '';
      summaryEl.classList.toggle('is-empty', !fields.summaryText);

      const legacyTime = item.querySelector('.session-item-time');
      if (legacyTime) legacyTime.remove();
      const legacyMeta = item.querySelector('.session-item-meta');
      if (legacyMeta) legacyMeta.remove();
      const legacyOutput = item.querySelector('.session-item-output');
      if (legacyOutput) legacyOutput.remove();

      if (content) {
        let resumeBtn = content.querySelector('.session-item-resume-btn');
        if (!resumeBtn) {
          resumeBtn = document.createElement('button');
          resumeBtn.className = 'session-item-resume-btn';
          resumeBtn.type = 'button';
          resumeBtn.title = 'Resume session';
          resumeBtn.setAttribute('aria-label', 'Resume session');
          resumeBtn.innerHTML = '<svg viewBox="0 0 15 15" aria-hidden="true"><path d="M3.04995 2.74995C3.04995 2.44619 2.80371 2.19995 2.49995 2.19995C2.19619 2.19995 1.94995 2.44619 1.94995 2.74995V12.25C1.94995 12.5537 2.19619 12.8 2.49995 12.8C2.80371 12.8 3.04995 12.5537 3.04995 12.25V2.74995ZM5.73333 2.30776C5.57835 2.22596 5.39185 2.23127 5.24177 2.32176C5.0917 2.41225 4.99995 2.57471 4.99995 2.74995V12.25C4.99995 12.4252 5.0917 12.5877 5.24177 12.6781C5.39185 12.7686 5.57835 12.7739 5.73333 12.6921L14.7333 7.94214C14.8973 7.85559 15 7.68539 15 7.49995C15 7.31452 14.8973 7.14431 14.7333 7.05776L5.73333 2.30776ZM5.99995 11.4207V3.5792L13.4287 7.49995L5.99995 11.4207Z" fill="currentColor"/></svg>';
          content.appendChild(resumeBtn);
        }
      }

      if (fields.tooltip) {
        item.classList.add('fancy-tooltip');
        item.setAttribute('data-tooltip', fields.tooltip);
      } else {
        item.classList.remove('fancy-tooltip');
        item.removeAttribute('data-tooltip');
      }

      this.applySessionStatus(item, fields.status, fields.statusDisplay, fields.statusUnread);
      this.maybeTriggerCompletionPop(item, fields);

      const timeline = item.querySelector('.session-timeline');
      if (timeline) {
        timeline.dataset.blockId = fields.blockId;
      }

      return true;
    }

    patchSidebarSessionItems(bodyEl, sessions) {
      const existingItems = new Map();
      for (const item of bodyEl.querySelectorAll('.session-item')) {
        const key = item.dataset.sessionKey
          || (item.dataset.source && item.dataset.sessionId ? `${item.dataset.source}:${item.dataset.sessionId}` : '');
        if (key) existingItems.set(key, item);
      }

      const scopeKey = bodyEl?.closest?.('.session-group')?.dataset?.scope
        || bodyEl?.closest?.('.session-section')?.dataset?.section
        || 'history';
      const orderedItems = [];
      const seenKeys = new Set();

      for (const session of sessions) {
        const sessionKey = this.store?.buildSessionKey?.(session) || '';
        if (!sessionKey) continue;
        let item = existingItems.get(sessionKey);
        if (!item) {
          item = this.renderSidebarSessionItem(session, { scope: scopeKey });
        } else {
          this.updateSidebarSessionItem(item, session);
        }
        orderedItems.push(item);
        seenKeys.add(sessionKey);
      }

      for (const [key, item] of existingItems) {
        if (!seenKeys.has(key)) {
          item.remove();
        }
      }

      let cursor = bodyEl.firstElementChild;
      for (const item of orderedItems) {
        if (item === cursor) {
          cursor = cursor.nextElementSibling;
          continue;
        }
        bodyEl.insertBefore(item, cursor);
      }
    }

    groupSessionsByCwd(sessions) {
      const groupMap = new Map();
      const tailToKey = new Map();
      const tailToDisplay = new Map();

      for (const session of sessions) {
        const rawCwd = String(session.cwd || '').trim();
        if (!rawCwd) continue;
        if (!looksLikePath(rawCwd)) continue;
        const normalizedPath = normalizeCwdPath(rawCwd);
        if (!normalizedPath) continue;
        const key = buildCwdKey(normalizedPath, session.wsl_distro);
        const tail = getPathTail(normalizedPath);
        if (!tail) continue;
        if (tailToKey.has(tail) && tailToKey.get(tail) !== key) {
          tailToKey.set(tail, null);
          tailToDisplay.set(tail, null);
        } else if (!tailToKey.has(tail)) {
          tailToKey.set(tail, key);
          tailToDisplay.set(tail, rawCwd);
        } else if (tailToKey.get(tail) === key) {
          const current = tailToDisplay.get(tail);
          tailToDisplay.set(tail, chooseDisplayCwd(current, rawCwd));
        }
      }

      for (const session of sessions) {
        const rawCwd = String(session.cwd || '').trim();
        let key = '';
        let displayCwd = '';
        if (!rawCwd) {
          const debugKey = this.store?.buildSessionKey?.(session)
            || String(session.id || session.block_id || session.source_path || session.session_label || '');
          if (debugKey && !this.missingCwdLogged.has(debugKey)) {
            this.missingCwdLogged.add(debugKey);
            logHistoryDebug({
              type: 'cwdMissing',
              key: debugKey,
              source: session.source,
              session_id: session.session_id,
              session_label: session.session_label,
              pane_id: session.pane_id,
              pane_label: session.pane_label,
              project_path: session.project_path,
              project_dir: session.project_dir,
              source_path: session.source_path,
              wsl_distro: session.wsl_distro,
              created_at: session.created_at,
              last_output_at: session.last_output_at,
            });
          }
          key = '(unknown)';
          displayCwd = '(unknown)';
        } else if (looksLikePath(rawCwd)) {
          const normalizedPath = normalizeCwdPath(rawCwd);
          key = buildCwdKey(normalizedPath, session.wsl_distro) || rawCwd;
          displayCwd = rawCwd;
        } else {
          const mappedKey = tailToKey.get(rawCwd);
          if (mappedKey) {
            key = mappedKey;
            displayCwd = tailToDisplay.get(rawCwd) || displayCwdFromKey(mappedKey) || rawCwd;
          } else {
            key = rawCwd;
            displayCwd = rawCwd;
          }
        }
        const timestamp = Number(session.last_output_at || session.created_at || 0) || 0;
        const wslDistro = String(session.wsl_distro || '').trim();

        if (!groupMap.has(key)) {
          groupMap.set(key, {
            key,
            cwd: displayCwd,
            sessions: [],
            latest: timestamp,
            wslDistro,
          });
        }

        const group = groupMap.get(key);
        group.cwd = chooseDisplayCwd(group.cwd, displayCwd);
        if (!group.wslDistro && wslDistro) {
          group.wslDistro = wslDistro;
        }
        group.sessions.push(session);
        if (timestamp > (group.latest || 0)) {
          group.latest = timestamp;
        }
      }

      const groups = Array.from(groupMap.values());
      groups.sort((a, b) => {
        if (b.latest !== a.latest) return b.latest - a.latest;
        return a.cwd.localeCompare(b.cwd);
      });

      return groups;
    }

    renderCwdGroup(group, { scope } = {}) {
      const groupEl = document.createElement('div');
      groupEl.className = 'session-group';
      groupEl.dataset.cwd = group.key;
      groupEl.dataset.groupKey = group.key;
      groupEl.dataset.scope = scope || 'history';

      const stateKey = this.getGroupStateKey(group.key, groupEl.dataset.scope || 'history');
      const isOpen = this.groupOpenState.get(stateKey) === true;
      if (isOpen) {
        groupEl.classList.add('open');
      }

      const header = document.createElement('div');
      header.className = 'session-group-header';
      header.dataset.cwd = group.key;
      header.dataset.groupKey = group.key;
      header.dataset.scope = groupEl.dataset.scope || 'history';

      const icon = document.createElement('div');
      icon.className = 'session-group-icon';
      icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      header.appendChild(icon);

      const cwdLabel = document.createElement('span');
      cwdLabel.className = 'session-group-cwd';
      const pathTail = getPathTail(group.cwd) || group.cwd;
      cwdLabel.textContent = pathTail;
      cwdLabel.title = group.cwd;
      header.appendChild(cwdLabel);

      if ((scope || groupEl.dataset.scope || 'history') !== 'active') {
        const badge = document.createElement('span');
        badge.className = 'session-group-badge';
        badge.textContent = String(group.sessions.length);
        header.appendChild(badge);
      }

      // if ((scope || groupEl.dataset.scope || 'history') === 'active') {
      //   this.attachGitControls(groupEl, header, group);
      // }

      groupEl.appendChild(header);

      const body = document.createElement('div');
      body.className = 'session-group-body';
      if (isOpen) {
        body.dataset.rendered = '1';
        for (const session of group.sessions) {
          body.appendChild(this.renderSidebarSessionItem(session, { scope }));
        }
      }

      groupEl.appendChild(body);

      return groupEl;
    }

    renderSidebarSessionItem(block, { scope } = {}) {
      const item = document.createElement('div');
      item.className = 'session-item';
      const fields = this.getSidebarSessionItemFields(block);
      item.dataset.sessionId = fields.sessionId;
      item.dataset.source = fields.source;
      item.dataset.sessionKey = fields.sessionKey;
      item.dataset.blockId = fields.blockId;
      item.dataset.cwd = fields.cwd || '';
      item.dataset.wslDistro = fields.wslDistro || '';
      item.dataset.timestamp = String(fields.timestamp || '');
      item.dataset.signature = this.getSidebarSessionItemSignature(fields);

      const header = document.createElement('div');
      header.className = 'session-item-header';

      // Left chevron (timeline expander)
      const expander = document.createElement('button');
      expander.className = 'session-item-expander';
      expander.type = 'button';
      expander.title = 'Toggle Timeline';
      expander.setAttribute('aria-expanded', 'false');
      expander.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      header.appendChild(expander);

      const statusDot = document.createElement('span');
      statusDot.className = 'session-status-dot';
      statusDot.setAttribute('aria-hidden', 'true');
      header.appendChild(statusDot);

      const content = document.createElement('div');
      content.className = 'session-item-content';

      const inputEl = document.createElement('div');
      inputEl.className = 'session-item-input';
      const emptyLabel = scope === 'active' ? 'Ready' : '(no input)';
      inputEl.textContent = fields.inputText ? fields.inputText : emptyLabel;
      content.appendChild(inputEl);

      if (fields.sourceLabel) {
        const provider = document.createElement('span');
        provider.className = `session-item-provider ${fields.source || ''}`.trim();
        provider.textContent = fields.sourceLabel;
        provider.title = fields.sourceLabel;
        content.appendChild(provider);
      }

      const agoEl = document.createElement('span');
      agoEl.className = 'session-item-ago';
      agoEl.textContent = fields.timeAgo || '';
      content.appendChild(agoEl);

      const resumeBtn = document.createElement('button');
      resumeBtn.className = 'session-item-resume-btn';
      resumeBtn.type = 'button';
      resumeBtn.title = 'Resume session';
      resumeBtn.setAttribute('aria-label', 'Resume session');
      resumeBtn.innerHTML = '<svg viewBox="0 0 15 15" aria-hidden="true"><path d="M3.04995 2.74995C3.04995 2.44619 2.80371 2.19995 2.49995 2.19995C2.19619 2.19995 1.94995 2.44619 1.94995 2.74995V12.25C1.94995 12.5537 2.19619 12.8 2.49995 12.8C2.80371 12.8 3.04995 12.5537 3.04995 12.25V2.74995ZM5.73333 2.30776C5.57835 2.22596 5.39185 2.23127 5.24177 2.32176C5.0917 2.41225 4.99995 2.57471 4.99995 2.74995V12.25C4.99995 12.4252 5.0917 12.5877 5.24177 12.6781C5.39185 12.7686 5.57835 12.7739 5.73333 12.6921L14.7333 7.94214C14.8973 7.85559 15 7.68539 15 7.49995C15 7.31452 14.8973 7.14431 14.7333 7.05776L5.73333 2.30776ZM5.99995 11.4207V3.5792L13.4287 7.49995L5.99995 11.4207Z" fill="currentColor"/></svg>';
      content.appendChild(resumeBtn);

      if (fields.tooltip) {
        item.classList.add('fancy-tooltip');
        item.setAttribute('data-tooltip', fields.tooltip);
      }

      header.appendChild(content);

      item.appendChild(header);

      const summaryEl = document.createElement('div');
      summaryEl.className = 'session-item-summary';
      if (fields.summaryText) {
        summaryEl.textContent = fields.summaryText;
      } else {
        summaryEl.classList.add('is-empty');
      }
      item.appendChild(summaryEl);

      this.applySessionStatus(item, fields.status, fields.statusDisplay, fields.statusUnread);
      this.maybeTriggerCompletionPop(item, fields);

      // タイムライン用の要素（最初は非表示）
      const timeline = document.createElement('div');
      timeline.className = 'session-timeline';
      timeline.dataset.blockId = fields.blockId;
      item.appendChild(timeline);

      return item;
    }

    async loadSessionTimeline(sessionId, source, blockId, sessionItem) {
      const timeline = sessionItem.querySelector('.session-timeline');
      if (!timeline) return;

      // Clear and show loading
      timeline.replaceChildren();
      const loading = document.createElement('div');
      loading.className = 'session-timeline-loading';
      loading.textContent = 'Loading...';
      timeline.appendChild(loading);

      try {
        // Fetch all blocks for this session
        const result = await window.historyAPI?.loadSession?.({
          session_id: sessionId,
          source: source,
          limit: 200,
          load_all: true,
        });

        if (!result?.blocks || !Array.isArray(result.blocks)) {
          this.showTimelineError(timeline);
          return;
        }

        timeline.replaceChildren();
        const blocks = result.blocks;

        if (blocks.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'session-timeline-empty';
          empty.textContent = 'No timeline entries';
          timeline.appendChild(empty);
          return;
        }

        const fragment = document.createDocumentFragment();
        for (const block of blocks) {
          const entry = this.renderTimelineEntry(block, source);
          if (entry) fragment.appendChild(entry);
        }
        timeline.appendChild(fragment);
      } catch (err) {
        console.warn('Timeline: failed to load session blocks', err);
        this.showTimelineError(timeline);
      }
    }

    showTimelineError(timeline) {
      timeline.replaceChildren();
      const error = document.createElement('div');
      error.className = 'session-timeline-error';
      error.textContent = 'Failed to load timeline';
      timeline.appendChild(error);
    }

    renderTimelineEntry(block, _source) {
      if (!this.store?.blockHasInput?.(block)) return null;
      const entry = document.createElement('div');
      entry.className = 'session-timeline-entry';
      entry.dataset.blockId = block.id || block.block_id || '';
      entry.classList.add('fancy-tooltip');
      const triggerTimelineGlint = () => {
        entry.classList.remove('is-timeline-glint');
        void entry.offsetWidth;
        entry.classList.add('is-timeline-glint');
        window.setTimeout(() => entry.classList.remove('is-timeline-glint'), 1200);
      };

      // Restart Button (New)
      const restartBtn = document.createElement('button');
      restartBtn.className = 'session-timeline-restart-btn';
      restartBtn.title = 'Branch a new session from this point';
      restartBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12"><path d="M22.7 13.5L20.7005 11.5L18.7 13.5M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C15.3019 3 18.1885 4.77814 19.7545 7.42909M12 7V12L15 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      restartBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        triggerTimelineGlint();
        if (this.onTimeMachine) {
          this.onTimeMachine(block, { buttonEl: restartBtn, fromEl: entry });
        }
      });
      entry.appendChild(restartBtn);

      const inputDiv = document.createElement('div');
      inputDiv.className = 'session-timeline-input';
      const inputs = this.store?.getBlockInputs?.(block) || [];
      const inputText = inputs.length > 0 ? this.store?.formatInputsForCard?.(inputs) : '(no input)';
      inputDiv.textContent = inputText || '';
      entry.appendChild(inputDiv);

      const outputDiv = document.createElement('div');
      outputDiv.className = 'session-timeline-output';
      const output = block.output_head || block.output_text || '(no output)';
      const sample = String(output).slice(0, OUTPUT_PREVIEW_CHARS);
      const normalized = this.store?.normalizePreviewText?.(sample) || '';
      outputDiv.textContent = this.store?.clampText?.(normalized, OUTPUT_PREVIEW_CHARS / 2) || '';
      entry.appendChild(outputDiv);

      const actionBtn = document.createElement('button');
      actionBtn.className = 'session-timeline-action';
      actionBtn.title = 'Time Machine';
      actionBtn.innerHTML = '<svg viewBox="-4 -2 24 24" aria-hidden="true"><path d="M8 18a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm1.033-3.817A3.001 3.001 0 1 1 7 14.17v-1.047c0-.074.003-.148.008-.221a1 1 0 0 0-.462-.637L3.46 10.42A3 3 0 0 1 2 7.845V5.829a3.001 3.001 0 1 1 2 0v2.016a1 1 0 0 0 .487.858l3.086 1.846a3 3 0 0 1 .443.324 3 3 0 0 1 .444-.324l3.086-1.846a1 1 0 0 0 .487-.858V5.841A3.001 3.001 0 0 1 13 0a3 3 0 0 1 1.033 5.817v2.028a3 3 0 0 1-1.46 2.575l-3.086 1.846a1 1 0 0 0-.462.637c.005.073.008.147.008.22v1.06zM3 4a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm10 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" fill="currentColor"/></svg>';
      actionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        triggerTimelineGlint();
        if (this.onTimeMachine) {
          this.onTimeMachine(block, { buttonEl: actionBtn, fromEl: entry });
        }
      });
      entry.appendChild(actionBtn);

      const tooltipLines = [];
      const timeText = this.store?.formatTime?.(block.last_output_at || block.created_at || Date.now()) || '';
      if (timeText) tooltipLines.push(timeText);
      const tooltipInput = inputText ? this.store?.normalizePreviewText?.(inputText) : '';
      const tooltipOutput = normalized ? this.store?.normalizePreviewText?.(normalized) : '';
      if (tooltipInput) tooltipLines.push(`Input: ${tooltipInput}`);
      if (tooltipOutput) tooltipLines.push(`Output: ${tooltipOutput}`);
      entry.setAttribute('data-tooltip', tooltipLines.join('\n'));

      const fullTooltipData = this.store?.buildFullTooltipData?.(block);
      if (fullTooltipData) {
        this.tooltipDataMap?.set(entry, fullTooltipData);
      }

      // Time machine on click
      entry.addEventListener('click', () => {
        triggerTimelineGlint();
        if (this.onTimeMachine) {
          this.onTimeMachine(block);
        }
      });

      return entry;
    }

    showHistoryToast(message, { tone } = {}) {
      const toastEl = document.getElementById('terminal-preview-toast');
      if (!toastEl) return;
      if (this.historyToastTimer) {
        clearTimeout(this.historyToastTimer);
      }
      toastEl.textContent = message;
      toastEl.classList.toggle('error', tone === 'error');
      toastEl.classList.add('show');
      this.historyToastTimer = setTimeout(() => {
        toastEl.classList.remove('show');
        this.historyToastTimer = null;
      }, HISTORY_TOAST_DURATION_MS);
    }
  }

  window.HistorySidebarUI = HistorySidebarUI;
})();
