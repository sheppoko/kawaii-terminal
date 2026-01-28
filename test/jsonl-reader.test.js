const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  listJsonlFiles,
  listJsonlFilesRecursive,
  readJsonlHead,
  readJsonlTail,
} = require('../src/main/history/infra/jsonl-reader');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kawaii-jsonl-'));
}

test('readJsonlHead and readJsonlTail parse JSON lines', async () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, 'sample.jsonl');
  const lines = [
    JSON.stringify({ a: 1 }),
    JSON.stringify({ b: 2 }),
    JSON.stringify({ c: 3 }),
  ].join('\n') + '\n';
  fs.writeFileSync(filePath, lines, 'utf8');

  const head = await readJsonlHead(filePath, 4096);
  const tail = await readJsonlTail(filePath, 4096);

  assert.equal(head.length, 3);
  assert.equal(tail.length, 3);
  assert.deepEqual(head[0], { a: 1 });
  assert.deepEqual(tail[2], { c: 3 });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('listJsonlFiles returns only jsonl files', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'a.jsonl'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'nope', 'utf8');

  const files = await listJsonlFiles(dir);
  const names = files.map(file => path.basename(file.path)).sort();

  assert.deepEqual(names, ['a.jsonl']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listJsonlFilesRecursive scans nested directories', async () => {
  const dir = makeTempDir();
  const nested = path.join(dir, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'nested.jsonl'), '{}\n', 'utf8');

  const files = await listJsonlFilesRecursive(dir, 3);
  const names = files.map(file => path.basename(file.path)).sort();

  assert.deepEqual(names, ['nested.jsonl']);
  fs.rmSync(dir, { recursive: true, force: true });
});
