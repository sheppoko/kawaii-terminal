/* eslint-disable no-undef, no-unused-vars */
// Windows Script Host helper (cscript). No PowerShell dependency.

function cleanText(value, limit) {
  if (value === null || value === undefined) return '';
  var text = String(value).replace(/\s+/g, ' ').trim();
  text = text.replace(/[^A-Za-z0-9._:@/+=-]/g, '');
  if (limit && text.length > limit) {
    text = text.substring(0, limit);
  }
  return text;
}

function cleanPath(value, limit) {
  if (value === null || value === undefined) return '';
  var text = String(value).trim();
  if (limit && text.length > limit) {
    text = text.substring(0, limit);
  }
  return text;
}

function readStdin() {
  try {
    return WScript.StdIn.ReadAll();
  } catch (e) {
    return '';
  }
}

function getEnv(name) {
  try {
    return new ActiveXObject('WScript.Shell').Environment('PROCESS')(name);
  } catch (e) {
    return '';
  }
}

function extractSessionId(payload) {
  if (!payload || typeof payload !== 'object') return '';
  var keys = [
    'session_id',
    'sessionId',
    'session',
    'thread-id',
    'thread_id',
    'threadId',
    'conversation_id',
    'conversationId',
  ];
  for (var i = 0; i < keys.length; i += 1) {
    var key = keys[i];
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      var value = cleanText(payload[key], 200);
      if (value) return value;
    }
  }
  return '';
}

function ensureFolder(path) {
  if (!path) return;
  var fso = new ActiveXObject('Scripting.FileSystemObject');
  if (fso.FolderExists(path)) return;
  var parts = path.split('\\');
  var current = '';
  for (var i = 0; i < parts.length; i += 1) {
    var part = parts[i];
    if (!part) continue;
    current = current ? (current + '\\' + part) : part;
    if (!fso.FolderExists(current)) {
      try { fso.CreateFolder(current); } catch (e) { /* ignore */ }
    }
  }
}

function writeLine(path, line) {
  try {
    var fso = new ActiveXObject('Scripting.FileSystemObject');
    var folder = fso.GetParentFolderName(path);
    if (folder) ensureFolder(folder);
    var file = fso.OpenTextFile(path, 8, true, 0); // ForAppending, create, ASCII
    file.WriteLine(line);
    file.Close();
  } catch (e) {
    // ignore
  }
}

(function main() {
  var source = 'unknown';
  var event = 'completed';
  var hook = '';
  var args = WScript.Arguments;
  for (var i = 0; i < args.length; i += 1) {
    var arg = String(args.Item(i) || '');
    if (arg === '--source' && i + 1 < args.length) {
      source = String(args.Item(i + 1) || '');
      i += 1;
    } else if (arg === '--event' && i + 1 < args.length) {
      event = String(args.Item(i + 1) || '');
      i += 1;
    } else if (arg === '--hook' && i + 1 < args.length) {
      hook = String(args.Item(i + 1) || '');
      i += 1;
    }
  }

  var paneId = cleanText(getEnv('KAWAII_PANE_ID'), 200);
  var notifyPath = cleanPath(getEnv('KAWAII_NOTIFY_PATH'), 2000);
  var instanceId = cleanText(getEnv('KAWAII_TERMINAL_INSTANCE_ID'), 200);
  source = cleanText(source, 40) || 'unknown';
  event = cleanText(event, 40) || 'completed';
  hook = cleanText(hook, 40);

  if (!paneId || !notifyPath) return;

  var raw = readStdin();
  var payload = null;
  if (raw) {
    try { payload = JSON.parse(raw); } catch (e) { payload = null; }
  }

  var debugPath = cleanPath(getEnv('KAWAII_NOTIFY_DEBUG_PATH'), 2000);
  if (debugPath) {
    var debugTimestamp;
    try { debugTimestamp = new Date().toISOString(); } catch (e) { debugTimestamp = ''; }
    var rawLine = raw ? String(raw).replace(/\r?\n/g, '\\n').slice(0, 4000) : '';
    var debugEntry = '{"source":"' + source + '",' +
      '"event":"' + event + '",' +
      '"hook":"' + hook + '",' +
      '"pane_id":"' + paneId + '",' +
      '"raw":"' + cleanPath(rawLine, 4000) + '"' +
      ',"timestamp":"' + debugTimestamp + '"}';
    writeLine(debugPath, debugEntry);
  }

  var sessionId = extractSessionId(payload);
  if (!sessionId) return;

  if (event === 'auto' || event === 'notification') {
    var notifType = '';
    if (payload && typeof payload === 'object') {
      notifType = cleanText(payload.notification_type || payload.notificationType, 80);
    }
    if (notifType === 'permission_prompt') {
      event = 'waiting_user';
    } else if (notifType === 'elicitation_dialog') {
      event = 'waiting_user';
    } else {
      event = 'completed';
    }
  }

  var timestamp;
  try { timestamp = new Date().toISOString(); } catch (e) { timestamp = ''; }

  var entry = '{"source":"' + source + '",' +
    '"event":"' + event + '",' +
    '"session_id":"' + sessionId + '",' +
    '"pane_id":"' + paneId + '",' +
    '"timestamp":"' + timestamp + '"';
  if (instanceId) {
    entry += ',"instance_id":"' + instanceId + '"';
  }
  if (hook) {
    entry += ',"hook":"' + hook + '"';
  }
  entry += '}';

  writeLine(notifyPath, entry);
})();
