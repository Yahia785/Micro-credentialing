/**
 * The fixed-survey baseline: a stand-in for the Host model that ignores the student's answer.
 *
 * After every main answer it asks the one fixed follow-up written for that main question in the case
 * config (`fixedFollowUps`), then moves on. It goes through the real service and engine like any
 * other arm, so the same checks and the same metrics apply. It sends nothing to Bedrock.
 */
const { readMessage } = require('./fake-model');

const ARM = 'fixed';

/**
 * @param {{ fixedFollowUps: string[], getMainOrdinal: () => number }} options
 *   getMainOrdinal returns the 0-based main question the student is answering right now.
 * @returns {(request: object) => Promise<object>} same shape as bedrock-client's converse
 */
function createFixedModel({ fixedFollowUps, getMainOrdinal }) {
  const asked = new Set();

  return async function fixedConverse(request) {
    const { allowed } = readMessage(request.messages[0].content[0].text);
    const ordinal = getMainOrdinal();
    const question = fixedFollowUps[ordinal];
    const usage = { inputTokens: 0, outputTokens: 0, latencyMs: 0 };

    if (allowed.includes('follow_up') && question && !asked.has(ordinal)) {
      asked.add(ordinal);
      return {
        ...usage,
        text: JSON.stringify({ action: 'follow_up', question, reason: 'Fixed survey: the fixed question for this main question is always asked.' }),
      };
    }
    const closing = allowed.includes('end') ? 'end' : 'next_main';
    return { ...usage, text: JSON.stringify({ action: closing, question: '', reason: 'Fixed survey: the fixed question for this main question has been asked.' }) };
  };
}

module.exports = { createFixedModel, ARM };
