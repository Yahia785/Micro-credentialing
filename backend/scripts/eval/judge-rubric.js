/**
 * The rubric-check judge.
 *
 * A second, separate judge call. For one student answer (to a main question or to a follow-up) it sees the question, the
 * rubric items (r1, r2, ...) and the answer, and returns the ids of the rubric items the answer did not show, plus a short
 * reason. It is kept apart from the blind follow-up judge (judge.js), which still never sees an answer: that judge looks at
 * a follow-up alone, this one looks at an answer alone. It never sees the code, the follow-up or the Host's own check.
 *
 * Same machinery as judge.js: temperature 0, JSON output, one call per distinct input, identical inputs are judged once and
 * reused, an unreadable reply is asked for once more and then counted as unjudged.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bedrock = require('../../shared/nodejs/agent/bedrock-client');

const RUBRIC_JUDGE_PROMPT_VERSION = 'judge-rubric.v1';
const MAX_TOKENS = 300;
const TIMEOUT_MS = 30000;

const systemPrompt = fs.readFileSync(path.join(__dirname, 'judge-rubric-prompt.v1.md'), 'utf8').trim();

const TAGS = /<\/?\s*student_answer\s*>/gi;
const clean = (text) => String(text).replace(TAGS, '');

/**
 * The message the rubric judge gets. Only these three fields are read: anything else in `input` is ignored.
 * @param {{ mainQuestion: string, rubric: Array<{id: string, text: string}>, answer: string }} input
 */
function buildRubricJudgeMessage({ mainQuestion, rubric, answer }) {
  return [
    `Question: ${mainQuestion}`,
    'Rubric:',
    ...rubric.map((item) => `- ${item.id}: ${item.text}`),
    '<student_answer>',
    clean(answer),
    '</student_answer>',
    'Reply with the JSON object only.',
  ].join('\n');
}

/**
 * Read the judge's reply: `missing` must be a list of known rubric ids ("none" is ignored).
 * @returns {{ ok: true, missing: string[], reason: string } | { ok: false }}
 */
function parseRubricJudgement(text, rubricIds) {
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
  if (!Array.isArray(parsed.missing)) return { ok: false };
  const found = new Set();
  for (const item of parsed.missing) {
    if (typeof item !== 'string') return { ok: false };
    if (item.trim().toLowerCase() === 'none') continue;
    const match = rubricIds.find((id) => id.toLowerCase() === item.trim().toLowerCase());
    if (!match) return { ok: false };
    found.add(match);
  }
  const reason = typeof parsed.reason === 'string' ? parsed.reason.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  return { ok: true, missing: rubricIds.filter((id) => found.has(id)), reason };
}

/**
 * @param {{ modelId: string, converseFn?: Function }} options
 */
function createRubricJudge({ modelId, converseFn = bedrock.converse }) {
  const cache = new Map();
  const usage = { calls: 0, cached: 0, invalid: 0, failed: 0, inputTokens: 0, outputTokens: 0 };

  async function ask(input) {
    const ids = input.rubric.map((item) => item.id);
    const message = buildRubricJudgeMessage(input);
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
      const parsed = parseRubricJudgement(result.text, ids);
      if (parsed.ok) return { valid: true, missing: parsed.missing, reason: parsed.reason };
      usage.invalid += 1;
    }
    return { valid: false, error: 'invalid_output' };
  }

  /**
   * @param {{ mainQuestion: string, rubric: Array<{id: string, text: string}>, answer: string }} input
   *   The key of the reuse cache is built from these fields only.
   * @returns {Promise<{ valid: boolean, missing?: string[], reason?: string, error?: string, cached: boolean }>}
   */
  async function judge(input) {
    const key = crypto.createHash('sha256').update(JSON.stringify([input.mainQuestion, input.rubric, input.answer])).digest('hex');
    if (cache.has(key)) {
      usage.cached += 1;
      return { ...cache.get(key), cached: true };
    }
    const result = await ask(input);
    cache.set(key, result);
    return { ...result, cached: false };
  }

  return { judge, usage, modelId, promptVersion: RUBRIC_JUDGE_PROMPT_VERSION };
}

module.exports = { createRubricJudge, buildRubricJudgeMessage, parseRubricJudgement, RUBRIC_JUDGE_PROMPT_VERSION };
