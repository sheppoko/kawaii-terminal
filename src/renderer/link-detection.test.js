const test = require('node:test');
const assert = require('node:assert/strict');

const { buildLineTextWithCellMap, findFilePathMatches, findFileUrlMatches } = require('./link-detection.js');

test('findFilePathMatches: prefers absolute path over substring in dot directory', () => {
  const text = '/Users/example/.codex/log/codex-tui.log';
  const matches = findFilePathMatches(text, { isWin: false, isImagePath: () => false });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].text, text);
  assert.equal(matches[0].path, text);
});

test('findFilePathMatches: parses :line:column suffix', () => {
  const input = '/Users/example/src/app.ts:10:5';
  const matches = findFilePathMatches(input, { isWin: false, isImagePath: () => false });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, '/Users/example/src/app.ts');
  assert.equal(matches[0].line, 10);
  assert.equal(matches[0].column, 5);
});

test('findFilePathMatches: parses quoted unix path with spaces', () => {
  const input = 'Error at "/Users/example/My Folder/app.ts:2:3"';
  const matches = findFilePathMatches(input, { isWin: false, isImagePath: () => false });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].text, '"/Users/example/My Folder/app.ts:2:3"');
  assert.equal(matches[0].path, '/Users/example/My Folder/app.ts');
  assert.equal(matches[0].line, 2);
  assert.equal(matches[0].column, 3);
});

test('findFilePathMatches: allows absolute path without extension', () => {
  const input = '/Users/example/.claude/projects/-Volumes-SSD-Projects/523e1517-4af6-4ce5-8e13-6afb0ba8ca85';
  const matches = findFilePathMatches(input, { isWin: false, isImagePath: () => false });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, input);
});

test('findFilePathMatches: allows relative path without extension', () => {
  const input = 'See logs at ./tmp/output/logs';
  const matches = findFilePathMatches(input, { isWin: false, isImagePath: () => false });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, './tmp/output/logs');
});

test('findFilePathMatches: matches backtick wrapped path', () => {
  const input = 'See `./src/renderer/terminal.js`';
  const matches = findFilePathMatches(input, { isWin: false, isImagePath: () => false });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, './src/renderer/terminal.js');
});

test('findFilePathMatches: matches pipe-delimited path', () => {
  const input = '|/Users/example/src/app.ts|';
  const matches = findFilePathMatches(input, { isWin: false, isImagePath: () => false });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, '/Users/example/src/app.ts');
});

test('findFilePathMatches: matches trailing slash directory', () => {
  const input = '/Users/example/src/';
  const matches = findFilePathMatches(input, { isWin: false, isImagePath: () => false });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, '/Users/example/src/');
});

test('findFileUrlMatches: resolves unix file url', () => {
  const input = 'file:///Users/example/src/app.ts';
  const matches = findFileUrlMatches(input, { isWin: false });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, '/Users/example/src/app.ts');
});

test('buildLineTextWithCellMap: wide char keeps correct cell x mapping', () => {
  const cells = [
    { chars: 'あ', width: 2 },
    { chars: '', width: 0 },
    { chars: '/', width: 1 },
    { chars: 'U', width: 1 },
    { chars: 's', width: 1 },
    { chars: 'e', width: 1 },
    { chars: 'r', width: 1 },
    { chars: 's', width: 1 },
  ];

  const bufferLine = {
    length: cells.length,
    getCell: (x) => {
      const cell = cells[x];
      if (!cell) return null;
      return {
        getChars: () => cell.chars,
        getWidth: () => cell.width,
      };
    },
  };

  const { text, indexToX, indexToWidth } = buildLineTextWithCellMap(bufferLine, 80);
  assert.equal(text, 'あ/Users');
  assert.equal(indexToX[0], 1);
  assert.equal(indexToWidth[0], 2);
  // '/' should start at cell 3 because 'あ' occupies 2 cells.
  assert.equal(indexToX[1], 3);
});
