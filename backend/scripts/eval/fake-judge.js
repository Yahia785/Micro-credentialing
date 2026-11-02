/**
 * A deterministic stand-in for the judge model, used with --fake-model so the judge path can be
 * tested and run without AWS. It reads the same message the real judge gets (which has no student
 * answer) and answers from word overlap: the gap whose text shares the most words with the follow-up is
 * the target ("none" when none share any), a gap sharing four or more words is "revealed", two question
 * marks (or two questions joined by "and") make it two-part, and sharing no word with the criteria or gaps
 * makes it beyond scope. A seeded share of calls misbehave (unreadable reply once) to exercise that path.
 * Same seed and input always give the same result.
 */
const crypto = require('crypto');
const { isMultiPart } = require('./metrics');

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'is', 'it', 'and', 'or', 'that', 'this', 'for', 'on', 'what', 'how', 'does', 'not', 'say', 'says', 'why', 'would', 'with', 'are', 'be', 'as', 'at', 'by', 'if', 'when', 'student', 'explains', 'explain', 'about']);
const tokens = (text) => String(text).toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
const REVEAL_WORDS = 4;

/** Reads the judge message back into its parts. */
function readJudgeMessage(text) {
  const followUp = (/<follow_up>\n([\s\S]*?)\n<\/follow_up>/.exec(text) || [])[1] || '';
  const criteria = [];
  const gaps = [];
  let section = '';
  for (const line of text.split('\n')) {
    if (line === 'Criteria:') section = 'criteria';
    else if (line === 'Gaps:') section = 'gaps';
    else if (line.startsWith('<follow_up>')) break;
    else if (section === 'criteria' && line.startsWith('- ')) criteria.push(line.slice(2));
    else if (section === 'gaps') {
      const m = /^- ([^:\n]+): (.*)$/.exec(line);
      if (m) gaps.push({ id: m[1], text: m[2] });
    }
  }
  return { followUp, criteria, gaps };
}

const SHOWN_WORDS = 3; // a rubric item counts as shown when the answer shares this many words with it

/** The rubric-check message (judge-rubric.js) starts with the question and has a rubric list. */
const isRubricMessage = (text) => text.startsWith('Question: ') && text.split('\n').includes('Rubric:');

/** Reads the rubric-check message back into its parts. */
function readRubricMessage(text) {
  const lines = text.split('\n');
  const rubric = [];
  let i = lines.indexOf('Rubric:') + 1;
  for (; i < lines.length && lines[i].startsWith('- '); i += 1) {
    const m = /^- ([^:]+): (.*)$/.exec(lines[i]);
    if (m) rubric.push({ id: m[1], text: m[2] });
  }
  const open = lines.indexOf('<student_answer>');
  const close = lines.lastIndexOf('</student_answer>');
  const answer = open !== -1 && close > open ? lines.slice(open + 1, close).join('\n') : '';
  return { rubric, answer };
}

/** An item is "missing" when the answer shares fewer than three words with it. Same seed and input, same result. */
function rubricReply(text, hash, attempt, chaos) {
  const { rubric, answer } = readRubricMessage(text);
  const words = new Set(tokens(answer));
  const missing = rubric.filter((item) => tokens(item.text).filter((w) => words.has(w)).length < SHOWN_WORDS).map((item) => item.id);
  const usage = { inputTokens: 300 + (hash % 200), outputTokens: 20 + (hash % 20), latencyMs: 300 + (hash % 300) };
  if ((hash % 1000) / 1000 < chaos && attempt === 0) return { ...usage, text: 'The answer looks fine to me.' };
  return {
    ...usage,
    text: JSON.stringify({ missing, reason: missing.length ? `The answer does not show ${missing.join(', ')}.` : 'Every rubric item is shown.' }),
  };
}

function createFakeJudge({ seed = 1, chaos = 0 } = {}) {
  const seen = new Map();

  return async function fakeJudgeConverse(request) {
    const text = request.messages[0].content[0].text;
    const hash = crypto.createHash('sha256').update(`${seed}|${text}`).digest().readUInt32BE(0);
    const attempt = seen.get(hash) || 0;
    seen.set(hash, attempt + 1);

    if (isRubricMessage(text)) return rubricReply(text, hash, attempt, chaos);

    const { followUp, criteria, gaps } = readJudgeMessage(text);
    const words = new Set(tokens(followUp));
    const overlap = (source) => tokens(source).filter((w) => words.has(w)).length;
    let best = null;
    let bestScore = 0;
    for (const gap of gaps) {
      const score = overlap(gap.text);
      if (score > bestScore) { best = gap; bestScore = score; }
    }
    const reveals = gaps.filter((gap) => overlap(gap.text) >= REVEAL_WORDS).map((gap) => gap.id);
    const inScope = [...criteria, ...gaps.map((gap) => gap.text)].some((source) => overlap(source) > 0);
    const usage = { inputTokens: 400 + (hash % 200), outputTokens: 40 + (hash % 20), latencyMs: 300 + (hash % 300) };

    if ((hash % 1000) / 1000 < chaos && attempt === 0) return { ...usage, text: 'I think it is the first one.' };
    return {
      ...usage,
      text: JSON.stringify({
        targets: best ? [best.id] : ['none'],
        reveals,
        two_part: isMultiPart(followUp),
        beyond_scope: !inScope,
        reason: best ? `The question asks about: ${best.text}` : 'The question does not match a listed gap.',
      }),
    };
  };
}

module.exports = { createFakeJudge, readJudgeMessage, readRubricMessage };
