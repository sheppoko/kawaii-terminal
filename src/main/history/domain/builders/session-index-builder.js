class SessionIndexBuilder {
  constructor({ concurrency = 4 } = {}) {
    this.concurrency = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 4;
  }

  async buildSummaries(entries, { start = 0, target = 1, buildFn } = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const blocks = [];
    const max = Number.isFinite(target) ? Math.max(1, Math.floor(target)) : 1;
    const parallel = this.concurrency;
    let cursor = Number.isFinite(start) ? Math.max(0, Math.floor(start)) : 0;

    while (cursor < list.length && blocks.length < max) {
      const batchSize = Math.min(list.length - cursor, parallel);
      const slice = list.slice(cursor, cursor + batchSize);
      const results = await Promise.all(slice.map(async (entry) => {
        try {
          return await buildFn(entry);
        } catch (_) {
          return null;
        }
      }));
      cursor += slice.length;
      for (const block of results) {
        if (!block) continue;
        blocks.push(block);
        if (blocks.length >= max) break;
      }
    }

    return { blocks, nextCursor: cursor };
  }
}

function blockHasInput(block) {
  if (!block) return false;
  const direct = String(block.input || '').trim();
  if (direct) return true;
  if (Array.isArray(block.inputs)) {
    return block.inputs.some((item) => String(item || '').trim());
  }
  return false;
}

function selectLatestBlockWithInput(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (blockHasInput(block)) return block;
  }
  return blocks[blocks.length - 1] || null;
}

module.exports = {
  SessionIndexBuilder,
  blockHasInput,
  selectLatestBlockWithInput,
};
