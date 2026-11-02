/**
 * A deterministic stand-in for Bedrock, so the evaluation runner can be tested without AWS.
 *
 * It reads the same message the real model gets (the allowed actions and the student's latest
 * answer) and answers with valid JSON: a follow-up for short or "I don't know" answers when one is
 * allowed, otherwise the next main question (or end). A seeded share of calls misbehave on purpose
 * so every metric path is exercised: transient and persistent throttling, other unavailability,
 * unusable output, a disallowed action, and a reason that contradicts the action.
 *
 * For host.v4 (the message has a rubric block) it also answers the new fields: "missing" (the rubric
 * items that share fewer than three words with the answer), "target" (the first missing one) and "isHint".
 * Some of its follow-ups ask two questions, so the engine's two-question guard has something to fix; when the
 * guard asks for a rewrite (a conversation of three messages) it answers with one question, or, for a
 * seeded share, with two again.
 *
 * Same seed and same input always give the same result.
 */
const crypto = require('crypto');
const { ModelUnavailableError } = require('../../shared/nodejs/agent/bedrock-client');

const FOLLOW_UP_QUESTIONS = [
  'Walk me through that part of your code again. What happens at each step?',
  'Can you explain that in more detail?',
  'What happens first, and what happens after that?',
  'Why is it written that way? What would change otherwise?',
];

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'is', 'it', 'and', 'or', 'that', 'this', 'for', 'on', 'what', 'how', 'does', 'not', 'says', 'say', 'why', 'would', 'with', 'are', 'be', 'as', 'at', 'by', 'if', 'when', 'student', 'explains', 'explain', 'about', 'i', 'you', 'so', 'then']);
const tokens = (text) => String(text).toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
const SHOWN_WORDS = 3; // a rubric item counts as shown when the answer shares this many words with it

function hashOf(text, seed) {
  return crypto.createHash('sha256').update(`${seed}|${text}`).digest().readUInt32BE(0);
}

/** The rubric block of a host.v4 message, as [{ id, text }] (empty for the other prompt versions). */
function readRubric(text) {
  const lines = String(text).split('\n');
  const at = lines.findIndex((line) => line.startsWith('Rubric for this main question'));
  if (at === -1) return [];
  const items = [];
  for (let i = at + 1; i < lines.length && lines[i].startsWith('- '); i += 1) {
    const m = /^- ([^:]+): (.*)$/.exec(lines[i]);
    if (m) items.push({ id: m[1], text: m[2] });
  }
  return items;
}

function readMessage(text) {
  const allowedLine = /Allowed actions now: (.*)/.exec(text);
  const allowed = allowedLine ? allowedLine[1].split(',').map((a) => a.trim()) : ['next_main'];
  const answers = [...text.matchAll(/<student_answer>\n([\s\S]*?)\n<\/student_answer>/g)];
  const last = answers.length ? answers[answers.length - 1][1] : '';
  return { allowed, last };
}

function isWeak(answer) {
  const words = answer.trim().split(/\s+/).filter(Boolean).length;
  return words < 6 || /don't know|not sure|no idea/i.test(answer);
}

function reply(action, question, reason, hash, extra) {
  const text = JSON.stringify({ ...extra, action, question, reason });
  return {
    text,
    inputTokens: 900 + (hash % 400),
    outputTokens: 40 + (hash % 30),
    latencyMs: 200 + (hash % 300),
  };
}

/**
 * @param {{ seed?: number|string, chaos?: number }} options chaos is the share of calls (0 to 1)
 *   that misbehave. Default 0.26.
 * @returns {(request: object) => Promise<object>} same shape as bedrock-client's converse
 */
function createFakeModel({ seed = 1, chaos = 0.26 } = {}) {
  const attempts = new Map();

  return async function fakeConverse(request) {
    const text = request.messages[0].content[0].text;
    const rewrite = request.messages.length > 1; // the two-question guard asking for one question
    const hash = hashOf(rewrite ? `${text}|rewrite` : text, seed);
    const attempt = attempts.get(hash) || 0;
    attempts.set(hash, attempt + 1);

    const { allowed, last } = readMessage(text);
    const rubric = readRubric(text);
    const canFollowUp = allowed.includes('follow_up');
    const closing = allowed.includes('end') ? 'end' : 'next_main';
    const followUp = FOLLOW_UP_QUESTIONS[(hash >>> 8) % FOLLOW_UP_QUESTIONS.length];
    const noneMissing = rubric.length ? { missing: [], target: '', isHint: false } : undefined;
    const firstOnly = rubric.length ? { missing: [rubric[0].id], target: rubric[0].id, isHint: false } : undefined;

    let normal;
    let asksFollowUp;
    if (rubric.length) {
      // host.v4: check the answer against each rubric item first (word overlap), then aim at the first missing one.
      const words = new Set(tokens(last));
      const missing = rubric.filter((item) => tokens(item.text).filter((w) => words.has(w)).length < SHOWN_WORDS).map((item) => item.id);
      asksFollowUp = canFollowUp && missing.length > 0;
      if (asksFollowUp) {
        const item = rubric.find((r) => r.id === missing[0]);
        const single = `Walk me through this part again: ${tokens(item.text).slice(0, 3).join(' ')}?`;
        let question = single;
        if (!rewrite && (hash >>> 4) % 4 === 0) question = `${single} How does that work?`;
        if (rewrite && (hash >>> 4) % 3 === 0) question = `${single} And why?`;
        normal = reply('follow_up', question, `${missing[0]} is not shown in the answer.`, hash,
          { missing, target: missing[0], isHint: /don't know|not sure|no idea/i.test(last) });
      } else {
        normal = reply(closing, '', 'The answer is sufficient for this question.', hash, { missing, target: '', isHint: false });
      }
    } else {
      asksFollowUp = canFollowUp && isWeak(last);
      normal = asksFollowUp
        ? reply('follow_up', rewrite ? 'What happens at each step?' : followUp, 'The answer is short, so one follow-up is asked.', hash)
        : reply(closing, '', 'The answer is sufficient for this question.', hash);
    }

    const chaotic = !rewrite && (hash % 1000) / 1000 < chaos;
    if (!chaotic) return normal;

    switch ((hash >>> 12) % 7) {
      case 0: // throttled once, fine on the retry
        if (attempt === 0) throw new ModelUnavailableError('ThrottlingException');
        return normal;
      case 1: // throttled every time
        throw new ModelUnavailableError('ThrottlingException');
      case 2: // another service failure
        throw new ModelUnavailableError('InternalServerException');
      case 3: // not JSON
        return { ...normal, text: 'I would move on to the next question.' };
      case 4: // an action that is not allowed right now
        return canFollowUp
          ? (closing === 'end'
            ? reply('next_main', '', 'Moving on.', hash, noneMissing)
            : reply('end', '', 'Enough has been covered.', hash, noneMissing))
          : reply('follow_up', followUp, 'One more question is worth asking.', hash, firstOnly);
      case 5: // reason argues for the other action
        return asksFollowUp
          ? reply('follow_up', followUp, 'The answer is complete, no follow-up needed.', hash, firstOnly)
          : reply(closing, '', 'The answer needs clarification before moving on.', hash, noneMissing);
      default:
        return normal;
    }
  };
}

module.exports = { createFakeModel, readMessage, readRubric };
