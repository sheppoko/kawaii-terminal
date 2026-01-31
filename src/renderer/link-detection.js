/* global module */
(function (root, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.KawaiiLinkDetection = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const buildLineTextWithCellMap = (bufferLine, cols, { trimRight = true } = {}) => {
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

  const stripOuterQuotes = (value) => {
    if (!value || value.length < 2) return value;
    const first = value[0];
    const last = value[value.length - 1];
    if (
      (first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === '`' && last === '`')
    ) {
      return value.slice(1, -1);
    }
    return value;
  };

  const hasLeftBoundary = (text, startIndex) => {
    if (!Number.isFinite(startIndex) || startIndex <= 0) return true;
    const prev = text[startIndex - 1] || '';
    if (!prev) return true;
    if (/\s/.test(prev)) return true;
    if ('([{"\'`<>=:;,.|'.includes(prev)) return true;
    return false;
  };

  const parsePathLocation = (unquotedMatch) => {
    const lineMatch =
      unquotedMatch.match(/:(\d+)(?::(\d+))?$/) ||
      unquotedMatch.match(/\((\d+),\s*(\d+)\)$/);
    const pathOnly = lineMatch
      ? unquotedMatch.replace(/:(\d+)(?::(\d+))?$/, '').replace(/\((\d+),\s*(\d+)\)$/, '')
      : unquotedMatch;
    const lineNum = lineMatch ? parseInt(lineMatch[1], 10) : null;
    const colNum = lineMatch && lineMatch[2] ? parseInt(lineMatch[2], 10) : null;
    return { pathOnly, lineNum, colNum };
  };

  const normalizeFileUrl = (url, { isWin = false } = {}) => {
    if (!url || typeof url !== 'string') return null;
    if (!/^file:\/\//i.test(url)) return null;

    let pathPart = url.replace(/^file:\/\//i, '');
    if (pathPart.startsWith('localhost/')) {
      pathPart = pathPart.slice('localhost/'.length);
    }

    try {
      pathPart = decodeURIComponent(pathPart);
    } catch (_) {
      // keep raw if decode fails
    }

    if (isWin) {
      if (/^\/[a-zA-Z]:\//.test(pathPart)) {
        pathPart = pathPart.slice(1);
      }
      const hasDrive = /^[a-zA-Z]:[\\/]/.test(pathPart);
      if (!hasDrive && !pathPart.startsWith('\\\\')) {
        pathPart = '\\\\' + pathPart.replace(/\//g, '\\');
      } else {
        pathPart = pathPart.replace(/\//g, '\\');
      }
    } else {
      if (!pathPart.startsWith('/')) {
        pathPart = '/' + pathPart;
      }
    }

    return pathPart;
  };

  const findFileUrlMatches = (text, { isWin = false } = {}) => {
    if (typeof text !== 'string' || text.length === 0) return [];
    const regex = /file:\/\/[^\s<>"'()]+/ig;
    const matches = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      const url = match[0];
      const resolvedPath = normalizeFileUrl(url, { isWin });
      if (!resolvedPath) continue;
      matches.push({
        startIndex: match.index,
        endIndex: match.index + url.length,
        text: url,
        path: resolvedPath,
      });
    }
    return matches;
  };

  const looksLikePath = (value) => {
    if (!value || typeof value !== 'string') return false;
    if (value === '.' || value === '..' || value === './' || value === '../') return false;
    if (/[\\/]/.test(value) === false) return false;
    const trimmed = value.replace(/[\\/]+$/, '');
    if (!trimmed || trimmed === '.' || trimmed === '..') return false;
    return true;
  };

  const findFilePathMatches = (text, { isWin = false, isImagePath = () => false } = {}) => {
    if (typeof text !== 'string' || text.length === 0) return [];

    // Windows absolute path: C:\path\file or C:/path/file.ext (allow trailing slash)
    const winAbsoluteRegex = /[A-Za-z]:[\\/](?:[^\s<>"'():|]+[\\/])*[^\s<>"'():|]+[\\/]?(?::\d+(?::\d+)?)?/g;
    // Unix absolute path: /path/to/file or /path/to/file.ext (allow trailing slash)
    // Allow common boundary chars like "(" in stack traces: (... (/path/to/file.ts:10:5))
    const unixAbsoluteRegex = /(?:^|(?<=[\s([{"'`|<]))\/(?:[^\s<>"'():|]+\/)*[^\s<>"'():|]+\/?(?::\d+(?::\d+)?)?/g;
    // Quoted paths (allow spaces)
    const quotedWinAbsoluteRegex = /(["'`])(?:[A-Za-z]:[\\/][^"'`\r\n]*?(?::\d+(?::\d+)?|\(\d+,\s*\d+\))?)\1/g;
    const quotedUnixAbsoluteRegex = /(["'`])(?:\/[^"'`\r\n]*?(?::\d+(?::\d+)?|\(\d+,\s*\d+\))?)\1/g;
    const quotedDotPathRegex = /(["'`])(?:(?:\.\.?[\\/])[^"'`\r\n]*?(?::\d+(?::\d+)?|\(\d+,\s*\d+\))?)\1/g;
    const quotedDirPathRegex = /(["'`])(?:[A-Za-z0-9_][^"'`\r\n]*?[\\/][^"'`\r\n]*?(?::\d+(?::\d+)?|\(\d+,\s*\d+\))?)\1/g;
    // Relative path with directory: path/to/file.ext, ./path/file.ext, ../../path/file.ext
    const dotPrefixPathRegex = /(?:\.\.?[\\/])+(?:[A-Za-z0-9_][A-Za-z0-9_.-]*[\\/])*[A-Za-z0-9_.-]+(?::\d+(?::\d+)?|\(\d+,\s*\d+\))?/g;
    const dirPathRegex = /(?:[A-Za-z0-9_][A-Za-z0-9_.-]*[\\/])+[A-Za-z0-9_.-]+(?::\d+(?::\d+)?|\(\d+,\s*\d+\))?/g;

    const matches = [];
    const matchedRanges = [];

    const isOverlapping = (start, end) => {
      for (const [eStart, eEnd] of matchedRanges) {
        if (!(end <= eStart || start >= eEnd)) return true;
      }
      return false;
    };

    const processMatches = (regex, options = {}) => {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const fullMatch = match[0];
        const matchStart = match.index;
        const matchEnd = matchStart + fullMatch.length;

        if (options.requireLeftBoundary && !hasLeftBoundary(text, matchStart)) {
          continue;
        }

        if (options.skipIfPrecededByPathSep) {
          const prev = matchStart > 0 ? text[matchStart - 1] : '';
          if (prev === '/' || prev === '\\') {
            continue;
          }
        }

        if (isOverlapping(matchStart, matchEnd)) {
          continue;
        }

        const unquotedMatch = stripOuterQuotes(fullMatch);
        const { pathOnly, lineNum, colNum } = parsePathLocation(unquotedMatch);

        // Skip if it looks like a URL we already handle elsewhere.
        if (/^https?:\/\//i.test(pathOnly)) continue;
        if (/^file:\/\//i.test(pathOnly)) continue;
        // Skip image files (handled separately)
        if (isImagePath(pathOnly)) continue;
        // Skip if path doesn't look valid
        if (!looksLikePath(pathOnly)) continue;

        matchedRanges.push([matchStart, matchEnd]);
        matches.push({
          startIndex: matchStart,
          endIndex: matchEnd,
          text: fullMatch,
          path: pathOnly,
          line: lineNum,
          column: colNum,
        });
      }
    };

    // Prefer absolute/quoted paths to avoid matching a substring inside a larger path token
    // (e.g. ".codex/log/file.log" matching as "codex/log/file.log").
    processMatches(quotedWinAbsoluteRegex);
    processMatches(quotedUnixAbsoluteRegex);
    processMatches(quotedDotPathRegex);
    processMatches(quotedDirPathRegex);
    if (isWin) {
      processMatches(winAbsoluteRegex);
    }
    processMatches(unixAbsoluteRegex);
    // Then relative paths (require a left boundary to avoid matching inside a larger token/path segment)
    processMatches(dotPrefixPathRegex, { requireLeftBoundary: true });
    processMatches(dirPathRegex, { requireLeftBoundary: true });

    return matches;
  };

  return {
    buildLineTextWithCellMap,
    normalizeFileUrl,
    findFileUrlMatches,
    findFilePathMatches,
  };
}));
