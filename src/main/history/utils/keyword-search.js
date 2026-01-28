function normalizeSearchTerms(query) {
  const raw = String(query || '').trim();
  if (!raw) return [];
  const terms = raw.split(/\s+/).map(item => item.trim()).filter(Boolean);
  return terms.slice(0, 20);
}

function computeKeywordMatchScore({ input, output, terms }) {
  const inputText = String(input || '');
  const outputText = String(output || '');
  const hayInput = inputText.toLowerCase();
  const hayOutput = outputText.toLowerCase();
  let points = 0;
  let matchedCount = 0;

  for (const term of terms) {
    const needle = String(term || '').toLowerCase();
    if (!needle) continue;
    const inInput = hayInput.includes(needle);
    const inOutput = hayOutput.includes(needle);
    if (!inInput && !inOutput) return { matched: false, score: 0, why: '' };
    matchedCount += 1;
    if (inInput) points += 2;
    if (inOutput) points += 1;
  }

  if (matchedCount === 0) return { matched: false, score: 0, why: '' };
  const denom = Math.max(1, terms.length * 3);
  const score = Math.min(1, points / denom);
  const why = terms.length > 0 ? `matched ${matchedCount}/${terms.length} term(s)` : 'matched';
  return { matched: true, score, why };
}

module.exports = {
  computeKeywordMatchScore,
  normalizeSearchTerms,
};
