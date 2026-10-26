/**
 * A deterministic stand-in for Bedrock, so the evaluation runner can be tested without AWS.
 *
 * It reads the same message the real model gets (the allowed actions and the student's latest
 * answer) and answers with valid JSON: a follow-up for short or "I don't know" answers when one is
 * allowed, otherwise the next main question (or end). A seeded share of calls misbehave on purpose
 * so every metric path is exercised: transient and persistent throttling, other unavailability,
 * unusable output, a disallowed action, and a reason that contradicts the action.
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

function hashOf(text, seed) {
  return crypto.createHash('sha256').update(`${seed}|${text}`).digest().readUInt32BE(0);
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

function reply(action, question, reason, hash) {
  const text = JSON.stringify({ action, question, reason });
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
    const hash = hashOf(text, seed);
    const attempt = attempts.get(hash) || 0;
    attempts.set(hash, attempt + 1);

    const { allowed, last } = readMessage(text);
    const canFollowUp = allowed.includes('follow_up');
    const closing = allowed.includes('end') ? 'end' : 'next_main';
    const followUp = FOLLOW_UP_QUESTIONS[(hash >>> 8) % FOLLOW_UP_QUESTIONS.length];

    const asksFollowUp = canFollowUp && isWeak(last);
    const normal = asksFollowUp
      ? reply('follow_up', followUp, 'The answer is short, so one follow-up is asked.', hash)
      : reply(closing, '', 'The answer is sufficient for this question.', hash);

    const chaotic = (hash % 1000) / 1000 < chaos;
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
            ? reply('next_main', '', 'Moving on.', hash)
            : reply('end', '', 'Enough has been covered.', hash))
          : reply('follow_up', followUp, 'One more question is worth asking.', hash);
      case 5: // reason argues for the other action
        return asksFollowUp
          ? reply('follow_up', followUp, 'The answer is complete, no follow-up needed.', hash)
          : reply(closing, '', 'The answer needs clarification before moving on.', hash);
      default:
        return normal;
    }
  };
}

module.exports = { createFakeModel };
