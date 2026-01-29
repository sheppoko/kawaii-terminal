(function () {
  'use strict';

  const SEARCH_PANE_MIN_CHARS = 2;
  const SEARCH_PANE_LIMIT = 120;
  const SEARCH_PANE_CHUNK = 6;
  const DETAIL_OUTPUT_LIMIT = 80000;
  const OUTPUT_HEAD_CHARS = 400;
  const OUTPUT_TAIL_CHARS = 400;

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function normalizeSearchTermsForHighlight(query) {
    const raw = String(query || '').trim();
    if (!raw) return [];
    const terms = raw.split(/\s+/).map((item) => item.trim()).filter(Boolean);
    return terms.slice(0, 20);
  }

  function buildHighlightHtml(text, terms) {
    const value = String(text || '');
    if (!value) return { html: '', matched: false };
    const unique = Array.from(new Set((terms || []).map((term) => String(term || '').trim()).filter(Boolean)));
    if (unique.length === 0) return { html: escapeHtml(value), matched: false };
    unique.sort((a, b) => b.length - a.length);
    const pattern = unique.map(escapeRegex).join('|');
    if (!pattern) return { html: escapeHtml(value), matched: false };
    const regex = new RegExp(pattern, 'gi');
    let matched = false;
    let result = '';
    let lastIndex = 0;
    for (const match of value.matchAll(regex)) {
      const index = match.index ?? 0;
      const chunk = value.slice(lastIndex, index);
      if (chunk) result += escapeHtml(chunk);
      const textMatch = match[0] || '';
      result += `<mark class="search-highlight">${escapeHtml(textMatch)}</mark>`;
      matched = true;
      lastIndex = index + textMatch.length;
    }
    const tail = value.slice(lastIndex);
    if (tail) result += escapeHtml(tail);
    return { html: matched ? result : escapeHtml(value), matched };
  }

  class HistorySearchUI {
    constructor(options = {}) {
      this.store = options.store || null;
      this.tracker = options.tracker || null;
      this.historySource = String(options.historySource || 'all').trim().toLowerCase();
      this.onTimeMachine = typeof options.onTimeMachine === 'function' ? options.onTimeMachine : null;

      this.searchPaneInput = document.getElementById('session-search-input');
      this.searchPaneClearBtn = document.getElementById('session-search-clear');
      this.searchPaneStatusEl = document.getElementById('session-search-status');
      this.searchPaneListEl = document.getElementById('session-search-list');
      this.searchPaneCountEl = document.getElementById('session-search-count');
      this.searchPaneQuery = '';
      this.searchPaneResults = [];
      this.searchPaneSearching = false;
      this.searchPaneRequestId = 0;
      this.searchPaneTimer = null;
      this.searchPaneOpenState = new Map();
      this.searchPaneCandidateMap = new Map();
      this.searchPaneRenderedIds = new Set();
      this.searchPaneRenderPending = false;
      this.searchPaneComposing = false;
    }

    setHistorySource(source) {
      this.historySource = String(source || '').trim().toLowerCase() || 'all';
    }

    setHandlers({ onTimeMachine } = {}) {
      if (typeof onTimeMachine === 'function') this.onTimeMachine = onTimeMachine;
    }

    init() {
      this.setupSearchPane();
    }

    getListElement() {
      return this.searchPaneListEl;
    }

    focusSearchPane(options = {}) {
      const input = this.searchPaneInput;
      if (!input) return;
      input.focus?.();
      if (!options.selectAll) return;
      try {
        input.select?.();
      } catch (_) {
        try {
          input.setSelectionRange?.(0, input.value ? input.value.length : 0);
        } catch (_) { /* noop */ }
      }
    }

    refreshSearchPane() {
      this.renderSearchPaneList();
      this.updateSearchPaneCount();
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

    setupSearchPane() {
      if (!this.searchPaneInput || !this.searchPaneListEl) return;

      const handleInput = () => {
        this.updateSearchPaneClear();
        if (this.searchPaneComposing) return;
        this.queueSearchPane();
      };

      this.searchPaneInput.addEventListener('input', handleInput);
      this.searchPaneInput.addEventListener('compositionstart', () => {
        this.searchPaneComposing = true;
      });
      this.searchPaneInput.addEventListener('compositionend', () => {
        this.searchPaneComposing = false;
        this.queueSearchPane();
      });
      this.searchPaneInput.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          this.searchPaneInput.value = '';
          this.queueSearchPane({ clear: true });
        }
      });

      if (this.searchPaneClearBtn) {
        this.searchPaneClearBtn.addEventListener('click', (event) => {
          event.preventDefault();
          this.searchPaneInput.value = '';
          this.queueSearchPane({ clear: true });
          this.searchPaneInput.focus();
        });
      }

      this.searchPaneListEl.addEventListener('click', (event) => {
        if (this.isTextSelectionInElement(event.currentTarget)) return;
        const tmBtn = event.target.closest('.search-item-tm');
        if (tmBtn) {
          event.preventDefault();
          event.stopPropagation();
          const card = tmBtn.closest('.search-item');
          const blockId = card?.dataset?.blockId || '';
          const candidate = blockId ? this.searchPaneCandidateMap.get(blockId) : null;
          const block = candidate?.block || candidate;
          if (block && this.onTimeMachine) {
            void this.onTimeMachine(block, { blockId, buttonEl: tmBtn, fromEl: card });
          }
          return;
        }

        const detail = event.target.closest('.search-item-detail');
        if (detail) return;

        const toggleBtn = event.target.closest('.search-item-toggle');
        const card = event.target.closest('.search-item');
        if (!card) return;
        const blockId = card.dataset.blockId || '';
        if (!blockId) return;
        this.toggleSearchPaneDetail(blockId, card);
        if (toggleBtn) {
          event.preventDefault();
          event.stopPropagation();
        }
      });

      const searchBody = this.searchPaneListEl.closest('.session-sidebar-body');
      if (searchBody) {
        searchBody.addEventListener('pointerdown', (event) => {
          if (!this.searchPaneInput) return;
          if (event.target !== searchBody && event.target !== this.searchPaneListEl) return;
          event.preventDefault();
          this.searchPaneInput.focus();
        });
      }

      this.queueSearchPane();
    }

    updateSearchPaneClear() {
      if (!this.searchPaneInput || !this.searchPaneClearBtn) return;
      const hasText = String(this.searchPaneInput.value || '').trim().length > 0;
      this.searchPaneClearBtn.classList.toggle('is-visible', hasText);
    }

    setSearchPaneStatus(text) {
      if (!this.searchPaneStatusEl) return;
      this.searchPaneStatusEl.textContent = text || '';
    }

    updateSearchPaneCount() {
      if (!this.searchPaneCountEl) return;
      const count = Array.isArray(this.searchPaneResults) ? this.searchPaneResults.length : 0;
      this.searchPaneCountEl.textContent = String(count);
    }

    scheduleSearchPaneRender() {
      if (this.searchPaneRenderPending) return;
      this.searchPaneRenderPending = true;
      requestAnimationFrame(() => {
        this.searchPaneRenderPending = false;
        this.renderSearchPaneList();
      });
    }

    appendSearchPaneCards(candidates) {
      if (!this.searchPaneListEl || !Array.isArray(candidates) || candidates.length === 0) return;
      const emptyState = this.searchPaneListEl.querySelector('.session-sidebar-empty');
      if (emptyState) emptyState.remove();
      for (const candidate of candidates) {
        const blockId = this.store?.getSearchPaneCandidateId?.(candidate) || '';
        if (!blockId || this.searchPaneRenderedIds.has(blockId)) continue;
        const card = this.buildSearchPaneCard(candidate);
        if (!card) continue;
        this.searchPaneRenderedIds.add(blockId);
        const ts = Number(card.dataset.timestamp) || 0;
        let inserted = false;
        for (const child of Array.from(this.searchPaneListEl.children)) {
          if (!child.classList.contains('search-item')) continue;
          const childTs = Number(child.dataset.timestamp) || 0;
          if (childTs < ts) {
            this.searchPaneListEl.insertBefore(card, child);
            inserted = true;
            break;
          }
          if (childTs === ts) {
            const childId = String(child.dataset.blockId || '');
            if (childId && blockId < childId) {
              this.searchPaneListEl.insertBefore(card, child);
              inserted = true;
              break;
            }
          }
        }
        if (!inserted) this.searchPaneListEl.appendChild(card);
      }
    }

    clearSearchPaneResults({ status = '', clearQuery = false } = {}) {
      this.searchPaneRequestId += 1;
      this.searchPaneSearching = false;
      this.searchPaneResults = [];
      this.searchPaneCandidateMap.clear();
      this.searchPaneRenderedIds.clear();
      if (clearQuery) {
        this.searchPaneQuery = '';
      }
      this.updateSearchPaneCount();
      this.renderSearchPaneList();
      this.setSearchPaneStatus(status);
    }

    queueSearchPane({ clear = false } = {}) {
      if (!this.searchPaneInput) return;
      const raw = String(this.searchPaneInput.value || '');
      const query = raw.trim();
      this.searchPaneQuery = query;
      this.updateSearchPaneClear();

      if (this.searchPaneTimer) {
        clearTimeout(this.searchPaneTimer);
      }
      this.searchPaneTimer = null;

      if (clear || query.length < SEARCH_PANE_MIN_CHARS) {
        const status = query.length === 0 ? '' : `Type ${SEARCH_PANE_MIN_CHARS}+ characters`;
        this.clearSearchPaneResults({ status, clearQuery: clear });
        return;
      }

      this.searchPaneTimer = setTimeout(() => {
        this.searchPaneTimer = null;
        void this.runSearchPane(query);
      }, 160);
    }

    async runSearchPane(query) {
      const requestId = ++this.searchPaneRequestId;
      this.searchPaneSearching = true;
      this.searchPaneResults = [];
      this.searchPaneCandidateMap.clear();
      this.searchPaneRenderedIds.clear();
      this.updateSearchPaneCount();
      this.renderSearchPaneList();
      this.setSearchPaneStatus('Searching...');

      if (!window.historyAPI?.search) {
        this.searchPaneSearching = false;
        this.setSearchPaneStatus('Search service not available.');
        return;
      }

      const basePayload = {
        query,
        mode: 'keyword',
        source: 'all',
        limit: SEARCH_PANE_LIMIT,
        chunk_size: SEARCH_PANE_CHUNK,
      };

      const seen = new Set();
      let cursor = 0;

      const appendCandidates = (candidates) => {
        const mapped = this.mapSearchCandidates(Array.isArray(candidates) ? candidates : []);
        let added = 0;
        const appended = [];
        for (const candidate of mapped) {
          const blockId = candidate?.block?.id || candidate?.block_id || candidate?.id || '';
          if (blockId) {
            if (seen.has(blockId)) continue;
            seen.add(blockId);
          }
          this.searchPaneResults.push(candidate);
          appended.push(candidate);
          added += 1;
        }
        if (added > 0) {
          this.store?.sortSearchPaneResults?.(this.searchPaneResults);
          this.updateSearchPaneCount();
          this.appendSearchPaneCards(appended);
        }
      };

      const finalize = (message = '') => {
        if (requestId !== this.searchPaneRequestId) return;
        this.searchPaneSearching = false;
        const total = this.searchPaneResults.length;
        const status = message || (total === 0 ? 'No results.' : '');
        this.setSearchPaneStatus(status);
        this.updateSearchPaneCount();
        if (total === 0 || this.searchPaneRenderedIds.size === 0) {
          this.renderSearchPaneList();
        }
      };

      const fetchChunk = async () => {
        if (requestId !== this.searchPaneRequestId) return;
        const remaining = Math.max(0, SEARCH_PANE_LIMIT - this.searchPaneResults.length);
        if (remaining <= 0) {
          finalize();
          return;
        }
        const payload = {
          ...basePayload,
          cursor,
          limit: remaining,
        };
        let result;
        try {
          result = await window.historyAPI.search(payload);
        } catch (e) {
          if (requestId !== this.searchPaneRequestId) return;
          console.warn('Search pane: history search failed', e);
          finalize('Search failed.');
          return;
        }
        if (requestId !== this.searchPaneRequestId) return;
        if (result?.unavailable) {
          finalize('Search unavailable.');
          return;
        }
        const payloadResult = result?.result || result;
        if (!payloadResult || payloadResult.error) {
          finalize(payloadResult?.error || 'Search failed.');
          return;
        }
        appendCandidates(payloadResult.candidates);
        const nextCursor = Number.isFinite(payloadResult?.next_cursor) ? payloadResult.next_cursor : null;
        if (nextCursor === null) {
          finalize();
          return;
        }
        cursor = nextCursor;
        setTimeout(fetchChunk, 0);
      };

      await fetchChunk();
    }

    toggleSearchPaneDetail(blockId, card) {
      if (!blockId || !card) return;
      const isOpen = card.classList.contains('show-detail');
      if (isOpen) {
        card.classList.remove('show-detail');
        this.searchPaneOpenState.set(blockId, false);
        return;
      }
      card.classList.add('show-detail');
      this.searchPaneOpenState.set(blockId, true);
      const detail = card.querySelector('.search-item-detail');
      if (!detail || detail.childElementCount > 0) return;
      const candidate = this.searchPaneCandidateMap.get(blockId);
      const block = candidate?.block || candidate;
      if (block) {
        this.renderSearchPaneDetailInto(block, detail);
      }
    }

    renderSearchPaneDetailInto(block, container) {
      if (!block || !container) return;
      container.replaceChildren();

      const detail = document.createElement('div');
      detail.className = 'search-detail';
      container.appendChild(detail);

      const terms = normalizeSearchTermsForHighlight(this.searchPaneQuery);

      const inputLabel = document.createElement('div');
      inputLabel.className = 'search-detail-label';
      inputLabel.textContent = 'Input';
      detail.appendChild(inputLabel);

      const inputContent = document.createElement('pre');
      inputContent.className = 'search-detail-content';
      const inputText = this.store?.formatInputsForDetail?.(this.store?.getBlockInputs?.(block) || []);
      if (inputText) {
        const highlighted = buildHighlightHtml(inputText, terms);
        inputContent.innerHTML = highlighted.html;
      } else {
        inputContent.textContent = '(no input)';
      }
      detail.appendChild(inputContent);

      const outputLabel = document.createElement('div');
      outputLabel.className = 'search-detail-label';
      outputLabel.textContent = 'Output';
      detail.appendChild(outputLabel);

      const outputContent = document.createElement('pre');
      outputContent.className = 'search-detail-content';
      const rawOutput = block.output_text ?? block.output_head ?? block.output_tail ?? '';
      const normalized = this.store?.normalizeOutputText?.(rawOutput) || '';
      const outputText = this.store?.clampText?.(normalized, DETAIL_OUTPUT_LIMIT) || '';
      if (outputText) {
        const highlighted = buildHighlightHtml(outputText, terms);
        outputContent.innerHTML = highlighted.html;
      } else {
        outputContent.textContent = '(no output)';
      }
      detail.appendChild(outputContent);
    }

    renderSearchPaneList() {
      if (!this.searchPaneListEl) return;
      this.searchPaneListEl.replaceChildren();
      this.searchPaneCandidateMap.clear();
      this.searchPaneRenderedIds.clear();

      const list = Array.isArray(this.searchPaneResults) ? this.searchPaneResults : [];
      if (list.length === 0) {
        if (!this.searchPaneSearching && this.searchPaneQuery.length >= SEARCH_PANE_MIN_CHARS) {
          const empty = document.createElement('div');
          empty.className = 'session-sidebar-empty';
          empty.textContent = 'No results.';
          this.searchPaneListEl.appendChild(empty);
        }
        return;
      }

      const fragment = document.createDocumentFragment();
      for (const candidate of list) {
        const card = this.buildSearchPaneCard(candidate);
        if (card) {
          const blockId = String(card.dataset.blockId || '');
          if (blockId) this.searchPaneRenderedIds.add(blockId);
          fragment.appendChild(card);
        }
      }
      this.searchPaneListEl.appendChild(fragment);
    }

    buildSearchPaneCard(candidate) {
      const block = candidate?.block || candidate;
      if (!block) return null;
      const blockId = block?.id || candidate?.block_id || candidate?.id || '';
      if (!blockId) return null;
      this.searchPaneCandidateMap.set(String(blockId), candidate);
      const terms = normalizeSearchTermsForHighlight(this.searchPaneQuery);

      const card = document.createElement('div');
      card.className = 'session-item search-item';
      card.dataset.blockId = String(blockId);
      const safeTimestamp = this.store?.getSearchPaneCandidateTimestamp?.(candidate) || Date.now();
      card.dataset.timestamp = String(safeTimestamp);

      const header = document.createElement('div');
      header.className = 'session-item-header';

      const meta = document.createElement('div');
      meta.className = 'search-item-meta';
      const source = String(block?.source || '').trim().toLowerCase();
      const label = this.store?.formatSourceLabel?.(source) || '';
      if (label) {
        const chip = document.createElement('span');
        chip.className = `session-item-toggle-source ${source || ''}`.trim();
        chip.textContent = label;
        meta.appendChild(chip);
      }
      const ago = document.createElement('span');
      ago.className = 'session-item-toggle-ago search-item-ago';
      ago.textContent = this.store?.formatAgo?.(safeTimestamp) || '';
      meta.appendChild(ago);
      header.appendChild(meta);

      const input = document.createElement('div');
      input.className = 'session-item-input';
      const inputText = this.store?.getSearchPaneInputPreview?.(block) || '';
      if (inputText) {
        const highlighted = buildHighlightHtml(inputText, terms);
        input.innerHTML = highlighted.html;
      } else {
        input.textContent = '(no input)';
      }
      header.appendChild(input);

      const output = document.createElement('div');
      output.className = 'search-item-output';
      const outputText = this.store?.getSearchPaneOutputPreview?.(block) || '';
      if (outputText) {
        const highlighted = buildHighlightHtml(outputText, terms);
        output.innerHTML = highlighted.html;
      } else {
        output.textContent = '(no output)';
      }
      header.appendChild(output);

      const footer = document.createElement('div');
      footer.className = 'session-item-footer';
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'session-item-toggle search-item-toggle';
      toggleBtn.title = 'Toggle details';
      toggleBtn.innerHTML = [
        '<span class="session-item-toggle-label">Details</span>',
        '<span class="session-item-toggle-icon">',
        '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        '</span>',
      ].join('');
      footer.appendChild(toggleBtn);
      header.appendChild(footer);

      const timeMachine = document.createElement('button');
      timeMachine.type = 'button';
      timeMachine.className = 'search-item-action search-item-tm';
      timeMachine.title = 'Time Machine';
      timeMachine.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M26,18a3.9962,3.9962,0,0,0-3.8579,3H17V11h5.1421a4,4,0,1,0,0-2H17a2.002,2.002,0,0,0-2,2v4H9.8579a4,4,0,1,0,0,2H15v4a2.002,2.002,0,0,0,2,2h5.1421A3.9934,3.9934,0,1,0,26,18ZM26,8a2,2,0,1,1-2,2A2.002,2.002,0,0,1,26,8ZM6,18a2,2,0,1,1,2-2A2.002,2.002,0,0,1,6,18Zm20,6a2,2,0,1,1,2-2A2.002,2.002,0,0,1,26,24Z" fill="currentColor"/></svg>';
      header.appendChild(timeMachine);

      card.appendChild(header);

      const detail = document.createElement('div');
      detail.className = 'search-item-detail';
      detail.dataset.blockId = String(blockId);
      card.appendChild(detail);

      if (this.searchPaneOpenState.get(String(blockId))) {
        card.classList.add('show-detail');
        this.renderSearchPaneDetailInto(block, detail);
      }

      return card;
    }

    mapSearchCandidates(candidates) {
      const list = Array.isArray(candidates) ? candidates : [];
      return list.map((candidate) => {
        const direct = candidate?.block && typeof candidate.block === 'object' ? candidate.block : null;
        const legacyId = candidate?.block_id ? String(candidate.block_id) : '';
        const fromCache = legacyId ? this.tracker?.blockMap?.get?.(legacyId) : null;
        const block = direct || fromCache || null;

        if (block) {
          if (!block.id && block.block_id) block.id = String(block.block_id);
          if (!block.id && block.uuid) block.id = String(block.uuid);

          if (!block.input && typeof block.prompt === 'string') block.input = block.prompt;
          if (!block.output_text && typeof block.output === 'string') block.output_text = block.output;
          if (!block.output_text && typeof block.text === 'string') block.output_text = block.text;

          if (!block.pane_label) {
            const source = String(block.source || this.historySource || '').toLowerCase();
            if (source === 'claude') block.pane_label = 'Claude';
            if (source === 'codex') block.pane_label = 'Codex';
          }

          if (!block.source) {
            const hint = String(candidate?.source || '').trim().toLowerCase();
            if (hint) {
              block.source = hint;
            } else if (this.historySource === 'claude') {
              block.source = 'claude';
            } else if (this.historySource === 'codex') {
              block.source = 'codex';
            }
          }

          if (!block.session_id) {
            const candidateSession = block.sessionId || block.sessionID || block.session || '';
            if (typeof candidateSession === 'string' && candidateSession.trim()) {
              block.session_id = candidateSession.trim();
            }
          }

          if (!block.cwd) {
            const candidateCwd = block.project || block.project_path || block.projectPath || block.repo_path || block.repoPath || '';
            if (typeof candidateCwd === 'string' && candidateCwd.trim()) {
              block.cwd = candidateCwd.trim();
            }
          }

          if (typeof block.created_at === 'string') {
            const ms = Date.parse(block.created_at);
            if (Number.isFinite(ms)) block.created_at = ms;
          }
          if (!block.created_at && typeof block.timestamp === 'string') {
            const ms = Date.parse(block.timestamp);
            if (Number.isFinite(ms)) block.created_at = ms;
          }
          if (!block.created_at && typeof block.timestamp === 'number') {
            block.created_at = block.timestamp;
          }
          if (typeof block.last_output_at === 'string') {
            const ms = Date.parse(block.last_output_at);
            if (Number.isFinite(ms)) block.last_output_at = ms;
          }
          if (!block.last_output_at && typeof block.created_at === 'number') {
            block.last_output_at = block.created_at;
          }

          if (this.store?.setBlockInputs && this.store?.getBlockInputs) {
            this.store.setBlockInputs(block, this.store.getBlockInputs(block));
          }
          if (!block.output_text && block.output_raw) {
            const outputText = this.store?.normalizeOutputText?.(block.output_raw) || String(block.output_raw || '');
            block.output_text = outputText;
            const clamp = this.store?.clampText;
            block.output_head = clamp ? clamp(outputText, OUTPUT_HEAD_CHARS) : String(outputText || '').slice(0, OUTPUT_HEAD_CHARS);
            block.output_tail = outputText.length > OUTPUT_TAIL_CHARS ? outputText.slice(-OUTPUT_TAIL_CHARS) : outputText;
          } else if (block.output_text && (!block.output_head || !block.output_tail)) {
            const outputText = String(block.output_text || '');
            const clamp = this.store?.clampText;
            block.output_head = clamp ? clamp(outputText, OUTPUT_HEAD_CHARS) : outputText.slice(0, OUTPUT_HEAD_CHARS);
            block.output_tail = outputText.length > OUTPUT_TAIL_CHARS ? outputText.slice(-OUTPUT_TAIL_CHARS) : outputText;
          }

          const id = block.id ? String(block.id) : '';
          if (id && this.tracker) {
            const existing = this.tracker.blockMap?.get?.(id) || null;
            if (existing) {
              const prevLen = String(existing.output_text || '').length;
              const nextLen = String(block.output_text || '').length;
              const prevLast = Number(existing.last_output_at) || 0;
              const nextLast = Number(block.last_output_at) || 0;
              if (nextLen > prevLen || nextLast > prevLast) {
                Object.assign(existing, block);
              }
              return { ...candidate, block: existing };
            }
            this.tracker.blockMap?.set?.(id, block);
            this.tracker.blocks?.push?.(block);
          }
        }

        return { ...candidate, block };
      });
    }
  }

  window.HistorySearchUI = HistorySearchUI;
})();
