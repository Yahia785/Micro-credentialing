/**
 * The split agent (host.v5): two small calls instead of one big one.
 *
 *   Step A, check   check.v1.md: the main question, the rubric and the student's latest answer -> evidence, then the missing items.
 *                   Validated (see rubric-check.js); one retry that names the problem, then the engine falls back.
 *   Step B, write   write.v1.md: the code, the transcript, the main question, the rubric and the missing list -> ONE follow-up
 *                   aimed at the first missing item. Guarded like host.v4.1: one retry for a reply that is not JSON, one rewrite
 *                   for a question that repeats rubric wording, one for a yes/no question, one for a two-question follow-up.
 *
 * Step B only runs when step A finds something missing. The two steps may use different models (config options). Each call is
 * recorded (model id, tokens, latency). Nothing here logs prompts, answers or code.
 */
const fs = require('fs');
const path = require('path');
const { isYesNo, isMultiPart, firstQuestionOnly, leaksCriterion } = require('./follow-up-check');
const { CHECK_SYSTEM, buildCheckMessage, validateCheck, RETRY_NOTE } = require('./rubric-check');

const DEFAULT_SPLIT_MODEL = 'deepseek.v3.2';
const CHECK_MAX_TOKENS = 700;
const WRITE_MAX_TOKENS = 400;
const MAX_FOLLOW_UP_LENGTH = 300;
const MAX_CODE_CHARS = 30000;
const MAX_TRANSCRIPT_TURNS = 24;
const WRITE_PROMPT_VERSION = 'write.v1';
const WRITE_SYSTEM = fs.readFileSync(path.join(__dirname, 'prompts', 'write.v1.md'), 'utf8').trim();

// Same wording as the engine's requests for host.v4.1.
const REQUESTS = Object.freeze({
  json: 'Your reply was not a valid JSON object. Reply with the JSON object only: no other text, no code fences.',
  leak: 'Your follow-up repeats wording from the private guidance. Rewrite it in your own words, without the wording of any rubric item, as ONE question about the same point. Reply with the same JSON object only.',
  yesNo: 'Your follow-up can be answered with yes or no. Rewrite it as ONE open question (explain, trace, predict the output, or what would happen if) about the same point. Reply with the same JSON object only.',
  twoQuestions: 'Your follow-up asks more than one question. Rewrite it as ONE question about the same point, with a single question mark and no second request. Reply with the same JSON object only.',
});

/** The checker and writer model ids: explicit options, else AGENT_CHECKER_MODEL_ID / AGENT_WRITER_MODEL_ID, else DeepSeek v3.2. */
function resolveSplitModels({ checkerModelId, writerModelId } = {}) {
  return {
    checker: checkerModelId || process.env.AGENT_CHECKER_MODEL_ID || DEFAULT_SPLIT_MODEL,
    writer: writerModelId || process.env.AGENT_WRITER_MODEL_ID || DEFAULT_SPLIT_MODEL,
  };
}

const unavailable = (error) => error && error.name === 'ModelUnavailableError';

/** Keeps the record of every call and the running total. */
function recorder(step, modelId) {
  const calls = [];
  const total = { inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  return {
    calls,
    total,
    async ask(converseFn, request) {
      const result = await converseFn({ modelId, temperature: 0, ...request });
      const call = { step, modelId, inputTokens: result.inputTokens || 0, outputTokens: result.outputTokens || 0, latencyMs: result.latencyMs || 0 };
      calls.push(call);
      total.inputTokens += call.inputTokens;
      total.outputTokens += call.outputTokens;
      total.latencyMs += call.latencyMs;
      return result;
    },
  };
}

/**
 * Step A. Returns { ok, missing, evidence, retried, calls, usage } when the reply passed the validation,
 * { ok: false, error, reply, retried, calls, usage } when it did not (after one retry), or { unavailable: true, calls, usage }.
 */
async function checkAnswer({ converseFn, modelId, mainQuestion, rubric, answer }) {
  const rec = recorder('check', modelId);
  const messages = [{ role: 'user', content: [{ text: buildCheckMessage({ mainQuestion, rubric, answer }) }] }];
  let retried = false;
  let verdict = { ok: false, error: 'no reply' };
  let reply = '';
  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await rec.ask(converseFn, { system: CHECK_SYSTEM, messages, maxTokens: CHECK_MAX_TOKENS });
      reply = result.text;
      verdict = validateCheck(result.text, rubric, answer);
      if (verdict.ok) break;
      if (attempt === 1) {
        retried = true;
        messages.push({ role: 'assistant', content: [{ text: result.text }] }, { role: 'user', content: [{ text: RETRY_NOTE(verdict.error) }] });
      }
    }
  } catch (error) {
    if (!unavailable(error)) throw error;
    return { unavailable: true, retried, calls: rec.calls, usage: rec.total };
  }
  if (verdict.ok) return { ok: true, missing: verdict.missing, evidence: verdict.evidence, retried, calls: rec.calls, usage: rec.total };
  return { ok: false, error: verdict.error, reply, retried, calls: rec.calls, usage: rec.total };
}

// ---------------------------------------------------------------------------------------------

const WRAPPER_TAG = /<(\/?\s*(?:student_answer|student_code|instructor_config|transcript))/gi;
const neutralise = (text) => String(text).replace(WRAPPER_TAG, '&lt;$1');

function buildWriteMessage({ code, turns, mainQuestion, rubric, missing }) {
  const trimmed = code.length > MAX_CODE_CHARS ? `${code.slice(0, MAX_CODE_CHARS)}\n// [code truncated]` : code;
  const transcript = turns.slice(-MAX_TRANSCRIPT_TURNS).map((turn) => (
    turn.role === 'student' ? `<student_answer>\n${neutralise(turn.text)}\n</student_answer>` : `[host] ${turn.text}`
  )).join('\n');
  return [
    '<student_code>',
    neutralise(trimmed),
    '</student_code>',
    `Main question: ${mainQuestion}`,
    'Rubric (private):',
    ...rubric.map((item) => `- ${item.id}: ${item.text}`),
    '<transcript>',
    transcript,
    '</transcript>',
    `Missing items: ${missing.join(', ')}`,
    `Target: ${missing[0]}`,
    'Reply with the JSON object only.',
  ].join('\n');
}

/** { isHint, question } from the writer's reply, or null when it is not a JSON object with a question. */
function parseWrite(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.question !== 'string') return null;
  return { isHint: parsed.isHint === true, question: parsed.question.replace(/\s+/g, ' ').trim() };
}

/** Why the question is not acceptable (the engine's checks), or null. */
function problemWith(question, secrets) {
  if (!question || question.length > MAX_FOLLOW_UP_LENGTH) return 'question_invalid';
  if (/\b(rubric|criteria|criterion)\b/i.test(question)) return 'rubric_word';
  if (leaksCriterion(question, secrets)) return 'rubric_leak';
  return null;
}

/**
 * Step B. Returns { ok: true, question, isHint, guard, repairs, calls, usage }, { ok: false, error, reply, repairs, guard, calls, usage }
 * or { unavailable: true, ... }. `guard` is the two-question record ({ fired, original, fixedByRetry }) when it fired.
 */
async function writeFollowUp({ converseFn, modelId, code, turns, mainQuestion, rubric, missing, criteria = [] }) {
  const rec = recorder('write', modelId);
  const secrets = [...criteria, ...rubric.map((item) => item.text)];
  const messages = [{ role: 'user', content: [{ text: buildWriteMessage({ code, turns, mainQuestion, rubric, missing }) }] }];
  const repairs = [];
  let guard = null;
  let last = '';

  const call = async (request) => {
    const convo = request
      ? [...messages, { role: 'assistant', content: [{ text: last }] }, { role: 'user', content: [{ text: request }] }]
      : messages;
    const result = await rec.ask(converseFn, { system: WRITE_SYSTEM, messages: convo, maxTokens: WRITE_MAX_TOKENS });
    last = result.text;
    return parseWrite(result.text);
  };
  const done = (extra) => ({ repairs, ...(guard && { guard }), calls: rec.calls, usage: rec.total, ...extra });
  const fail = (error) => done({ ok: false, error, reply: last });

  try {
    let reply = await call();
    if (!reply) {
      reply = await call(REQUESTS.json);
      repairs.push({ type: 'json_retry', fixed: !!reply });
      if (!reply) return fail('bad_json');
    }
    let problem = problemWith(reply.question, secrets);
    if (problem === 'rubric_leak') {
      const original = reply.question;
      const again = await call(REQUESTS.leak);
      const fixed = !!again && !problemWith(again.question, secrets);
      repairs.push({ type: 'leak_rewrite', original, fixed });
      if (fixed) { reply = again; problem = null; }
    }
    if (problem) return fail(problem);
    if (isYesNo(reply.question)) {
      const original = reply.question;
      const again = await call(REQUESTS.yesNo);
      const fixed = !!again && !isYesNo(again.question) && !problemWith(again.question, secrets);
      repairs.push({ type: 'yes_no_rewrite', original, fixed });
      if (!fixed) return fail('yes_no');
      reply = again;
    }
    if (isMultiPart(reply.question)) {
      guard = { fired: true, original: reply.question, fixedByRetry: false };
      let again = null;
      try {
        again = await call(REQUESTS.twoQuestions);
      } catch (error) {
        if (!unavailable(error)) throw error;
        guard.retryFailed = true; // keep the first question only, as the engine does for the other versions
      }
      if (again && !isMultiPart(again.question) && !isYesNo(again.question) && !problemWith(again.question, secrets)) {
        guard.fixedByRetry = true;
        reply = again;
      } else {
        reply = { ...reply, question: firstQuestionOnly(reply.question) };
      }
    }
    return done({ ok: true, question: reply.question, isHint: reply.isHint });
  } catch (error) {
    if (!unavailable(error)) throw error;
    if (guard) guard.retryFailed = true;
    return done({ unavailable: true });
  }
}

module.exports = {
  DEFAULT_SPLIT_MODEL, WRITE_PROMPT_VERSION, WRITE_SYSTEM, REQUESTS, resolveSplitModels, checkAnswer, writeFollowUp, buildWriteMessage, parseWrite, problemWith,
};
