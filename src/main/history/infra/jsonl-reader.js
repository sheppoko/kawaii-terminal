const fs = require('fs');
const path = require('path');
const readline = require('readline');

const FILE_STAT_CONCURRENCY = 16;
const DIR_SCAN_CONCURRENCY = 4;

async function mapWithConcurrency(items, limit, task) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];
  const max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  const results = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(max, list.length) }, () => (async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) break;
      try {
        results[index] = await task(list[index], index);
      } catch (_) {
        results[index] = null;
      }
    }
  })());
  await Promise.all(workers);
  return results;
}

async function readJsonlFile(filePath, onEntry) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };

    let stream;
    try {
      stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    } catch (_) {
      finish();
      return;
    }

    stream.on('error', () => finish());

    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      if (!line) return;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (_) {
        return;
      }
      try {
        onEntry(entry);
      } catch (_) {
        // ignore callback errors
      }
    });

    rl.on('close', () => finish());
  });
}

async function listJsonlFiles(dirPath) {
  try {
    const entries = await fs.promises.readdir(dirPath);
    const candidates = entries
      .filter(name => name.endsWith('.jsonl'))
      .map(name => path.join(dirPath, name));
    const stats = await mapWithConcurrency(candidates, FILE_STAT_CONCURRENCY, async (fullPath) => {
      try {
        const stat = await fs.promises.stat(fullPath);
        if (!stat.isFile()) return null;
        return { path: fullPath, mtime: stat.mtimeMs || 0, size: stat.size || 0 };
      } catch (_) {
        return null;
      }
    });
    const files = stats.filter(Boolean);
    files.sort((a, b) => b.mtime - a.mtime);
    return files;
  } catch (_) {
    return [];
  }
}

async function listJsonlFilesRecursive(dirPath, depth = 6) {
  const files = [];
  if (!dirPath || depth < 0) return files;
  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (_) {
    return files;
  }
  const subdirs = [];
  const candidates = [];
  for (const entry of entries) {
    if (!entry) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory?.()) {
      subdirs.push(fullPath);
      continue;
    }
    if (!entry.isFile?.() || !entry.name.endsWith('.jsonl')) continue;
    candidates.push(fullPath);
  }

  const stats = await mapWithConcurrency(candidates, FILE_STAT_CONCURRENCY, async (fullPath) => {
    try {
      const stat = await fs.promises.stat(fullPath);
      return { path: fullPath, mtime: stat.mtimeMs || 0, size: stat.size || 0 };
    } catch (_) {
      return null;
    }
  });
  for (const file of stats) {
    if (!file) continue;
    files.push(file);
  }

  const nestedLists = await mapWithConcurrency(subdirs, DIR_SCAN_CONCURRENCY, async (subdir) => {
    return listJsonlFilesRecursive(subdir, depth - 1);
  });
  for (const nested of nestedLists) {
    if (!nested) continue;
    files.push(...nested);
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

async function readJsonlTail(filePath, maxBytes, fallbackBytes) {
  try {
    const stat = await fs.promises.stat(filePath);
    const size = stat.size || 0;
    if (!size) return [];
    const bytes = Math.max(1024, Number(maxBytes) || Number(fallbackBytes) || 1024);
    const start = Math.max(0, size - bytes);
    const length = size - start;
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      let text = buffer.toString('utf8');
      if (start > 0) {
        const idx = text.indexOf('\n');
        if (idx >= 0) {
          text = text.slice(idx + 1);
        } else {
          return [];
        }
      }
      const lines = text.split(/\n+/).filter(Boolean);
      const events = [];
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch (_) {
          // ignore
        }
      }
      return events;
    } finally {
      await handle.close();
    }
  } catch (_) {
    return [];
  }
}

async function readJsonlHead(filePath, maxBytes, fallbackBytes) {
  try {
    const stat = await fs.promises.stat(filePath);
    const size = stat.size || 0;
    if (!size) return [];
    const bytes = Math.max(1024, Number(maxBytes) || Number(fallbackBytes) || 1024);
    const length = Math.min(size, bytes);
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      const text = buffer.toString('utf8');
      const lines = text.split(/\n+/).filter(Boolean);
      const events = [];
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch (_) {
          // ignore
        }
      }
      return events;
    } finally {
      await handle.close();
    }
  } catch (_) {
    return [];
  }
}

module.exports = {
  listJsonlFiles,
  listJsonlFilesRecursive,
  readJsonlFile,
  readJsonlHead,
  readJsonlTail,
};
