(function () {
  'use strict';

  const MD_EXTENSIONS = /\.(md|markdown|mkd|mdx)$/i;
  const PREVIEW_DELAY = 700;
  const MAX_FILE_SIZE = 512 * 1024; // 512KB
  const PREVIEW_SIZE_KEY = 'kawaii-md-preview-size';
  const PREVIEW_DEFAULT_SIZE = { width: 520, height: 440 };
  const PREVIEW_MIN_SIZE = { width: 360, height: 240 };
  const PREVIEW_PADDING = 12;
  const MARKDOWN_FORBID_TAGS = ['script', 'style', 'iframe', 'object', 'embed'];
  const MARKDOWN_FORBID_ATTR = ['style'];
  const MARKDOWN_SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'file:']);

  function hasScheme(value) {
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
  }

  function isSafeUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return false;
    const lower = raw.toLowerCase();
    if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) return false;
    if (lower.startsWith('//')) return false;
    if (!hasScheme(raw)) return true;
    try {
      const parsed = new URL(raw);
      return MARKDOWN_SAFE_PROTOCOLS.has(parsed.protocol);
    } catch (_) {
      return false;
    }
  }

  function getDomPurify() {
    const purifier = window.DOMPurify;
    if (!purifier || typeof purifier.sanitize !== 'function') return null;
    if (!purifier.__kawaiiMarkdownConfigured) {
      purifier.setConfig({
        USE_PROFILES: { html: true },
        FORBID_TAGS: MARKDOWN_FORBID_TAGS,
        FORBID_ATTR: MARKDOWN_FORBID_ATTR,
      });
      purifier.addHook('afterSanitizeAttributes', (node) => {
        if (node.hasAttribute?.('href')) {
          const href = node.getAttribute('href');
          if (!isSafeUrl(href)) {
            node.removeAttribute('href');
          }
        }
        if (node.hasAttribute?.('src')) {
          const src = node.getAttribute('src');
          if (!isSafeUrl(src)) {
            node.removeAttribute('src');
          }
        }
        if (node.hasAttribute?.('xlink:href')) {
          const xlink = node.getAttribute('xlink:href');
          if (!isSafeUrl(xlink)) {
            node.removeAttribute('xlink:href');
          }
        }
      });
      purifier.__kawaiiMarkdownConfigured = true;
    }
    return purifier;
  }

  function sanitizeMarkdownHtml(html) {
    const purifier = getDomPurify();
    if (!purifier) return sanitizeMarkdownFallback(html);
    return purifier.sanitize(String(html || ''));
  }

  function sanitizeMarkdownFallback(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    const forbiddenTags = new Set(MARKDOWN_FORBID_TAGS.map(tag => tag.toLowerCase()));

    const walker = document.createTreeWalker(
      template.content,
      NodeFilter.SHOW_ELEMENT,
      null,
      false
    );

    const toRemove = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const tagName = node.tagName ? node.tagName.toLowerCase() : '';
      if (tagName && forbiddenTags.has(tagName)) {
        toRemove.push(node);
        continue;
      }
      const attrs = Array.from(node.attributes || []);
      for (const attr of attrs) {
        const name = attr.name.toLowerCase();
        if (MARKDOWN_FORBID_ATTR.includes(name)) {
          node.removeAttribute(attr.name);
          continue;
        }
        if (name.startsWith('on')) {
          node.removeAttribute(attr.name);
          continue;
        }
        if (name === 'href' || name === 'src' || name === 'xlink:href') {
          if (!isSafeUrl(attr.value)) {
            node.removeAttribute(attr.name);
          }
        }
      }
    }

    for (const node of toRemove) {
      node.remove();
    }

    return template.innerHTML;
  }

  class MdPreviewManager {
    constructor() {
      this.previewEl = null;
      this.contentEl = null;
      this.infoEl = null;
      this.hintEl = null;
      this.closeEl = null;
      this.loadingEl = null;
      this.errorEl = null;
      this.currentPath = null;
      this.hoverTimeout = null;
      this.pendingChecks = new Map();
      this.scrollPositions = new Map();
      this.pendingScrollRestore = null;
      this.pendingScrollSaveRaf = null;

      this.mouseX = 0;
      this.mouseY = 0;
      this.isUserPositioned = false;
      this.dragState = null;
      this.resizeState = null;
      this.size = { ...PREVIEW_DEFAULT_SIZE };
      this.pendingSizeSave = null;

      this.basePath = window.fileAPI?.getHomedir?.() || null;

      this.createPreviewElement();
      this.trackMousePosition();
    }

    trackMousePosition() {
      document.addEventListener('mousemove', (e) => {
        this.mouseX = e.clientX;
        this.mouseY = e.clientY;
      }, { passive: true });
    }

    createPreviewElement() {
      this.previewEl = document.createElement('div');
      this.previewEl.className = 'md-preview-tooltip';
      this.previewEl.innerHTML = `
        <div class="md-preview-header">
          <div class="md-preview-info"></div>
          <div class="md-preview-header-actions">
            <div class="md-preview-hint"></div>
            <button class="md-preview-close" title="Close" aria-label="Close">&#x2715;</button>
          </div>
        </div>
        <div class="md-preview-loading">Loading...</div>
        <div class="md-preview-error">Cannot load file</div>
        <div class="md-preview-content markdown-body"></div>
      `;

      this.contentEl = this.previewEl.querySelector('.md-preview-content');
      this.infoEl = this.previewEl.querySelector('.md-preview-info');
      this.hintEl = this.previewEl.querySelector('.md-preview-hint');
      this.closeEl = this.previewEl.querySelector('.md-preview-close');
      this.loadingEl = this.previewEl.querySelector('.md-preview-loading');
      this.errorEl = this.previewEl.querySelector('.md-preview-error');

      this.applySavedSize();

      this.previewEl.addEventListener('click', (e) => {
        if (!this.currentPath) return;
        if (!this.shouldOpenLink(e)) return;
        e.preventDefault();
        this.openFile(this.currentPath);
      });

      if (this.closeEl) {
        this.closeEl.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.hidePreview();
        });
      }

      if (this.hintEl) {
        this.hintEl.textContent = this.getOpenHintText();
      }

      if (this.contentEl) {
        this.contentEl.addEventListener('scroll', () => {
          if (!this.currentPath) return;
          if (this.pendingScrollSaveRaf) return;
          this.pendingScrollSaveRaf = window.requestAnimationFrame(() => {
            this.pendingScrollSaveRaf = null;
            this.saveScrollPosition(this.currentPath);
          });
        }, { passive: true });
      }

      this.initDragHandlers();
      this.initResizeHandles();

      document.body.appendChild(this.previewEl);

      document.addEventListener('mousedown', (e) => {
        if (!this.previewEl.contains(e.target)) {
          this.hidePreview();
        }
      });

      document.addEventListener('scroll', (event) => {
        if (this.previewEl.contains(event.target)) return;
        this.hidePreview();
      }, true);
    }

    applySavedSize() {
      const saved = this.getSavedSize();
      this.applySize(saved.width, saved.height);
    }

    getSavedSize() {
      try {
        const raw = localStorage.getItem(PREVIEW_SIZE_KEY);
        if (!raw) return { ...PREVIEW_DEFAULT_SIZE };
        const parsed = JSON.parse(raw);
        const width = Number(parsed?.width);
        const height = Number(parsed?.height);
        if (!Number.isFinite(width) || !Number.isFinite(height)) {
          return { ...PREVIEW_DEFAULT_SIZE };
        }
        return {
          width: Math.max(PREVIEW_MIN_SIZE.width, Math.round(width)),
          height: Math.max(PREVIEW_MIN_SIZE.height, Math.round(height)),
        };
      } catch (_) {
        return { ...PREVIEW_DEFAULT_SIZE };
      }
    }

    applySize(width, height) {
      if (!this.previewEl) return;
      if (!Number.isFinite(width) || !Number.isFinite(height)) return;
      const maxWidth = Math.max(PREVIEW_MIN_SIZE.width, window.innerWidth - PREVIEW_PADDING * 2);
      const maxHeight = Math.max(PREVIEW_MIN_SIZE.height, window.innerHeight - PREVIEW_PADDING * 2);
      const nextWidth = Math.min(Math.max(PREVIEW_MIN_SIZE.width, Math.round(width)), maxWidth);
      const nextHeight = Math.min(Math.max(PREVIEW_MIN_SIZE.height, Math.round(height)), maxHeight);
      this.size = { width: nextWidth, height: nextHeight };
      this.previewEl.style.width = `${nextWidth}px`;
      this.previewEl.style.height = `${nextHeight}px`;
    }

    queueSaveSize(width, height) {
      if (this.pendingSizeSave) {
        clearTimeout(this.pendingSizeSave);
      }
      this.pendingSizeSave = setTimeout(() => {
        this.pendingSizeSave = null;
        try {
          localStorage.setItem(PREVIEW_SIZE_KEY, JSON.stringify({ width, height }));
        } catch (_) { /* noop */ }
      }, 120);
    }

    getCurrentRect() {
      const rect = this.previewEl?.getBoundingClientRect?.();
      if (rect) {
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width || this.size.width,
          height: rect.height || this.size.height,
        };
      }
      return {
        left: PREVIEW_PADDING,
        top: PREVIEW_PADDING,
        width: this.size.width,
        height: this.size.height,
      };
    }

    clampRect({ left, top, width, height }) {
      const maxWidth = Math.max(PREVIEW_MIN_SIZE.width, window.innerWidth - PREVIEW_PADDING * 2);
      const maxHeight = Math.max(PREVIEW_MIN_SIZE.height, window.innerHeight - PREVIEW_PADDING * 2);
      const clampedWidth = Math.min(Math.max(PREVIEW_MIN_SIZE.width, width), maxWidth);
      const clampedHeight = Math.min(Math.max(PREVIEW_MIN_SIZE.height, height), maxHeight);
      const maxLeft = window.innerWidth - PREVIEW_PADDING - clampedWidth;
      const maxTop = window.innerHeight - PREVIEW_PADDING - clampedHeight;
      const clampedLeft = Math.min(Math.max(PREVIEW_PADDING, left), maxLeft);
      const clampedTop = Math.min(Math.max(PREVIEW_PADDING, top), maxTop);
      return { left: clampedLeft, top: clampedTop, width: clampedWidth, height: clampedHeight };
    }

    setRect(rect) {
      if (!this.previewEl) return;
      this.previewEl.style.left = `${Math.round(rect.left)}px`;
      this.previewEl.style.top = `${Math.round(rect.top)}px`;
      this.applySize(rect.width, rect.height);
    }

    initDragHandlers() {
      const header = this.previewEl?.querySelector?.('.md-preview-header');
      if (!header) return;
      header.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        if (event.target?.closest?.('.md-preview-close')) return;
        event.preventDefault();
        const rect = this.getCurrentRect();
        this.dragState = {
          startX: event.clientX,
          startY: event.clientY,
          startLeft: rect.left,
          startTop: rect.top,
        };
        this.isUserPositioned = true;
        this.previewEl.classList.add('dragging');

        const onMove = (moveEvent) => {
          if (!this.dragState) return;
          moveEvent.preventDefault();
          const dx = moveEvent.clientX - this.dragState.startX;
          const dy = moveEvent.clientY - this.dragState.startY;
          const rect = this.clampRect({
            left: this.dragState.startLeft + dx,
            top: this.dragState.startTop + dy,
            width: this.size.width,
            height: this.size.height,
          });
          this.previewEl.style.left = `${Math.round(rect.left)}px`;
          this.previewEl.style.top = `${Math.round(rect.top)}px`;
        };

        const onUp = () => {
          this.dragState = null;
          this.previewEl.classList.remove('dragging');
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('pointerup', onUp, true);
        };

        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
      });
    }

    initResizeHandles() {
      if (!this.previewEl) return;
      const dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
      const handles = [];
      dirs.forEach((dir) => {
        const handle = document.createElement('div');
        handle.className = `md-preview-resize-handle ${dir}`;
        handle.dataset.dir = dir;
        this.previewEl.appendChild(handle);
        handles.push(handle);
      });

      const onPointerDown = (event) => {
        if (event.button !== 0) return;
        const dir = event.currentTarget?.dataset?.dir;
        if (!dir) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = this.getCurrentRect();
        this.resizeState = {
          dir,
          startX: event.clientX,
          startY: event.clientY,
          startLeft: rect.left,
          startTop: rect.top,
          startWidth: rect.width,
          startHeight: rect.height,
        };
        this.isUserPositioned = true;
        this.previewEl.classList.add('resizing');

        const onMove = (moveEvent) => {
          if (!this.resizeState) return;
          moveEvent.preventDefault();
          const dx = moveEvent.clientX - this.resizeState.startX;
          const dy = moveEvent.clientY - this.resizeState.startY;

          let left = this.resizeState.startLeft;
          let top = this.resizeState.startTop;
          let width = this.resizeState.startWidth;
          let height = this.resizeState.startHeight;

          if (dir.includes('e')) {
            width = this.resizeState.startWidth + dx;
          }
          if (dir.includes('s')) {
            height = this.resizeState.startHeight + dy;
          }
          if (dir.includes('w')) {
            width = this.resizeState.startWidth - dx;
            left = this.resizeState.startLeft + dx;
          }
          if (dir.includes('n')) {
            height = this.resizeState.startHeight - dy;
            top = this.resizeState.startTop + dy;
          }

          const rect = this.clampRect({ left, top, width, height });
          this.setRect(rect);
        };

        const onUp = () => {
          if (this.resizeState) {
            this.queueSaveSize(this.size.width, this.size.height);
          }
          this.resizeState = null;
          this.previewEl.classList.remove('resizing');
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('pointerup', onUp, true);
        };

        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
      };

      handles.forEach((handle) => {
        handle.addEventListener('pointerdown', onPointerDown);
      });
    }

    extractMdPaths(text) {
      const paths = [];
      const candidates = [];
      const seen = new Set();
      const linkDetection = window.KawaiiLinkDetection;
      if (!linkDetection) return paths;

      const isWin = window.windowAPI?.platform === 'win32';
      const addCandidate = (displayText, resolved, index, length) => {
        if (!displayText) return;
        const key = (resolved || displayText).toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({
          path: displayText,
          resolved,
          index,
          length,
        });
      };

      const fileUrlMatches = linkDetection.findFileUrlMatches
        ? linkDetection.findFileUrlMatches(text, { isWin })
        : [];
      for (const match of fileUrlMatches) {
        if (!MD_EXTENSIONS.test(match.path)) continue;
        addCandidate(match.text, match.path, match.startIndex, match.endIndex - match.startIndex);
      }

      const pathMatches = linkDetection.findFilePathMatches
        ? linkDetection.findFilePathMatches(text, { isWin, isImagePath: () => false })
        : [];
      for (const match of pathMatches) {
        if (!MD_EXTENSIONS.test(match.path)) continue;
        addCandidate(match.text, match.path, match.startIndex, match.endIndex - match.startIndex);
      }

      if (candidates.length === 0) return paths;

      candidates.sort((a, b) => {
        if (a.index !== b.index) return a.index - b.index;
        return b.length - a.length;
      });

      let lastEnd = -1;
      for (const candidate of candidates) {
        const start = candidate.index;
        const end = start + candidate.length;
        if (start < lastEnd) continue;
        paths.push({ path: candidate.path, resolved: candidate.resolved, index: candidate.index });
        lastEnd = end;
      }

      return paths;
    }

    registerLinkProvider(terminal) {
      if (!terminal) return null;

      const self = this;
      const linkDetection = window.KawaiiLinkDetection;
      const buildLineTextWithCellMap = (bufferLine, { trimRight = true } = {}) => {
        const cols = terminal?.cols;
        if (linkDetection?.buildLineTextWithCellMap) {
          return linkDetection.buildLineTextWithCellMap(bufferLine, cols, { trimRight });
        }
        if (!bufferLine || !cols) {
          return { text: '', indexToX: [], indexToWidth: [] };
        }

        const indexToX = [];
        const indexToWidth = [];
        let text = '';

        const maxX = Math.min(cols, bufferLine.length || cols);
        for (let x = 0; x < maxX; x += 1) {
          const cell = bufferLine.getCell(x);
          if (!cell) break;
          const width = typeof cell.getWidth === 'function' ? cell.getWidth() : 1;
          if (width === 0) continue;
          let chars = typeof cell.getChars === 'function' ? cell.getChars() : '';
          if (chars === '') chars = ' ';
          text += chars;
          for (let i = 0; i < chars.length; i += 1) {
            indexToX.push(x + 1);
            indexToWidth.push(width);
          }
        }

        if (trimRight) {
          while (text.length > 0) {
            const last = text[text.length - 1];
            if (!/\s/.test(last)) break;
            text = text.slice(0, -1);
            indexToX.pop();
            indexToWidth.pop();
          }
        }

        return { text, indexToX, indexToWidth };
      };

      const provider = {
        provideLinks: (bufferLineNumber, callback) => {
          try {
            const buffer = terminal.buffer?.active;
            if (!buffer) return callback(undefined);

            const bufferY = Math.max(0, bufferLineNumber - 1);
            const line = buffer.getLine(bufferY);
            if (!line) return callback(undefined);

            let startY = bufferY;
            while (startY > 0) {
              const cur = buffer.getLine(startY);
              if (!cur?.isWrapped) break;
              startY -= 1;
            }

            let endY = bufferY;
            while (endY + 1 < buffer.length) {
              const next = buffer.getLine(endY + 1);
              if (!next?.isWrapped) break;
              endY += 1;
            }

            const parts = [];
            let offset = 0;
            for (let y = startY; y <= endY; y += 1) {
              const l = buffer.getLine(y);
              const part = buildLineTextWithCellMap(l);
              parts.push({ y: y + 1, text: part.text, offset, indexToX: part.indexToX, indexToWidth: part.indexToWidth });
              offset += part.text.length;
            }

            const text = parts.map((p) => p.text).join('');
            if (!text) return callback(undefined);

            const partIndex = bufferY - startY;
            const currentPart = parts[partIndex] || null;
            if (!currentPart) return callback(undefined);
            const segmentStart = currentPart.offset;
            const segmentEnd = segmentStart + currentPart.text.length;

            const getCellPositionForIndex = (index) => {
              if (!Number.isFinite(index)) return null;
              if (index < 0) return null;
              for (let i = parts.length - 1; i >= 0; i -= 1) {
                const part = parts[i];
                if (!part) continue;
                const start = part.offset;
                const end = start + part.text.length;
                if (index >= start && index < end) {
                  const localIndex = index - start;
                  const x = part.indexToX?.[localIndex] ?? (localIndex + 1);
                  const width = part.indexToWidth?.[localIndex] ?? 1;
                  return { x, y: part.y, width };
                }
              }
              return null;
            };

            const mdPaths = self.extractMdPaths(text);
            if (mdPaths.length === 0) return callback(undefined);

            const links = [];
            for (const { path: filePath, resolved, index } of mdPaths) {
              const matchStart = index;
              const matchEnd = matchStart + filePath.length;
              if (matchEnd <= segmentStart || matchStart >= segmentEnd) {
                continue;
              }

              const startPos = getCellPositionForIndex(matchStart);
              const endCell = getCellPositionForIndex(matchEnd - 1);
              if (!startPos || !endCell) continue;
              const endPos = { x: endCell.x + Math.max(0, (endCell.width || 1) - 1), y: endCell.y };

              const resolvedPath = resolved || filePath;
              links.push({
                range: { start: startPos, end: endPos },
                text: filePath,
                activate: (event, _linkText) => {
                  event?.preventDefault?.();
                  if (!self.shouldOpenLink(event)) return;
                  self.openFile(resolvedPath);
                },
                hover: (_event, _linkText) => {
                  self.schedulePreview(resolvedPath);
                },
                leave: () => {
                  self.cancelPreview();
                },
                decorations: {
                  pointerCursor: true,
                  underline: true,
                },
              });
            }

            callback(links.length ? links : undefined);
          } catch (e) {
            console.error('MD link provider error:', e);
            callback(undefined);
          }
        },
      };

      const disposable = terminal.registerLinkProvider(provider);
      return disposable;
    }

    schedulePreview(filePath) {
      this.cancelPreview();

      this.hoverTimeout = setTimeout(() => {
        this.showPreview(filePath, this.mouseX, this.mouseY);
      }, PREVIEW_DELAY);
    }

    cancelPreview() {
      if (this.hoverTimeout) {
        clearTimeout(this.hoverTimeout);
        this.hoverTimeout = null;
      }
    }

    async showPreview(filePath, x, y) {
      if (!filePath) return;

      if (!x && !y) {
        x = this.mouseX;
        y = this.mouseY;
      }

      const prevPath = this.currentPath;
      if (prevPath && prevPath !== filePath) {
        this.saveScrollPosition(prevPath);
      }
      const currentScroll = this.contentEl
        ? { top: this.contentEl.scrollTop, left: this.contentEl.scrollLeft }
        : { top: 0, left: 0 };
      const saved = this.scrollPositions.get(filePath);
      this.pendingScrollRestore = saved
        ? { top: saved.top, left: saved.left }
        : (prevPath === filePath ? currentScroll : { top: 0, left: 0 });
      this.currentPath = filePath;

      this.previewEl.classList.add('show', 'loading');
      this.previewEl.classList.remove('error');
      this.contentEl.style.display = 'none';
      this.loadingEl.style.display = 'block';
      this.errorEl.style.display = 'none';

      this.positionPreview(x, y);

      if (this.pendingChecks.has(filePath)) {
        return;
      }

      this.pendingChecks.set(filePath, true);

      try {
        if (!window.fileAPI) {
          this.showError('File API not available');
          this.pendingChecks.delete(filePath);
          return;
        }

        const check = await window.fileAPI.checkTextFile(filePath, this.basePath, MAX_FILE_SIZE);

        if (this.currentPath !== filePath) {
          this.pendingChecks.delete(filePath);
          return;
        }

        if (!check?.exists) {
          const msg = check?.error || (check?.tooLarge ? 'File too large' : 'File not found');
          this.showError(msg);
          this.pendingChecks.delete(filePath);
          return;
        }

        const content = await window.fileAPI.readTextFile(filePath, this.basePath, MAX_FILE_SIZE);

        if (this.currentPath !== filePath) {
          this.pendingChecks.delete(filePath);
          return;
        }

        if (content === null) {
          this.showError('Failed to read file');
          this.pendingChecks.delete(filePath);
          return;
        }

        // Parse markdown
        const html = window.markdownAPI?.parse
          ? await window.markdownAPI.parse(content)
          : content;
        const safeHtml = sanitizeMarkdownHtml(html);
        const info = this.formatFileInfo(filePath, check.size);
        this.displayContent(safeHtml, info);

      } catch (e) {
        console.error('[MdPreview] Error:', e);
        this.showError(e.message || 'Error loading file');
      }

      this.pendingChecks.delete(filePath);
    }

    async displayContent(html, info) {
      this.previewEl.classList.remove('loading', 'error');
      this.loadingEl.style.display = 'none';
      this.errorEl.style.display = 'none';
      this.contentEl.style.display = 'block';
      this.contentEl.innerHTML = html;
      this.infoEl.textContent = info;

      this.restoreScrollPosition();
    }

    showError(msg) {
      this.previewEl.classList.remove('loading');
      this.previewEl.classList.add('error');
      this.loadingEl.style.display = 'none';
      this.contentEl.style.display = 'none';
      this.errorEl.style.display = 'block';
      this.errorEl.textContent = msg || 'Cannot load file';
    }

    hidePreview() {
      this.cancelPreview();
      if (this.currentPath) {
        this.saveScrollPosition(this.currentPath);
      }
      this.previewEl.classList.remove('show', 'loading', 'error');
      this.currentPath = null;
      this.isUserPositioned = false;
    }

    positionPreview(x, y) {
      if (!this.previewEl) return;
      if (this.isUserPositioned) {
        const rect = this.clampRect({
          left: parseFloat(this.previewEl.style.left) || PREVIEW_PADDING,
          top: parseFloat(this.previewEl.style.top) || PREVIEW_PADDING,
          width: this.size.width,
          height: this.size.height,
        });
        this.setRect(rect);
        return;
      }

      const padding = PREVIEW_PADDING;
      const previewWidth = this.size.width || PREVIEW_DEFAULT_SIZE.width;
      const previewHeight = this.size.height || PREVIEW_DEFAULT_SIZE.height;

      let left = x + padding;
      let top = y + padding;

      if (left + previewWidth > window.innerWidth - padding) {
        left = x - previewWidth - padding;
      }
      if (top + previewHeight > window.innerHeight - padding) {
        top = y - previewHeight - padding;
      }

      left = Math.max(padding, left);
      top = Math.max(padding, top);

      this.previewEl.style.left = `${left}px`;
      this.previewEl.style.top = `${top}px`;
    }

    formatFileInfo(filePath, size) {
      const fileName = filePath.split(/[/\\]/).pop() || filePath;
      const sizeStr = this.formatSize(size);
      return `${fileName} (${sizeStr})`;
    }

    formatSize(bytes) {
      if (!bytes) return '';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    shouldOpenLink(event) {
      if (!event) return false;
      return Boolean(event.ctrlKey || event.metaKey);
    }

    getOpenHintText() {
      const isMac = window.windowAPI?.platform === 'darwin';
      return isMac ? 'Cmd+Click to open' : 'Ctrl+Click to open';
    }

    openFile(filePath) {
      if (!filePath) return;
      window.fileAPI?.openFile(filePath, this.basePath);
    }

    setBasePath(basePath) {
      this.basePath = basePath;
    }

    saveScrollPosition(filePath) {
      if (!filePath || !this.contentEl) return;
      const top = this.contentEl.scrollTop || 0;
      const left = this.contentEl.scrollLeft || 0;
      this.scrollPositions.set(filePath, { top, left, ts: Date.now() });
      if (this.scrollPositions.size <= 60) return;
      let oldestKey = null;
      let oldestTs = Infinity;
      for (const [key, value] of this.scrollPositions.entries()) {
        const ts = value?.ts ?? 0;
        if (ts < oldestTs) {
          oldestTs = ts;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        this.scrollPositions.delete(oldestKey);
      }
    }

    restoreScrollPosition() {
      if (!this.contentEl) return;
      const target = this.pendingScrollRestore
        || this.scrollPositions.get(this.currentPath)
        || { top: 0, left: 0 };
      this.pendingScrollRestore = null;
      if (!target) return;
      this.contentEl.scrollTop = Number.isFinite(target.top) ? target.top : 0;
      this.contentEl.scrollLeft = Number.isFinite(target.left) ? target.left : 0;
    }
  }

  window.MdPreviewManager = MdPreviewManager;
})();
