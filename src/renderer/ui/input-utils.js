(function () {
  'use strict';

  const isTerminalInputTarget = (target) => {
    if (!target) return false;
    if (target.classList?.contains('xterm-helper-textarea')) return true;
    return Boolean(target.closest?.('.xterm-helpers'));
  };

  const getSelectionTextInLeftPane = () => {
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return '';
    const text = String(selection.toString() || '');
    if (!text) return '';
    const { anchorNode, focusNode } = selection;
    const anchorEl = anchorNode?.nodeType === 1 ? anchorNode : anchorNode?.parentElement;
    const focusEl = focusNode?.nodeType === 1 ? focusNode : focusNode?.parentElement;
    if (!anchorEl && !focusEl) return '';
    if (anchorEl?.closest?.('#left-pane') || focusEl?.closest?.('#left-pane')) {
      return text;
    }
    return '';
  };

  const isEditableTarget = (target) => {
    if (!target) return false;
    if (isTerminalInputTarget(target)) return false;
    const tag = target.tagName ? target.tagName.toLowerCase() : '';
    return target.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select';
  };

  const getEditableSelectionText = (target) => {
    if (!target) return '';
    const tag = target.tagName ? target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea') {
      const value = typeof target.value === 'string' ? target.value : '';
      const start = Number.isFinite(target.selectionStart) ? target.selectionStart : value.length;
      const end = Number.isFinite(target.selectionEnd) ? target.selectionEnd : start;
      if (end > start) return value.slice(start, end);
      return '';
    }
    if (target.isContentEditable) {
      try {
        return window.getSelection?.()?.toString?.() || '';
      } catch {
        return '';
      }
    }
    return '';
  };

  const pasteIntoEditableTarget = (target, text) => {
    const payload = String(text || '');
    if (!target || !payload) return false;
    const tag = target.tagName ? target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea') {
      const value = typeof target.value === 'string' ? target.value : '';
      const start = Number.isFinite(target.selectionStart) ? target.selectionStart : value.length;
      const end = Number.isFinite(target.selectionEnd) ? target.selectionEnd : start;
      try {
        target.setRangeText(payload, start, end, 'end');
      } catch (_) {
        const next = value.slice(0, start) + payload + value.slice(end);
        target.value = next;
        const pos = start + payload.length;
        try { target.setSelectionRange(pos, pos); } catch (_) { /* noop */ }
      }
      target.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    if (target.isContentEditable) {
      try {
        return document.execCommand('insertText', false, payload);
      } catch (_) {
        return false;
      }
    }
    return false;
  };

  const readClipboardText = async () => {
    try {
      if (window.clipboardAPI?.readText) {
        return await window.clipboardAPI.readText();
      }
    } catch (e) {
      console.warn('ClipboardAPI read failed:', e);
    }
    try {
      if (navigator?.clipboard?.readText) {
        return await navigator.clipboard.readText();
      }
    } catch (e) {
      console.warn('Navigator clipboard read failed:', e);
    }
    return '';
  };

  const writeClipboardText = async (text) => {
    try {
      if (window.clipboardAPI?.writeText) {
        window.clipboardAPI.writeText(text);
        return true;
      }
    } catch (e) {
      console.warn('ClipboardAPI write failed:', e);
    }
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      console.warn('Navigator clipboard write failed:', e);
    }
    return false;
  };

  const clipboard = window.ClipboardUtils || {};
  clipboard.readText = readClipboardText;
  clipboard.writeText = writeClipboardText;
  window.ClipboardUtils = clipboard;

  const inputUtils = window.InputUtils || {};
  inputUtils.isTerminalInputTarget = isTerminalInputTarget;
  inputUtils.isEditableTarget = isEditableTarget;
  inputUtils.getEditableSelectionText = getEditableSelectionText;
  inputUtils.pasteIntoEditableTarget = pasteIntoEditableTarget;
  inputUtils.getSelectionTextInLeftPane = getSelectionTextInLeftPane;
  window.InputUtils = inputUtils;
})();
