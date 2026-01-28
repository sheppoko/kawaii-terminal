(function () {
  'use strict';

  function quotePathForShell(filePath) {
    if (!filePath) return '';
    if (window.windowAPI.platform === 'win32') {
      return `'${filePath.replace(/'/g, "''")}'`;
    }
    return `'${filePath.replace(/'/g, `'\\''`)}'`;
  }

  function initTerminalDragAndDrop(getActiveTerminal) {
    const terminalPanel = document.querySelector('.terminal-panel');
    const overlay = document.getElementById('terminal-drop-overlay');
    if (!terminalPanel || !overlay) return;

    let dragCounter = 0;

    const showOverlay = () => overlay.classList.add('show');
    const hideOverlay = () => overlay.classList.remove('show');

    terminalPanel.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      dragCounter += 1;
      showOverlay();
    });

    terminalPanel.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
    });

    terminalPanel.addEventListener('dragleave', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      dragCounter -= 1;
      if (dragCounter <= 0) {
        dragCounter = 0;
        hideOverlay();
      }
    });

    terminalPanel.addEventListener('drop', (e) => {
      e.preventDefault();
      dragCounter = 0;
      hideOverlay();

      // Check for image path from preview thumbnail drag
      const imagePath = e.dataTransfer?.getData('application/x-image-path') ||
                        e.dataTransfer?.getData('text/plain');

      // If it's a drag from image preview (has image path data but no real file)
      const files = Array.from(e.dataTransfer?.files || []);
      const getDropFilePath = (file) => (
        window.fileAPI?.getPathForFile?.(file) || file?.path || ''
      );
      const hasRealFiles = files.some(f => {
        const path = getDropFilePath(f);
        return Boolean(path && path.length > 0);
      });

      // Prefer image path data if files don't have real paths
      if (imagePath && !hasRealFiles) {
        const quoted = quotePathForShell(imagePath);
        if (quoted) {
          const terminalManager = getActiveTerminal();
          if (terminalManager) {
            terminalManager.paste(`${quoted} `);
          }
        }
        return;
      }

      // Handle regular file drops
      if (files.length === 0) {
        return;
      }

      const paths = files
        .map(file => {
          const filePath = getDropFilePath(file);
          const quoted = quotePathForShell(filePath);
          return quoted;
        })
        .filter(Boolean)
        .join(' ');

      if (paths) {
        const terminalManager = getActiveTerminal();
        if (terminalManager) {
          terminalManager.paste(`${paths} `);
        }
      }
    });
  }

  window.TerminalDnD = {
    initTerminalDragAndDrop,
  };
})();
