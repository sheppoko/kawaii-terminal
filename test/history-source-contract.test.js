const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kawaii-home-'));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const { createDefaultSources } = require('../src/main/history/domain/sources');

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
  fs.rmSync(tempHome, { recursive: true, force: true });
});

const writeJsonl = (filePath, entries) => {
  const lines = entries.map((entry) => JSON.stringify(entry));
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

test('history source contract: required methods exist', () => {
  const sources = createDefaultSources();
  for (const source of sources.values()) {
    assert.equal(typeof source.listSessions, 'function');
    assert.equal(typeof source.loadSession, 'function');
    assert.equal(typeof source.createTimeMachine, 'function');
    assert.equal(typeof source.listSearchEntries, 'function');
    assert.equal(typeof source.scanSearchEntry, 'function');
  }
});

test('history source contract: createTimeMachine handles missing block', async () => {
  const sources = createDefaultSources();
  for (const source of sources.values()) {
    const result = await source.createTimeMachine({});
    assert.equal(result.success, false);
    assert.ok(result.error);
  }
});

test('history source contract: loadSession returns blocks array', async () => {
  const prevCodexHome = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kawaii-codex-contract-'));
  const sessionsDir = path.join(codexHome, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  process.env.CODEX_HOME = codexHome;

  const claudeProjectRoot = path.join(tempHome, '.claude', 'projects', `kawaii-contract-${Date.now()}`);
  fs.mkdirSync(claudeProjectRoot, { recursive: true });

  try {
    const sources = createDefaultSources();
    const claude = sources.get('claude');
    const codex = sources.get('codex');

    const claudeSessionId = 'session-contract-claude';
    const claudeFile = path.join(claudeProjectRoot, `${claudeSessionId}.jsonl`);
    writeJsonl(claudeFile, [
      { role: 'user', uuid: 'u1', sessionId: claudeSessionId, content: 'hello' },
      { role: 'assistant', sessionId: claudeSessionId, content: 'world' },
    ]);

    const codexSessionId = 'c6547424-675d-4487-a7f4-d84e7b4f8d70';
    const codexFile = path.join(sessionsDir, `rollout-2026-01-01T00-00-00-${codexSessionId}.jsonl`);
    const ts = 1710000000000;
    writeJsonl(codexFile, [
      { type: 'session_meta', payload: { id: codexSessionId } },
      buildCodexMessage('user', 'ping', ts),
      buildCodexMessage('assistant', 'pong', ts + 1000),
    ]);

    const claudeResult = await claude.loadSession({
      sessionId: claudeSessionId,
      project_dir: claudeProjectRoot,
      load_all: true,
    });
    assert.ok(Array.isArray(claudeResult.blocks));
    assert.ok(claudeResult.blocks.length >= 1);

    const codexResult = await codex.loadSession({
      sessionId: codexSessionId,
      source_path: codexFile,
      load_all: true,
    });
    assert.ok(Array.isArray(codexResult.blocks));
    assert.ok(codexResult.blocks.length >= 1);
  } finally {
    if (prevCodexHome == null) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = prevCodexHome;
    }
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(claudeProjectRoot, { recursive: true, force: true });
  }
});
