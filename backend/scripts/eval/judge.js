/**
 * The blind follow-up judge.
 *
 * For a follow-up the Host asked, a second (larger, different) model labels the follow-up on its own:
 * which gaps it targets, which gaps it gives away, whether it asks two things at once and whether it
 * goes beyond the instructor's criteria. It sees only the main question, the criteria, the gap list of
 * that question and the follow-up text. It never sees the student's answer, the code, the interview
 * setup or any identifier: whether a label counts as a hit is decided afterwards, by comparing the
 * labels with the gaps the scripted answer left (see adaptive.js).
 *
 * Temperature 0, JSON output, one call per follow-up. Identical inputs are judged once and reused. An
 * unreadable reply is asked for once more; after that the item stays unjudged and is counted as such.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bedrock = require('../../shared/nodejs/agent/bedrock-client');

const JUDGE_PROMPT_VERSION = 'judge.v2';
const DEFAULT_JUDGE_MODEL = 'mistral.mistral-large-3-675b-instruct';
// USD per million tokens, from the AWS Bedrock pricing page for us-east-1 (verify before relying on it).
const DEFAULT_JUDGE_PRICES = Object.freeze({ inputPerMillion: 0.5, outputPerMillion: 1.5 });
const NONE = 'none';
const MAX_TOKENS = 400;
const TIMEOUT_MS = 30000;

// judge-prompt.v1.md is the earlier prompt (it saw the answer); it is kept for comparison and is not used.
const systemPrompt = fs.readFileSync(path.join(__dirname, 'judge-prompt.v2.md'), 'utf8').trim();

const TAGS = /<\/?\s*follow_up\s*>/gi;
const clean = (text) => String(text).replace(TAGS, '');

/**
 * The message the judge gets. Only these four fields are read: anything else in `input` (such as the
 * student's answer) is ignored, so it cannot reach the judge.
 */
function buildJudgeMessage({ mainQuestion, criteria, gaps, followUp }) {
  return [
    `Main question: ${mainQuestion}`,
    'Criteria:',
    ...criteria.map((criterion) => `- ${criterion}`),
    'Gaps:',
    ...gaps.map((gap) => `- ${gap.id}: ${gap.text}`),
    '<follow_up>',
    clean(followUp),
    '</follow_up>',
    'Reply with the JSON object only.',
  ].join('\n');
}

/** A list of known ids from the judge's reply (case-insensitive), or null when it is not one. */
function idList(value, known) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const item of value) {
    const match = typeof item === 'string' ? known.find((id) => id.toLowerCase() === item.trim().toLowerCase()) : undefined;
    if (!match) return null;
    if (!out.includes(match)) out.push(match);
  }
  return out;
}

/**
 * Read the judge's reply. `targets` is a list of gap ids, or ['none']; `reveals` a list of gap ids.
 * @returns {{ ok: true, targets: string[], reveals: string[], twoPart: boolean, beyondScope: boolean, reason: string } | { ok: false }}
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
  let targets = idList(parsed.targets, [...gapIds, NONE]);
  const reveals = idList(parsed.reveals, gapIds);
  if (!targets || !reveals) return { ok: false };
  if (typeof parsed.two_part !== 'boolean' || typeof parsed.beyond_scope !== 'boolean') return { ok: false };
  if (targets.length > 1) targets = targets.filter((id) => id !== NONE);
  if (targets.length === 0) targets = [NONE];
  const reason = typeof parsed.reason === 'string' ? parsed.reason.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  return { ok: true, targets, reveals, twoPart: parsed.two_part, beyondScope: parsed.beyond_scope, reason };
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
        return { valid: false, error: error.reason || error.name };
      }
      usage.calls += 1;
      usage.inputTokens += result.inputTokens || 0;
      usage.outputTokens += result.outputTokens || 0;
      const parsed = parseJudgement(result.text, gapIds);
      if (parsed.ok) {
        const { ok, ...labels } = parsed;
        return { valid: true, ...labels };
      }
      usage.invalid += 1;
    }
    return { valid: false, error: 'invalid_output' };
  }

  /**
   * @param {{ mainQuestion: string, criteria: string[], gaps: Array<{id: string, text: string}>, followUp: string }} input
   *   Nothing else is used: the key of the reuse cache is built from these fields only.
   * @returns {Promise<{ valid: boolean, targets?: string[], reveals?: string[], twoPart?: boolean, beyondScope?: boolean, reason?: string, error?: string, cached: boolean }>}
   */
  async function judge(input) {
    const key = crypto.createHash('sha256')
      .update(JSON.stringify([input.mainQuestion, input.criteria, input.gaps, input.followUp])).digest('hex');
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
  JUDGE_PROMPT_VERSION, DEFAULT_JUDGE_MODEL, DEFAULT_JUDGE_PRICES, NONE,
};
