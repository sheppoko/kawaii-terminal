(function () {
  'use strict';

  const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i;

  const PREVIEW_DELAY = 700; // ms before showing preview
  const PREVIEW_SIZE_KEY = 'kawaii-image-preview-size';
  const PREVIEW_DEFAULT_SIZE = { width: 520, height: 440 };
  const PREVIEW_MIN_SIZE = { width: 220, height: 160 };
  const PREVIEW_PADDING = 12;

  class ImagePreviewManager {
    constructor() {
      this.previewEl = null;
      this.previewImg = null;
      this.previewInfo = null;
      this.previewHint = null;
      this.currentPath = null;
      this.hoverTimeout = null;
      this.pendingChecks = new Map();
      this.pendingSizeSave = null;
      this.isUserPositioned = false;
      this.dragState = null;
      this.resizeState = null;
      this.size = { ...PREVIEW_DEFAULT_SIZE };
      this.preferredSize = { ...PREVIEW_DEFAULT_SIZE };
      this.naturalSize = null;

      // Track mouse position globally
      this.mouseX = 0;
      this.mouseY = 0;

      // Base path for relative path resolution (homedir by default)
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
      // Create preview overlay
      this.previewEl = document.createElement('div');
      this.previewEl.className = 'image-preview-tooltip';
      this.previewEl.innerHTML = `
        <div class="md-preview-header">
          <div class="md-preview-info"></div>
          <div class="md-preview-header-actions">
            <div class="md-preview-hint"></div>
            <button class="md-preview-close" title="Close" aria-label="Close">&#x2715;</button>
          </div>
        </div>
        <div class="image-preview-loading">Loading...</div>
        <div class="image-preview-error">Cannot load image</div>
        <div class="image-preview-content">
          <img class="image-preview-img" alt="Preview" draggable="true" />
        </div>
      `;

      this.previewImg = this.previewEl.querySelector('.image-preview-img');
      this.previewInfo = this.previewEl.querySelector('.md-preview-info');
      this.previewHint = this.previewEl.querySelector('.md-preview-hint');
      this.closeEl = this.previewEl.querySelector('.md-preview-close');
      this.loadingEl = this.previewEl.querySelector('.image-preview-loading');
      this.errorEl = this.previewEl.querySelector('.image-preview-error');

      // Make thumbnail draggable with original file path
      this.previewImg.addEventListener('dragstart', (e) => {
        if (this.currentPath) {
          // Set the original file path as text data
          e.dataTransfer.setData('text/plain', this.currentPath);
          e.dataTransfer.setData('application/x-image-path', this.currentPath);
          e.dataTransfer.effectAllowed = 'copy';
        }
      });

      // Ctrl/Cmd + click to open image
      this.previewEl.addEventListener('click', (e) => {
        if (!this.currentPath) return;
        if (!this.shouldOpenLink(e)) return;
        e.preventDefault();
        this.openImage(this.currentPath);
      });

      if (this.previewHint) {
        this.previewHint.textContent = this.getOpenHintText();
      }

      if (this.closeEl) {
        this.closeEl.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.hidePreview();
        });
      }

      this.applySavedSize();
      this.initDragHandlers();
      this.initResizeHandles();

      document.body.appendChild(this.previewEl);

      // Hide on click outside
      document.addEventListener('mousedown', (e) => {
        if (!this.previewEl.contains(e.target)) {
          this.hidePreview();
        }
      });

      // Hide on scroll
      document.addEventListener('scroll', (event) => {
        if (this.previewEl.contains(event.target)) return;
        this.hidePreview();
      }, true);
    }

    extractImagePaths(text) {
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
        if (!IMAGE_EXTENSIONS.test(match.path)) continue;
        addCandidate(match.text, match.path, match.startIndex, match.endIndex - match.startIndex);
      }

      const pathMatches = linkDetection.findFilePathMatches
        ? linkDetection.findFilePathMatches(text, { isWin, isImagePath: () => false })
        : [];
      for (const match of pathMatches) {
        if (!IMAGE_EXTENSIONS.test(match.path)) continue;
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

    // Register link provider for a terminal instance
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

            // Join wrapped lines into a single logical line.
            // - Explicit newline -> next line's isWrapped is false (do not join)
            // - Soft wrap -> next line's isWrapped is true (join)
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

            const imagePaths = self.extractImagePaths(text);
            // Log only when image paths are found to reduce noise
            if (imagePaths.length === 0) return callback(undefined);

            const links = [];
            for (const { path: filePath, resolved, index } of imagePaths) {
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
                  self.openImage(resolvedPath);
                },
                hover: (_event, _linkText) => {
                  // Use tracked mouse position since event may not have correct coords
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
            console.error('Image link provider error:', e);
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
        // Use current mouse position at show time, not hover time
        this.showPreview(filePath, this.mouseX, this.mouseY);
      }, PREVIEW_DELAY);
    }

    cancelPreview() {
      if (this.hoverTimeout) {
        clearTimeout(this.hoverTimeout);
        this.hoverTimeout = null;
      }
    }

    applySavedSize() {
      const saved = this.getSavedSize();
      this.preferredSize = { width: saved.width, height: saved.height };
      this.applySize(saved.width, saved.height, { skipSave: true });
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

    constrainSize(width, height, { allowSmall = false } = {}) {
      const minWidth = allowSmall ? 1 : PREVIEW_MIN_SIZE.width;
      const minHeight = allowSmall ? 1 : PREVIEW_MIN_SIZE.height;
      const maxWidth = Math.max(minWidth, window.innerWidth - PREVIEW_PADDING * 2);
      const maxHeight = Math.max(minHeight, window.innerHeight - PREVIEW_PADDING * 2);
      const nextWidth = Math.min(Math.max(minWidth, Math.round(width || this.size.width)), maxWidth);
      const nextHeight = Math.min(Math.max(minHeight, Math.round(height || this.size.height)), maxHeight);
      return {
        width: nextWidth,
        height: nextHeight,
      };
    }

    applySize(width, height, { skipSave = false, allowSmall = false } = {}) {
      if (!this.previewEl) return;
      const constrained = this.constrainSize(width, height, { allowSmall });
      const nextWidth = constrained.width;
      const nextHeight = constrained.height;
      this.size = { width: nextWidth, height: nextHeight };
      this.previewEl.style.width = `${nextWidth}px`;
      this.previewEl.style.height = `${nextHeight}px`;
      if (!skipSave) {
        this.setPreferredSize(nextWidth, nextHeight);
      }
    }

    clampRect({ left, top, width, height, allowSmall = false }) {
      const constrained = this.constrainSize(width, height, { allowSmall });
      const maxLeft = window.innerWidth - PREVIEW_PADDING - constrained.width;
      const maxTop = window.innerHeight - PREVIEW_PADDING - constrained.height;
      const clampedLeft = Math.min(Math.max(PREVIEW_PADDING, left), maxLeft);
      const clampedTop = Math.min(Math.max(PREVIEW_PADDING, top), maxTop);
      return { left: clampedLeft, top: clampedTop, width: constrained.width, height: constrained.height };
    }

    setRect(rect, { skipSave = false, allowSmall = false } = {}) {
      if (!this.previewEl) return;
      this.previewEl.style.left = `${Math.round(rect.left)}px`;
      this.previewEl.style.top = `${Math.round(rect.top)}px`;
      this.applySize(rect.width, rect.height, { skipSave, allowSmall });
    }

    setPreferredSize(width, height) {
      if (!Number.isFinite(width) || !Number.isFinite(height)) return;
      this.preferredSize = { width, height };
      this.queueSaveSize(width, height);
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
          this.setRect(rect, { skipSave: true });
        };

        const onUp = () => {
          if (this.resizeState) {
            this.setPreferredSize(this.size.width, this.size.height);
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

    async showPreview(filePath, x, y) {
      if (!filePath) return;

      // Use current mouse position if x,y are 0 or invalid
      if (!x && !y) {
        x = this.mouseX;
        y = this.mouseY;
      }


      this.currentPath = filePath;
      this.naturalSize = null;
      if (this.preferredSize) {
        this.applySize(this.preferredSize.width, this.preferredSize.height, { skipSave: true });
      }

      // Show loading state
      this.previewEl.classList.add('show', 'loading');
      this.previewEl.classList.remove('error');
      this.previewImg.style.display = 'none';
      this.loadingEl.style.display = 'block';
      this.errorEl.style.display = 'none';

      // Position preview near mouse
      this.positionPreview(x, y);

      // Check if already pending
      if (this.pendingChecks.has(filePath)) {
        return;
      }

      this.pendingChecks.set(filePath, true);

      try {
        // Check if file API is available
        if (!window.fileAPI) {
          console.error('[ImagePreview] fileAPI not available');
          this.showError('File API not available');
          this.pendingChecks.delete(filePath);
          return;
        }

        // Check if file exists and is valid
        const check = await window.fileAPI.checkImageFile(filePath, this.basePath);

        if (this.currentPath !== filePath) {
          this.pendingChecks.delete(filePath);
          return; // User moved to different path
        }

        if (!check?.exists) {
          const msg = check?.error || (check?.tooLarge ? 'File too large' : 'File not found');
          this.showError(msg);
          this.pendingChecks.delete(filePath);
          return;
        }

        // Load image
        const dataUrl = await window.fileAPI.readImageAsDataUrl(filePath, this.basePath);

        if (this.currentPath !== filePath) {
          this.pendingChecks.delete(filePath);
          return;
        }

        if (!dataUrl) {
          this.showError('Failed to read file');
          this.pendingChecks.delete(filePath);
          return;
        }

        const info = this.formatFileInfo(filePath, check.size);
        this.displayImage(dataUrl, info, filePath);
      } catch (e) {
        console.error('[ImagePreview] Error:', e);
        this.showError(e.message || 'Error loading image');
      }

      this.pendingChecks.delete(filePath);
    }

    displayImage(dataUrl, info, filePath) {
      this.previewEl.classList.remove('loading', 'error');
      this.loadingEl.style.display = 'none';
      this.errorEl.style.display = 'none';
      this.previewImg.style.display = 'block';
      this.previewImg.onload = () => {
        if (this.currentPath && filePath && this.currentPath !== filePath) return;
        const naturalWidth = this.previewImg.naturalWidth || 1;
        const naturalHeight = this.previewImg.naturalHeight || 1;
        this.naturalSize = {
          width: naturalWidth,
          height: naturalHeight,
          ratio: naturalWidth / naturalHeight,
        };

        const header = this.previewEl?.querySelector?.('.md-preview-header');
        const headerHeight = header?.getBoundingClientRect?.().height || 0;
        const chromeX = 16;
        const chromeY = 16 + headerHeight;

        const preferred = this.preferredSize || this.size;
        const targetSmallWidth = Math.round(naturalWidth + chromeX);
        const targetSmallHeight = Math.round(naturalHeight + chromeY);
        const shouldAutoFit = targetSmallWidth <= preferred.width && targetSmallHeight <= preferred.height;

        const targetWidth = shouldAutoFit ? targetSmallWidth : preferred.width;
        const targetHeight = shouldAutoFit ? targetSmallHeight : preferred.height;
        this.applySize(targetWidth, targetHeight, { skipSave: true, allowSmall: shouldAutoFit });

        const rect = this.clampRect({
          left: parseFloat(this.previewEl.style.left) || PREVIEW_PADDING,
          top: parseFloat(this.previewEl.style.top) || PREVIEW_PADDING,
          width: this.size.width,
          height: this.size.height,
          allowSmall: shouldAutoFit,
        });
        this.setRect(rect, { skipSave: true, allowSmall: shouldAutoFit });
      };
      this.previewImg.src = dataUrl;
      this.previewInfo.textContent = info;
    }

    showError(msg) {
      this.previewEl.classList.remove('loading');
      this.previewEl.classList.add('error');
      this.loadingEl.style.display = 'none';
      this.previewImg.style.display = 'none';
      this.errorEl.style.display = 'block';
      this.errorEl.textContent = msg || 'Cannot load image';
    }

    hidePreview() {
      this.cancelPreview();
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
        this.setRect(rect, { skipSave: true });
        return;
      }

      let left = x + PREVIEW_PADDING;
      let top = y + PREVIEW_PADDING;

      const rect = this.clampRect({
        left,
        top,
        width: this.size.width,
        height: this.size.height,
      });
      if (left + rect.width > window.innerWidth - PREVIEW_PADDING) {
        left = x - rect.width - PREVIEW_PADDING;
      }
      if (top + rect.height > window.innerHeight - PREVIEW_PADDING) {
        top = y - rect.height - PREVIEW_PADDING;
      }
      const finalRect = this.clampRect({ left, top, width: rect.width, height: rect.height });
      this.setRect(finalRect, { skipSave: true });
    }

    formatFileInfo(filePath, size) {
      // Get filename from path (handle both / and \)
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

    openImage(filePath) {
      if (!filePath) return;
      window.fileAPI?.openFile(filePath, this.basePath);
    }

    // Set base path for relative path resolution (call when terminal cwd changes)
    setBasePath(basePath) {
      this.basePath = basePath;
    }
  }

  window.ImagePreviewManager = ImagePreviewManager;
})();
