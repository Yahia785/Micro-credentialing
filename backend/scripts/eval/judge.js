/**
 * The gap-targeting judge.
 *
 * For a follow-up the Host asked, a second (larger, different) model says which gap the follow-up
 * is aiming at: one of the gap ids of that main question, "none" (generic) or "other" (something
 * that is not a listed gap). It sees only the main question, the scripted student answer, the
 * follow-up and the gap list: no code, no interview setup, no identifiers.
 *
 * Temperature 0, JSON output. Identical inputs are judged once and reused. An unreadable reply is
 * asked for once more; after that the item stays unjudged and is counted as such.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bedrock = require('../../shared/nodejs/agent/bedrock-client');

const JUDGE_PROMPT_VERSION = 'judge.v1';
const DEFAULT_JUDGE_MODEL = 'mistral.mistral-large-3-675b-instruct';
// USD per million tokens, from the AWS Bedrock pricing page for us-east-1 (verify before relying on it).
const DEFAULT_JUDGE_PRICES = Object.freeze({ inputPerMillion: 0.5, outputPerMillion: 1.5 });
const NO_GAP = ['none', 'other'];
const MAX_TOKENS = 300;
const TIMEOUT_MS = 30000;

const systemPrompt = fs.readFileSync(path.join(__dirname, 'judge-prompt.v1.md'), 'utf8').trim();

const TAGS = /<\/?\s*(student_answer|follow_up)\s*>/gi;
const clean = (text) => String(text).replace(TAGS, '');

/** The message the judge gets. */
function buildJudgeMessage({ mainQuestion, answer, followUp, gaps }) {
  return [
    `Main question: ${mainQuestion}`,
    '<student_answer>',
    clean(answer),
    '</student_answer>',
    '<follow_up>',
    clean(followUp),
    '</follow_up>',
    'Gaps:',
    ...gaps.map((gap) => `- ${gap.id}: ${gap.text}`),
    'Reply with the JSON object only.',
  ].join('\n');
}

/**
 * Read the judge's reply.
 * @returns {{ ok: true, target: string, reason: string } | { ok: false }}
 */
function parseJudgement(text, gapIds) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return { ok: false };
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { ok: false };
  }
  const target = typeof parsed.target === 'string' ? parsed.target.trim() : '';
  const known = [...gapIds, ...NO_GAP];
  const match = known.find((id) => id.toLowerCase() === target.toLowerCase());
  if (!match) return { ok: false };
  const reason = typeof parsed.reason === 'string' ? parsed.reason.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  return { ok: true, target: match, reason };
}

/**
 * @param {{ modelId: string, converseFn?: Function }} options converseFn defaults to the Bedrock client;
 *   pass a wrapped or fake function to retry throttling or to run without AWS.
 */
function createJudge({ modelId, converseFn = bedrock.converse }) {
  const cache = new Map();
  const usage = { calls: 0, cached: 0, invalid: 0, failed: 0, inputTokens: 0, outputTokens: 0 };

  async function ask(input) {
    const gapIds = input.gaps.map((gap) => gap.id);
    const message = buildJudgeMessage(input);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let result;
      try {
        result = await converseFn({
          system: systemPrompt,
          messages: [{ role: 'user', content: [{ text: message }] }],
          modelId,
          maxTokens: MAX_TOKENS,
          temperature: 0,
          timeoutMs: TIMEOUT_MS,
        });
      } catch (error) {
        usage.failed += 1;
        return { valid: false, target: null, reason: '', error: error.reason || error.name };
      }
      usage.calls += 1;
      usage.inputTokens += result.inputTokens || 0;
      usage.outputTokens += result.outputTokens || 0;
      const parsed = parseJudgement(result.text, gapIds);
      if (parsed.ok) return { valid: true, target: parsed.target, reason: parsed.reason };
      usage.invalid += 1;
    }
    return { valid: false, target: null, reason: '', error: 'invalid_output' };
  }

  /**
   * @param {{ mainQuestion: string, answer: string, followUp: string, gaps: Array<{id: string, text: string}> }} input
   * @returns {Promise<{ valid: boolean, target: string|null, reason: string, error?: string, cached: boolean }>}
   */
  async function judge(input) {
    const key = crypto.createHash('sha256').update(JSON.stringify([input.mainQuestion, input.answer, input.followUp, input.gaps])).digest('hex');
    if (cache.has(key)) {
      usage.cached += 1;
      return { ...cache.get(key), cached: true };
    }
    const result = await ask(input);
    cache.set(key, result);
    return { ...result, cached: false };
  }

  return { judge, usage, modelId, promptVersion: JUDGE_PROMPT_VERSION };
}

/** True when both model IDs start with the same provider prefix (for example qwen. and qwen.). */
const sameProvider = (a, b) => String(a).split('.')[0] === String(b).split('.')[0];

function estimateJudgeCost(usage, prices = DEFAULT_JUDGE_PRICES) {
  return (usage.inputTokens * prices.inputPerMillion + usage.outputTokens * prices.outputPerMillion) / 1e6;
}

module.exports = {
  createJudge, buildJudgeMessage, parseJudgement, estimateJudgeCost, sameProvider,
  JUDGE_PROMPT_VERSION, DEFAULT_JUDGE_MODEL, DEFAULT_JUDGE_PRICES, NO_GAP,
};
