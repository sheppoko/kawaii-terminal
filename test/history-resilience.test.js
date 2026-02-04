const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalCodexHome = process.env.CODEX_HOME;
const originalDisableWslScan = process.env.KAWAII_DISABLE_WSL_SCAN;
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kawaii-home-'));
const tempCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kawaii-codex-'));

process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.CODEX_HOME = tempCodexHome;
process.env.KAWAII_DISABLE_WSL_SCAN = '1';

const { createDefaultSources } = require('../src/main/history/domain/sources');
const HistoryRepository = require('../src/main/history/domain/repository');

const writeLines = (filePath, lines) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
};

const buildCodexMessage = (role, text, ts) => ({
  type: 'response_item',
  timestamp: ts,
  payload: {
    type: 'message',
    role,
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
  },
});

test.after(() => {
  if (originalHome == null) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile == null) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
  if (originalCodexHome == null) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }
  if (originalDisableWslScan == null) {
    delete process.env.KAWAII_DISABLE_WSL_SCAN;
  } else {
    process.env.KAWAII_DISABLE_WSL_SCAN = originalDisableWslScan;
  }
  fs.rmSync(tempHome, { recursive: true, force: true });
  fs.rmSync(tempCodexHome, { recursive: true, force: true });
});

test('history resilience: empty sources yield no sessions', async () => {
  const sources = createDefaultSources();
  const repo = new HistoryRepository({ connectors: sources, useMetaForCache: false });
  const result = await repo.listSessions({ source: 'all', limit: 50 });
  assert.ok(Array.isArray(result.sessions));
  assert.equal(result.sessions.length, 0);
});

test('history resilience: claude loadSession handles missing files', async () => {
  const sources = createDefaultSources();
  const claude = sources.get('claude');
  const projectDir = path.join(tempHome, '.claude', 'projects', `kawaii-missing-${Date.now()}`);
  fs.mkdirSync(projectDir, { recursive: true });

  const result = await claude.loadSession({ sessionId: 'missing-claude', project_dir: projectDir });
  assert.ok(Array.isArray(result.blocks));
  assert.equal(result.blocks.length, 0);
  assert.match(String(result.error || ''), /not found/i);
});

test('history resilience: codex loadSession handles missing files', async () => {
  const sources = createDefaultSources();
  const codex = sources.get('codex');

  const result = await codex.loadSession({ sessionId: 'missing-codex' });
  assert.ok(Array.isArray(result.blocks));
  assert.equal(result.blocks.length, 0);
  assert.match(String(result.error || ''), /not found/i);
});

test('history resilience: claude ignores corrupted jsonl lines', async () => {
  const sources = createDefaultSources();
  const claude = sources.get('claude');
  const sessionId = `session-corrupt-claude-${Date.now()}`;
  const projectDir = path.join(tempHome, '.claude', 'projects', `kawaii-corrupt-${Date.now()}`);
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);

  writeLines(filePath, [
    '{not json',
    JSON.stringify({ role: 'user', uuid: 'u1', sessionId, content: 'ping', timestamp: '2025-01-01T00:00:00Z' }),
    '}{',
    JSON.stringify({ role: 'assistant', sessionId, content: 'pong', timestamp: '2025-01-01T00:00:01Z' }),
  ]);

  const result = await claude.loadSession({ sessionId, project_dir: projectDir, load_all: true });
  assert.ok(Array.isArray(result.blocks));
  assert.ok(result.blocks.length >= 1);
});

test('history resilience: codex ignores corrupted jsonl lines', async () => {
  const sources = createDefaultSources();
  const codex = sources.get('codex');
  const sessionId = 'c6547424-675d-4487-a7f4-d84e7b4f8d70';
  const sessionsDir = path.join(tempCodexHome, 'sessions');
  const filePath = path.join(sessionsDir, `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`);
  const ts = 1710000000000;

  writeLines(filePath, [
    '{oops',
    JSON.stringify({ type: 'session_meta', payload: { id: sessionId } }),
    JSON.stringify(buildCodexMessage('user', 'ping', ts)),
    'not json',
    JSON.stringify(buildCodexMessage('assistant', 'pong', ts + 1000)),
  ]);

  const result = await codex.loadSession({ sessionId, source_path: filePath, load_all: true });
  assert.ok(Array.isArray(result.blocks));
  assert.ok(result.blocks.length >= 1);
});
