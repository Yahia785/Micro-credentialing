/**
 * A deterministic stand-in for the judge model, used with --fake-model so the judge path can be
 * tested and run without AWS. It reads the same message the real judge gets and picks the gap whose
 * text shares the most words with the follow-up ("other" when none share any). A seeded share of
 * calls misbehave (unreadable reply once, or "none") to exercise those paths. Same seed and input
 * always give the same result.
 */
const crypto = require('crypto');

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'is', 'it', 'and', 'or', 'that', 'this', 'for', 'on', 'what', 'how', 'does', 'not', 'say', 'says', 'why', 'would', 'with', 'are', 'be', 'as', 'at', 'by', 'if', 'when']);
const tokens = (text) => String(text).toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));

function readJudgeMessage(text) {
  const followUp = (/<follow_up>\n([\s\S]*?)\n<\/follow_up>/.exec(text) || [])[1] || '';
  const gaps = [...text.matchAll(/^- ([^:\n]+): (.*)$/gm)].map((m) => ({ id: m[1], text: m[2] }));
  return { followUp, gaps };
}

function createFakeJudge({ seed = 1, chaos = 0 } = {}) {
  const seen = new Map();

  return async function fakeJudgeConverse(request) {
    const text = request.messages[0].content[0].text;
    const hash = crypto.createHash('sha256').update(`${seed}|${text}`).digest().readUInt32BE(0);
    const attempt = seen.get(hash) || 0;
    seen.set(hash, attempt + 1);

    const { followUp, gaps } = readJudgeMessage(text);
    const words = new Set(tokens(followUp));
    let best = null;
    let bestScore = 0;
    for (const gap of gaps) {
      const score = tokens(gap.text).filter((w) => words.has(w)).length;
      if (score > bestScore) { best = gap; bestScore = score; }
    }
    const usage = { inputTokens: 500 + (hash % 200), outputTokens: 30 + (hash % 20), latencyMs: 300 + (hash % 300) };

    if ((hash % 1000) / 1000 < chaos && attempt === 0) return { ...usage, text: 'I think it is the first one.' };
    const target = best ? best.id : 'other';
    return { ...usage, text: JSON.stringify({ target, reason: best ? `The question asks about: ${best.text}` : 'The question does not match a listed gap.' }) };
  };
}

module.exports = { createFakeJudge, readJudgeMessage };
