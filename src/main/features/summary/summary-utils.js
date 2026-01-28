const crypto = require('crypto');

const DEFAULT_LANGUAGE = 'ja';
const MAX_TURNS = 2;
const MAX_MESSAGE_BYTES = 1024;
const PROMPT_VERSION = 2;

function normalizeText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function sliceHeadByBytes(text, maxBytes) {
  if (!text) return '';
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    const ch = String.fromCodePoint(codePoint);
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (bytes + chBytes > maxBytes) break;
    bytes += chBytes;
    index += ch.length;
  }
  return text.slice(0, index);
}

function sliceTailByBytes(text, maxBytes) {
  if (!text) return '';
  let bytes = 0;
  let index = text.length;
  while (index > 0) {
    let prev = index - 1;
    const code = text.charCodeAt(prev);
    if (code >= 0xDC00 && code <= 0xDFFF && prev - 1 >= 0) {
      const lead = text.charCodeAt(prev - 1);
      if (lead >= 0xD800 && lead <= 0xDBFF) {
        prev -= 1;
      }
    }
    const ch = text.slice(prev, index);
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (bytes + chBytes > maxBytes) break;
    bytes += chBytes;
    index = prev;
  }
  return text.slice(index);
}

function truncateMiddleByBytes(text, maxBytes) {
  const raw = normalizeText(text);
  if (!raw) return '';
  const totalBytes = Buffer.byteLength(raw, 'utf8');
  if (totalBytes <= maxBytes) return raw;
  const marker = '...';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const remaining = Math.max(0, maxBytes - markerBytes);
  const headBytes = Math.floor(remaining / 2);
  const tailBytes = remaining - headBytes;
  const head = sliceHeadByBytes(raw, headBytes);
  const tail = sliceTailByBytes(raw, tailBytes);
  return `${head}${marker}${tail}`.trim();
}

function extractInput(block) {
  if (!block) return '';
  if (Array.isArray(block.inputs) && block.inputs.length > 0) {
    return block.inputs.map((item) => String(item || '')).join('\n');
  }
  return String(block.input || '');
}

function extractOutput(block) {
  if (!block) return '';
  return String(block.output_text || block.output_head || block.output_tail || '');
}

function pickRecentPairs(blocks) {
  if (!Array.isArray(blocks)) return [];
  const sorted = blocks.slice().sort((a, b) => {
    const aTs = Number(a?.last_output_at || a?.created_at || 0) || 0;
    const bTs = Number(b?.last_output_at || b?.created_at || 0) || 0;
    return bTs - aTs;
  });
  const pairs = [];
  for (const block of sorted) {
    const input = normalizeText(extractInput(block));
    const output = normalizeText(extractOutput(block));
    if (!input || !output) continue;
    pairs.push({
      input: truncateMiddleByBytes(input, MAX_MESSAGE_BYTES),
      output: truncateMiddleByBytes(output, MAX_MESSAGE_BYTES),
    });
    if (pairs.length >= MAX_TURNS) break;
  }
  return pairs.reverse();
}

function buildPrompt(pairs, language) {
  const isJa = language !== 'en';
  const lines = [];
  if (isJa) {
    lines.push('以下は直近最大2往復のユーザー/アシスタントのやり取り（各メッセージは最大1KBで中間省略済み）です。');
    lines.push('やり取りから、何をしていたかをユーザ目線で説明（主語は一切不要、ユーザが～～など不要。認知負荷最低を意識）。90字以内。アシスタントの行動は書かない。');
    lines.push('');
    lines.push('出力ルール:');
    lines.push('- 推測や新情報の追加は禁止');
    lines.push('- 前置き/番号/タイトル/引用は不要');
  } else {
    lines.push('Below are up to 2 recent user/assistant turns (each message is <= 1KB, middle truncated).');
    lines.push('Describe what was being done from the user perspective (no subject; minimize cognitive load). Keep it as short as possible (200 English characters max). Do not describe the assistant.');
    lines.push('');
    lines.push('Rules:');
    lines.push('- No speculation or new info');
    lines.push('- No preface, titles, or quotes');
  }
  lines.push('');
  lines.push('Input:');
  pairs.forEach((pair, idx) => {
    lines.push(`[Turn ${idx + 1}]`);
    lines.push(`User: ${pair.input}`);
    lines.push(`Assistant: ${pair.output}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}

function normalizeSummaryText(text) {
  const raw = normalizeText(text);
  if (!raw) return '';
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(0, 3).join('\n').trim();
}

function hashPayload(payload) {
  const json = JSON.stringify(payload);
  return crypto.createHash('sha256').update(json).digest('hex');
}

function buildCacheKey({ sessionKey, hash, model, language, provider }) {
  const safeProvider = String(provider || '').trim() || 'summary';
  return `${safeProvider}|${sessionKey}|${hash}|${model}|${language}|v${PROMPT_VERSION}`;
}

module.exports = {
  DEFAULT_LANGUAGE,
  MAX_TURNS,
  MAX_MESSAGE_BYTES,
  PROMPT_VERSION,
  buildCacheKey,
  buildPrompt,
  hashPayload,
  normalizeSummaryText,
  pickRecentPairs,
};
