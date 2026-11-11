/**
 * host.v6: the split agent of host.v5 (check, then write) plus what the engine learns from the code and from the student.
 * split-agent.js (host.v5) is left exactly as it was, for comparison; this file repeats its structure with the v2 prompts.
 *
 *   Step A, check   check.v2.md   the main question, the rubric, the code status, the observed behavior of the student's program
 *                                 (when the engine ran it) and the answer -> evidence, missing items and a `manipulation` flag.
 *   Step B, write   write.v2.md   the code, the code status, the observed behavior, the transcript, the rubric and the missing
 *                                 list -> ONE follow-up. Same guards as host.v5 (JSON retry, rubric-wording, yes/no, two questions).
 *
 * Manipulation: a simple engine check (manipulation.js) runs first. A flagged answer is never sent to the model: it counts as no
 * evidence (every item missing), the engine adds a fixed neutral sentence, and a request for the answer or the rubric is treated
 * like "I don't know" (the follow-up is a hint). The model's own `manipulation` flag on a checked answer does the same.
 *
 * Everything the student wrote, and everything their program printed, reaches a model only as delimited data. Nothing here logs
 * prompts, answers, code or program output.
 */
const fs = require('fs');
const path = require('path');
const { isYesNo, isMultiPart, firstQuestionOnly, leaksCriterion } = require('./follow-up-check');
const { validateCheck, squash, RETRY_NOTE } = require('./rubric-check');
const { isGiveUpKind } = require('./manipulation');
const { describeCodeStatus } = require('./code-status');

const DEFAULT_SPLIT_MODEL = 'deepseek.v3.2';
const CHECK_MAX_TOKENS = 800;
const WRITE_MAX_TOKENS = 400;
const MAX_FOLLOW_UP_LENGTH = 300;
const MAX_CODE_CHARS = 30000;
const MAX_TRANSCRIPT_TURNS = 24;
const MAX_NOTE_LENGTH = 200;
const OBSERVED_STDOUT_CHARS = 2000;
const WITHHELD = '[withheld]';
const CHECK_PROMPT_VERSION = 'check.v2';
const WRITE_PROMPT_VERSION = 'write.v2';
const CHECK_SYSTEM = fs.readFileSync(path.join(__dirname, 'prompts', 'check.v2.md'), 'utf8').trim();
const WRITE_SYSTEM = fs.readFileSync(path.join(__dirname, 'prompts', 'write.v2.md'), 'utf8').trim();

const REQUESTS = Object.freeze({
  json: 'Your reply was not a valid JSON object. Reply with the JSON object only: no other text, no code fences.',
  leak: 'Your follow-up repeats wording from the private guidance. Rewrite it in your own words, without the wording of any rubric item, as ONE question about the same point. Reply with the same JSON object only.',
  yesNo: 'Your follow-up can be answered with yes or no. Rewrite it as ONE open question (explain, trace, predict the output, or what would happen if) about the same point. Reply with the same JSON object only.',
  twoQuestions: 'Your follow-up asks more than one question. Rewrite it as ONE question about the same point, with a single question mark and no second request. Reply with the same JSON object only.',
});

const WRAPPER_TAG = /<(\/?\s*(?:student_answer|student_code|instructor_config|transcript|observed_behavior))/gi;
const neutralise = (text) => String(text).replace(WRAPPER_TAG, '&lt;$1');
const unavailable = (error) => error && error.name === 'ModelUnavailableError';

function resolveSplitModels({ checkerModelId, writerModelId } = {}) {
  return {
    checker: checkerModelId || process.env.AGENT_CHECKER_MODEL_ID || DEFAULT_SPLIT_MODEL,
    writer: writerModelId || process.env.AGENT_WRITER_MODEL_ID || DEFAULT_SPLIT_MODEL,
  };
}

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

// --- what the program printed, as the models see it ---------------------------------------------------------------------

/** The lines for one run: what was fed in, how it ended, what it printed (trimmed). */
function runLines(run) {
  const stdin = String(run.stdin || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const head = `Input "${run.label}" (stdin: ${stdin || 'empty'}):`;
  if (run.status === 'compile_error') return [`${head} the program did not compile.`];
  const out = String(run.stdout || '').slice(0, OBSERVED_STDOUT_CHARS);
  const how = run.status === 'accepted' ? 'finished' : String(run.status || 'unknown').replace(/_/g, ' ');
  return [`${head} ${how}; it printed:`, neutralise(out) || '(nothing)'];
}

/** The observed-behavior block for the models, or [] when nothing was run. */
function observedLines(observed) {
  if (!Array.isArray(observed) || observed.length === 0) return [];
  return ['<observed_behavior>', ...observed.flatMap(runLines), '</observed_behavior>'];
}

// --- step A --------------------------------------------------------------------------------------------------------------

function buildCheckMessage({ mainQuestion, rubric, answer, codeStatus, observed }) {
  return [
    `Main question: ${mainQuestion}`,
    'Rubric items:',
    ...rubric.map((item) => `- ${item.id}: ${item.text}`),
    `Code status: ${describeCodeStatus(codeStatus)}`,
    ...observedLines(observed),
    '<student_answer>',
    neutralise(answer),
    '</student_answer>',
    'Reply with the JSON object only.',
  ].join('\n');
}

/** validateCheck (v1 rules) plus the v2 fields: `manipulation` (a boolean) and an optional short `note` per item. */
function validateCheckV6(text, rubric, answer) {
  const verdict = validateCheck(text, rubric, answer);
  if (!verdict.ok) return verdict;
  const raw = String(text || '');
  let parsed = {};
  try { parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { /* already validated */ }
  const evidence = {};
  Object.entries(verdict.evidence).forEach(([id, entry]) => {
    const note = typeof entry.note === 'string' ? entry.note.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_LENGTH) : '';
    evidence[id] = { quote: entry.quote, shown: entry.shown, ...(note && { note }) };
  });
  return { ok: true, missing: verdict.missing, evidence, manipulation: parsed.manipulation === true };
}

async function checkAnswer({ converseFn, modelId, mainQuestion, rubric, answer, codeStatus, observed }) {
  const rec = recorder('check', modelId);
  const messages = [{ role: 'user', content: [{ text: buildCheckMessage({ mainQuestion, rubric, answer, codeStatus, observed }) }] }];
  let retried = false;
  let verdict = { ok: false, error: 'no reply' };
  let reply = '';
  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await rec.ask(converseFn, { system: CHECK_SYSTEM, messages, maxTokens: CHECK_MAX_TOKENS });
      reply = result.text;
      verdict = validateCheckV6(result.text, rubric, answer);
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
  if (verdict.ok) return { ok: true, missing: verdict.missing, evidence: verdict.evidence, manipulation: verdict.manipulation, retried, calls: rec.calls, usage: rec.total };
  return { ok: false, error: verdict.error, reply, retried, calls: rec.calls, usage: rec.total };
}

// --- step B --------------------------------------------------------------------------------------------------------------

function buildWriteMessage({ code, turns, mainQuestion, rubric, missing, codeStatus, observed, noUsableAnswer }) {
  const trimmed = code.length > MAX_CODE_CHARS ? `${code.slice(0, MAX_CODE_CHARS)}\n// [code truncated]` : code;
  const transcript = turns.slice(-MAX_TRANSCRIPT_TURNS).map((turn) => (
    turn.role === 'student' ? `<student_answer>\n${neutralise(turn.text)}\n</student_answer>` : `[host] ${turn.text}`
  )).join('\n');
  return [
    '<student_code>',
    neutralise(trimmed),
    '</student_code>',
    `Code status: ${describeCodeStatus(codeStatus)}`,
    ...observedLines(observed),
    `Main question: ${mainQuestion}`,
    'Rubric (private):',
    ...rubric.map((item) => `- ${item.id}: ${item.text}`),
    '<transcript>',
    transcript,
    '</transcript>',
    `Missing items: ${missing.join(', ')}`,
    `Target: ${missing[0]}`,
    `Latest answer: ${noUsableAnswer ? 'no usable answer' : 'an answer'}`,
    'Reply with the JSON object only.',
  ].join('\n');
}

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

function problemWith(question, secrets) {
  if (!question || question.length > MAX_FOLLOW_UP_LENGTH) return 'question_invalid';
  if (/\b(rubric|criteria|criterion)\b/i.test(question)) return 'rubric_word';
  if (leaksCriterion(question, secrets)) return 'rubric_leak';
  return null;
}

async function writeFollowUp({ converseFn, modelId, code, turns, mainQuestion, rubric, missing, criteria = [], codeStatus, observed, noUsableAnswer = false }) {
  const rec = recorder('write', modelId);
  const secrets = [...criteria, ...rubric.map((item) => item.text)];
  const messages = [{ role: 'user', content: [{ text: buildWriteMessage({ code, turns, mainQuestion, rubric, missing, codeStatus, observed, noUsableAnswer }) }] }];
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
        guard.retryFailed = true;
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

// --- one decision --------------------------------------------------------------------------------------------------------

/** The student turns that were flagged (the flag is stored on the host turn that followed them) are shown to the writer as withheld. */
function maskFlaggedAnswers(turns, latestFlagged) {
  return turns.map((turn, i) => {
    if (turn.role !== 'student') return turn;
    const isLatest = i === turns.length - 1;
    const flagged = isLatest ? latestFlagged : !!(turns[i + 1] && turns[i + 1].manipulation);
    return flagged ? { ...turn, text: WITHHELD } : turn;
  });
}

/**
 * The check and (when something is missing) the write for one answer.
 * @param flag  the engine's own manipulation finding for this answer ({ kind, quote, source }) or null
 * @returns {{ decision, fallback, rejected, repairs, guard, calls, usage, evidence, manipulation, retried }}
 *          decision is null when the models failed (fallback is then 'model_unavailable' or 'invalid_output')
 */
async function decide({ converseFn, models, code, turns, mainQuestion, rubric, criteria, answer, observed, codeStatus, flag, nextMain }) {
  const out = { decision: null, fallback: null, rejected: null, repairs: [], guard: null, calls: [], usage: { inputTokens: 0, outputTokens: 0, latencyMs: 0 }, evidence: null, manipulation: flag || null };
  const addUsage = (u) => {
    out.usage = { inputTokens: out.usage.inputTokens + u.inputTokens, outputTokens: out.usage.outputTokens + u.outputTokens, latencyMs: out.usage.latencyMs + u.latencyMs };
  };
  const ids = rubric.map((item) => item.id);
  let missing;

  if (flag) {
    // Never sent to a model: no evidence at all.
    missing = ids;
  } else {
    const checked = await checkAnswer({ converseFn, modelId: models.checker, mainQuestion, rubric, answer, codeStatus, observed });
    out.calls.push(...checked.calls);
    addUsage(checked.usage);
    if (checked.retried) out.repairs.push({ type: 'check_retry', fixed: !!checked.ok });
    if (checked.unavailable) { out.fallback = 'model_unavailable'; return out; }
    if (!checked.ok) {
      out.fallback = 'invalid_output';
      out.rejected = { code: 'check_invalid', reply: `${checked.error}: ${checked.reply}` };
      return out;
    }
    out.evidence = checked.evidence;
    if (checked.manipulation) {
      out.manipulation = { kind: 'model', quote: String(answer).slice(0, 300), source: 'model' };
      missing = ids;
    } else {
      missing = checked.missing;
    }
  }

  if (missing.length === 0) {
    out.decision = { action: nextMain ? 'next_main' : 'end', question: '', reason: 'check: every rubric item is shown; no follow-up needed', missing: [], target: null, isHint: false };
    return out;
  }

  const flagged = !!out.manipulation;
  const giveUp = flagged && isGiveUpKind(out.manipulation.kind);
  const written = await writeFollowUp({
    converseFn, modelId: models.writer, code, turns: maskFlaggedAnswers(turns, flagged), mainQuestion, rubric, missing, criteria, codeStatus, observed,
    noUsableAnswer: flagged,
  });
  out.calls.push(...written.calls);
  addUsage(written.usage);
  out.repairs.push(...written.repairs);
  if (written.guard) out.guard = written.guard;
  if (written.unavailable) { out.fallback = 'model_unavailable'; return out; }
  if (!written.ok) {
    out.fallback = 'invalid_output';
    out.rejected = { code: written.error, reply: written.reply };
    return out;
  }
  out.decision = {
    action: 'follow_up',
    question: written.question,
    reason: flagged
      ? `check: answer flagged (${out.manipulation.kind}), counted as no evidence; asked about ${missing[0]}`
      : `check: ${missing.join(', ')} not shown; asked about ${missing[0]}`,
    missing,
    target: missing[0],
    isHint: giveUp || written.isHint,
  };
  return out;
}

module.exports = {
  DEFAULT_SPLIT_MODEL, CHECK_PROMPT_VERSION, WRITE_PROMPT_VERSION, CHECK_SYSTEM, WRITE_SYSTEM, REQUESTS, WITHHELD,
  resolveSplitModels, checkAnswer, writeFollowUp, decide, buildCheckMessage, buildWriteMessage, validateCheckV6, maskFlaggedAnswers, observedLines, squash,
};
