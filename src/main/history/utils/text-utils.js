function extractTextFromContent(content) {
  if (content == null) return '';
  if (typeof content === 'string' || typeof content === 'number' || typeof content === 'boolean') {
    return String(content);
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      const text = extractTextFromContent(item);
      if (text) parts.push(text);
    }
    return parts.join('\n').trim();
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content !== 'undefined') return extractTextFromContent(content.content);
    if (typeof content.message !== 'undefined') return extractTextFromContent(content.message);
    if (typeof content.input !== 'undefined') return extractTextFromContent(content.input);
    if (typeof content.output !== 'undefined') return extractTextFromContent(content.output);
  }
  return '';
}

function normalizeRole(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'user' || raw === 'input' || raw === 'client' || raw === 'human') return 'user';
  if (raw === 'assistant' || raw === 'output' || raw === 'ai' || raw === 'bot') return 'assistant';
  return raw;
}

module.exports = {
  extractTextFromContent,
  normalizeRole,
};
