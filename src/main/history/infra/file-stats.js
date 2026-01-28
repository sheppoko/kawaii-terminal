function createFileStats() {
  return { fileCount: 0, latestMtime: 0, latestSize: 0 };
}

function updateFileStats(stats, file) {
  if (!file) return;
  const mtime = Number(file.mtime) || 0;
  const size = Number(file.size) || 0;
  stats.fileCount += 1;
  if (mtime > stats.latestMtime) {
    stats.latestMtime = mtime;
    stats.latestSize = size;
    return;
  }
  if (mtime === stats.latestMtime && size > stats.latestSize) {
    stats.latestSize = size;
  }
}

function aggregateFileStats(stats, files) {
  if (!Array.isArray(files)) return stats;
  for (const file of files) {
    updateFileStats(stats, file);
  }
  return stats;
}

function buildStatsSignature(stats) {
  return `${stats.fileCount || 0}:${stats.latestMtime || 0}:${stats.latestSize || 0}`;
}

module.exports = {
  aggregateFileStats,
  buildStatsSignature,
  createFileStats,
  updateFileStats,
};
