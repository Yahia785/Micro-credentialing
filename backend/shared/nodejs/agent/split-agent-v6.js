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
 * Follow-up answers are checked too (check only, no write): the checker sees the main answer and the follow-up answers together, items
 * already shown stay shown, and an item the follow-up answer newly shows is marked viaFollowUp (and afterHint when the follow-up was a hint).
 * An item counts as shown only when the quote states the whole item; a partial quote is kept as evidence of what was said.
 * A follow-up never states the content of a not-shown item (givesAwayItem, then the same rewrite as a rubric leak).
 *
 * host.v7 (mode 'v7') is this agent with the findings of the code analysis (analysis.js) for the current main question: the check call
 * also reports the findings the answer contradicts or addressed, and the follow-up target order is (1) a contradicted finding, (2) a
 * missing rubric item, (3) a related bug or risk finding the answer did not address. check.v3 and write.v3 are check.v2 and write.v2 plus
 * the findings rules.
 *
 * Everything the student wrote, and everything their program printed, reaches a model only as delimited data. Nothing here logs
 * prompts, answers, code or program output.
 */
const fs = require('fs');
const path = require('path');
const { isYesNo, isMultiPart, firstQuestionOnly, leaksCriterion, givesAwayItem } = require('./follow-up-check');
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
// host.v7: the same two prompts followed by the rules for the code findings (prompts/check.v3.md and write.v3.md hold only those rules).
const CHECK_PROMPT_VERSION_V7 = 'check.v3';
const WRITE_PROMPT_VERSION_V7 = 'write.v3';
const CHECK_SYSTEM_V7 = `${CHECK_SYSTEM}

${fs.readFileSync(path.join(__dirname, 'prompts', 'check.v3.md'), 'utf8').trim()}`;
const WRITE_SYSTEM_V7 = `${WRITE_SYSTEM}

${fs.readFileSync(path.join(__dirname, 'prompts', 'write.v3.md'), 'utf8').trim()}`;
const systemFor = (mode) => (mode === 'v7' ? { check: CHECK_SYSTEM_V7, write: WRITE_SYSTEM_V7 } : { check: CHECK_SYSTEM, write: WRITE_SYSTEM });

const REQUESTS = Object.freeze({
  json: 'Your reply was not a valid JSON object. Reply with the JSON object only: no other text, no code fences.',
  giveAway: 'Your follow-up states what the student still has to show. Rewrite it as ONE question that does not say what happens or why: point to the input or to a place in the code, and let the student say it. Reply with the same JSON object only.',
  leak: 'Your follow-up repeats wording from the private guidance. Rewrite it in your own words, without the wording of any rubric item, as ONE question about the same point. Reply with the same JSON object only.',
  yesNo: 'Your follow-up can be answered with yes or no. Rewrite it as ONE open question (explain, trace, predict the output, or what would happen if) about the same point. Reply with the same JSON object only.',
  twoQuestions: 'Your follow-up asks more than one question. Rewrite it as ONE question about the same point, with a single question mark and no second request. Reply with the same JSON object only.',
});

const WRAPPER_TAG = /<(\/?\s*(?:student_answer|student_code|instructor_config|transcript|observed_behavior|code_findings))/gi;
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

// --- the code findings (host.v7), as the models see them ------------------------------------------------------------------

/** One finding as one line: id, kind, lines, what was found, and the run that showed it. */
function findingLine(finding) {
  const lines = finding.lines ? `; lines ${finding.lines}` : '';
  const run = finding.evidence && (finding.evidence.stdin || finding.evidence.output)
    ? ` Run: input "${String(finding.evidence.stdin || '').replace(/\s+/g, ' ').trim().slice(0, 200)}" printed "${String(finding.evidence.output || '').replace(/\s+/g, ' ').trim().slice(0, 300)}".`
    : '';
  return `- ${finding.id} (${finding.kind}${lines}): ${neutralise(finding.concept)}.${run}`;
}

/** The findings block for the models, or [] when there are none. */
function findingLines(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return [];
  return ['<code_findings>', ...findings.map(findingLine), '</code_findings>'];
}

// --- step A --------------------------------------------------------------------------------------------------------------

/**
 * `exchange` is what the student said about this main question, in order: [{ question: null, answer }] for the main answer, then
 * [{ question, answer }] for every follow-up that was asked. Without it the single `answer` is the main answer.
 */
function buildCheckMessage({ mainQuestion, rubric, answer, exchange, codeStatus, observed, findings }) {
  const parts = exchange && exchange.length ? exchange : [{ question: null, answer }];
  const answers = parts.flatMap((part) => [
    ...(part.question ? [`Follow-up question that was asked: ${neutralise(part.question)}`] : []),
    '<student_answer>',
    neutralise(part.answer),
    '</student_answer>',
  ]);
  return [
    `Main question: ${mainQuestion}`,
    'Rubric items:',
    ...rubric.map((item) => `- ${item.id}: ${item.text}`),
    `Code status: ${describeCodeStatus(codeStatus)}`,
    ...observedLines(observed),
    ...findingLines(findings),
    ...(parts.length > 1 ? ['The first <student_answer> answers the main question; the later ones answer follow-up questions about the same main question.'] : []),
    ...answers,
    'Reply with the JSON object only.',
  ].join('\n');
}

/**
 * validateCheck (v1 rules) plus the v2 fields: `manipulation` (a boolean) and an optional short `note` per item, and for host.v7 the
 * findings the answer `contradicted` ([{ id, quote }], the quote must be in the answer) and `addressed` (ids). Ids of findings that
 * were not given are dropped, not an error.
 */
function validateCheckV6(text, rubric, answer, findings = []) {
  const raw = String(text || '');
  let parsed = {};
  try { parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { /* validateCheck says what is wrong */ }
  // A quote is one exact fragment of the answer, or a LIST of exact fragments (the evidence can be in several places; each one must be in
  // the answer). A string that joins parts with "..." is read as a list too. validateCheck (v1) sees the first fragment only.
  const haystack = squash(answer);
  const fragmentsOf = {};
  let checkable = text;
  if (parsed && parsed.evidence && typeof parsed.evidence === 'object' && !Array.isArray(parsed.evidence)) {
    const copy = { ...parsed, evidence: {} };
    for (const [id, entry] of Object.entries(parsed.evidence)) {
      if (!entry || typeof entry !== 'object') { copy.evidence[id] = entry; continue; }
      let parts = null;
      if (Array.isArray(entry.quote)) parts = entry.quote;
      else if (typeof entry.quote === 'string' && !haystack.includes(squash(entry.quote)) && /\.\.\.|…/.test(entry.quote)) parts = entry.quote.split(/\.{3,}|…/);
      if (parts) {
        if (parts.some((part) => typeof part !== 'string')) return { ok: false, error: `bad evidence for ${id}` };
        const kept = parts.map((part) => part.trim()).filter((part) => squash(part));
        const missing = kept.find((part) => !haystack.includes(squash(part)));
        if (missing !== undefined) return { ok: false, error: `quote for ${id} is not in the answer` };
        fragmentsOf[id] = kept;
        copy.evidence[id] = { ...entry, quote: kept[0] || '' };
      } else {
        copy.evidence[id] = entry;
      }
    }
    checkable = JSON.stringify(copy);
  }
  const verdict = validateCheck(checkable, rubric, answer);
  if (!verdict.ok) return verdict;
  const evidence = {};
  Object.entries(verdict.evidence).forEach(([id, entry]) => {
    const note = typeof entry.note === 'string' ? entry.note.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_LENGTH) : '';
    const fragments = fragmentsOf[id];
    // quote stays one string (the fragments joined) for the record; fragments keeps the list
    evidence[id] = {
      quote: fragments ? fragments.join(' ... ') : entry.quote, shown: entry.shown, ...(fragments && fragments.length > 1 && { fragments }), ...(note && { note }),
    };
  });
  const known = new Set((findings || []).map((f) => f.id));
  const contradicted = (Array.isArray(parsed.contradicted) ? parsed.contradicted : [])
    .filter((entry) => entry && known.has(entry.id) && typeof entry.quote === 'string' && squash(entry.quote) && haystack.includes(squash(entry.quote)))
    .map((entry) => ({ id: entry.id, quote: entry.quote.slice(0, 300) }));
  const addressed = (Array.isArray(parsed.addressed) ? parsed.addressed : []).filter((id) => typeof id === 'string' && known.has(id));
  return { ok: true, missing: verdict.missing, evidence, manipulation: parsed.manipulation === true, contradicted, addressed };
}

async function checkAnswer({ converseFn, modelId, mainQuestion, rubric, answer, exchange, codeStatus, observed, findings, mode }) {
  const rec = recorder('check', modelId);
  const everything = exchange && exchange.length ? exchange.map((part) => part.answer).join('\n') : answer;
  const messages = [{ role: 'user', content: [{ text: buildCheckMessage({ mainQuestion, rubric, answer, exchange, codeStatus, observed, findings }) }] }];
  let retried = false;
  let verdict = { ok: false, error: 'no reply' };
  let reply = '';
  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await rec.ask(converseFn, { system: systemFor(mode).check, messages, maxTokens: CHECK_MAX_TOKENS });
      reply = result.text;
      verdict = validateCheckV6(result.text, rubric, everything, findings);
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
  if (verdict.ok) {
    return {
      ok: true, missing: verdict.missing, evidence: verdict.evidence, manipulation: verdict.manipulation,
      contradicted: verdict.contradicted, addressed: verdict.addressed, retried, calls: rec.calls, usage: rec.total,
    };
  }
  return { ok: false, error: verdict.error, reply, retried, calls: rec.calls, usage: rec.total };
}

/**
 * The evidence after a follow-up answer: what the earlier checks showed stays shown (with its quote); an item the new check shows gets
 * `viaFollowUp` when its quote is in a follow-up answer, and `afterHint` when the follow-up that was answered was a hint. An item the new
 * check does not show keeps its partial quote and note, if any.
 * @param previous { evidence, missing, isHint } as recorded on the host turn that asked the follow-up (the check of the answer before)
 */
function mergeEvidence({ rubric, previous, checked, followUpText, afterHint }) {
  const ids = rubric.map((item) => item.id);
  const prevMissing = previous && Array.isArray(previous.missing) ? previous.missing : ids;
  const follow = squash(followUpText || '');
  const evidence = {};
  ids.forEach((id) => {
    if (!prevMissing.includes(id)) {
      evidence[id] = { ...((previous && previous.evidence && previous.evidence[id]) || { quote: '' }), shown: true };
      return;
    }
    const now = checked.evidence[id];
    const pieces = now.fragments || [now.quote];
    const inFollowUp = now.shown && follow && pieces.some((piece) => squash(piece) && follow.includes(squash(piece)));
    evidence[id] = { ...now, ...(inFollowUp && { viaFollowUp: true, ...(afterHint && { afterHint: true }) }) };
  });
  return { evidence, missing: ids.filter((id) => !evidence[id].shown) };
}

// --- step B --------------------------------------------------------------------------------------------------------------

/** The target of a follow-up: { type: 'rubric', id } or { type: 'finding', id, finding }. */
function targetLines(target) {
  if (target.type === 'finding') {
    return [`Target: finding ${target.id}`, `Why this is the target: ${target.why || 'a finding about the code'}`];
  }
  return [`Target: ${target.id}`];
}

function buildWriteMessage({ code, turns, mainQuestion, rubric, missing, codeStatus, observed, noUsableAnswer, findings, target }) {
  const trimmed = code.length > MAX_CODE_CHARS ? `${code.slice(0, MAX_CODE_CHARS)}\n// [code truncated]` : code;
  const transcript = turns.slice(-MAX_TRANSCRIPT_TURNS).map((turn) => (
    turn.role === 'student' ? `<student_answer>\n${neutralise(turn.text)}\n</student_answer>` : `[host] ${turn.text}`
  )).join('\n');
  const aim = target || { type: 'rubric', id: missing[0] };
  return [
    '<student_code>',
    neutralise(trimmed),
    '</student_code>',
    `Code status: ${describeCodeStatus(codeStatus)}`,
    ...observedLines(observed),
    ...findingLines(findings),
    `Main question: ${mainQuestion}`,
    'Rubric (private):',
    ...rubric.map((item) => `- ${item.id}: ${item.text}`),
    '<transcript>',
    transcript,
    '</transcript>',
    `Missing items: ${missing.length ? missing.join(', ') : 'none'}`,
    ...targetLines(aim),
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

/**
 * Why a follow-up cannot be used, or null: it is empty or too long, it has the word rubric, it repeats rubric wording, or (rule 3) it
 * states the content of an item the student has not shown yet ('gives_away').
 */
function problemWith(question, secrets, { notShown = [], mainQuestion = '' } = {}) {
  if (!question || question.length > MAX_FOLLOW_UP_LENGTH) return 'question_invalid';
  if (/\b(rubric|criteria|criterion)\b/i.test(question)) return 'rubric_word';
  if (leaksCriterion(question, secrets)) return 'rubric_leak';
  if (givesAwayItem(question, notShown, mainQuestion)) return 'gives_away';
  return null;
}

async function writeFollowUp({
  converseFn, modelId, code, turns, mainQuestion, rubric, missing, criteria = [], codeStatus, observed, noUsableAnswer = false, findings, target, mode,
}) {
  const rec = recorder('write', modelId);
  const secrets = [...criteria, ...rubric.map((item) => item.text)];
  // Only the items that are not shown yet are protected from being stated: a shown item was the student's own words.
  const guard = { notShown: rubric.filter((item) => missing.includes(item.id)), mainQuestion };
  const messages = [{ role: 'user', content: [{ text: buildWriteMessage({ code, turns, mainQuestion, rubric, missing, codeStatus, observed, noUsableAnswer, findings, target }) }] }];
  const repairs = [];
  let guardRecord = null;
  let last = '';

  const call = async (request) => {
    const convo = request
      ? [...messages, { role: 'assistant', content: [{ text: last }] }, { role: 'user', content: [{ text: request }] }]
      : messages;
    const result = await rec.ask(converseFn, { system: systemFor(mode).write, messages: convo, maxTokens: WRITE_MAX_TOKENS });
    last = result.text;
    return parseWrite(result.text);
  };
  const done = (extra) => ({ repairs, ...(guardRecord && { guard: guardRecord }), calls: rec.calls, usage: rec.total, ...extra });
  const fail = (error) => done({ ok: false, error, reply: last });
  const problem = (question) => problemWith(question, secrets, guard);

  try {
    let reply = await call();
    if (!reply) {
      reply = await call(REQUESTS.json);
      repairs.push({ type: 'json_retry', fixed: !!reply });
      if (!reply) return fail('bad_json');
    }
    let found = problem(reply.question);
    if (found === 'rubric_leak' || found === 'gives_away') {
      const original = reply.question;
      const again = await call(found === 'gives_away' ? REQUESTS.giveAway : REQUESTS.leak);
      const fixed = !!again && !problem(again.question);
      repairs.push({ type: found === 'gives_away' ? 'give_away_rewrite' : 'leak_rewrite', original, fixed });
      if (fixed) { reply = again; found = null; }
    }
    if (found) return fail(found);
    if (isYesNo(reply.question)) {
      const original = reply.question;
      const again = await call(REQUESTS.yesNo);
      const fixed = !!again && !isYesNo(again.question) && !problem(again.question);
      repairs.push({ type: 'yes_no_rewrite', original, fixed });
      if (!fixed) return fail('yes_no');
      reply = again;
    }
    if (isMultiPart(reply.question)) {
      guardRecord = { fired: true, original: reply.question, fixedByRetry: false };
      let again = null;
      try {
        again = await call(REQUESTS.twoQuestions);
      } catch (error) {
        if (!unavailable(error)) throw error;
        guardRecord.retryFailed = true;
      }
      if (again && !isMultiPart(again.question) && !isYesNo(again.question) && !problem(again.question)) {
        guardRecord.fixedByRetry = true;
        reply = again;
      } else {
        reply = { ...reply, question: firstQuestionOnly(reply.question) };
      }
    }
    return done({ ok: true, question: reply.question, isHint: reply.isHint });
  } catch (error) {
    if (!unavailable(error)) throw error;
    if (guardRecord) guardRecord.retryFailed = true;
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

/** What the student has said so far about the current main question: the main answer, then the answers to follow-ups (flagged ones are left out). */
function exchangeOf(turns, latestFlagged) {
  const lastMain = turns.map((t) => t.role === 'host' && t.kind === 'main').lastIndexOf(true);
  const rest = turns.slice(lastMain + 1);
  const out = [];
  let pending = null;
  let first = true;
  rest.forEach((turn, i) => {
    if (turn.role === 'host') { pending = turn.text; return; }
    const isLatest = lastMain + 1 + i === turns.length - 1;
    const flagged = isLatest ? latestFlagged : !!(rest[i + 1] && rest[i + 1].manipulation);
    // the answer to the main question has no follow-up question in front of it
    if (!flagged) out.push({ question: first ? null : pending, answer: turn.text });
    first = false;
  });
  return out;
}

/** The finding to aim at, by the order: (1) one the answer contradicts, (2) a missing rubric item, (3) a related bug or risk the answer did not address. */
function chooseTarget({ findings, askedFindings, checked, missing }) {
  const open = (findings || []).filter((f) => !askedFindings.includes(f.id));
  const contradiction = ((checked && checked.contradicted) || []).find((c) => open.some((f) => f.id === c.id));
  if (contradiction) {
    const finding = open.find((f) => f.id === contradiction.id);
    return { type: 'finding', id: finding.id, finding, why: `the student's answer ("${contradiction.quote}") does not match what the program printed`, reason: `answer contradicts finding ${finding.id}` };
  }
  if (missing.length) return { type: 'rubric', id: missing[0], reason: `${missing.join(', ')} not shown; asked about ${missing[0]}` };
  const addressed = (checked && checked.addressed) || [];
  const unaddressed = open.find((f) => (f.kind === 'bug' || f.kind === 'risk') && !addressed.includes(f.id));
  if (unaddressed) {
    return { type: 'finding', id: unaddressed.id, finding: unaddressed, why: 'a finding about the code that the answer did not mention', reason: `finding ${unaddressed.id} not addressed` };
  }
  return null;
}

/**
 * After a follow-up answer with no follow-up left: check it (no write) and return what the engine records. Never changes the action.
 * @returns {{ evidence?, missing?, calls, usage, repairs, manipulation? }}
 */
async function checkOnly({ converseFn, models, mainQuestion, rubric, turns, observed, codeStatus, findings, mode }) {
  const out = { calls: [], usage: { inputTokens: 0, outputTokens: 0, latencyMs: 0 }, repairs: [] };
  const exchange = exchangeOf(turns, false);
  const lastHost = [...turns].reverse().find((t) => t.role === 'host');
  const previous = lastHost ? { evidence: lastHost.evidence, missing: lastHost.missing, isHint: lastHost.isHint } : null;
  const checked = await checkAnswer({
    converseFn, modelId: models.checker, mainQuestion, rubric, answer: exchange.length ? exchange[exchange.length - 1].answer : '', exchange,
    codeStatus, observed, findings, mode,
  });
  out.calls.push(...checked.calls);
  out.usage = checked.usage;
  if (checked.retried) out.repairs.push({ type: 'check_retry', fixed: !!checked.ok });
  if (!checked.ok) {
    out.repairs.push({ type: 'followup_check_failed', fixed: false });
    return out;
  }
  const followText = exchange.slice(1).map((part) => part.answer).join('\n');
  const merged = mergeEvidence({ rubric, previous, checked, followUpText: followText, afterHint: !!(lastHost && lastHost.isHint) });
  out.evidence = merged.evidence;
  out.missing = merged.missing;
  if (checked.manipulation) out.manipulation = { kind: 'model', quote: String(exchange[exchange.length - 1].answer).slice(0, 300), source: 'model' };
  return out;
}

/**
 * The check and (when something is missing) the write for one answer.
 * @param flag  the engine's own manipulation finding for this answer ({ kind, quote, source }) or null
 * @param findings  host.v7 only: the code findings of this main question (an array, maybe empty); null for host.v6
 * @param asked     the ids of the findings an earlier follow-up of this main question already aimed at
 * @returns {{ decision, fallback, rejected, repairs, guard, calls, usage, evidence, manipulation, retried }}
 *          decision is null when the models failed (fallback is then 'model_unavailable' or 'invalid_output')
 */
async function decide({ converseFn, models, code, turns, mainQuestion, rubric, criteria, answer, observed, codeStatus, flag, nextMain, findings = null, asked = [], mode = 'v6' }) {
  const out = { decision: null, fallback: null, rejected: null, repairs: [], guard: null, calls: [], usage: { inputTokens: 0, outputTokens: 0, latencyMs: 0 }, evidence: null, manipulation: flag || null };
  const addUsage = (u) => {
    out.usage = { inputTokens: out.usage.inputTokens + u.inputTokens, outputTokens: out.usage.outputTokens + u.outputTokens, latencyMs: out.usage.latencyMs + u.latencyMs };
  };
  const ids = rubric.map((item) => item.id);
  const lastHost = [...turns].reverse().find((t) => t.role === 'host');
  // An answer after the first one of this main question answers a follow-up: the evidence of the answer before it stays.
  const isFollowUpAnswer = !!lastHost && lastHost.kind === 'follow_up';
  const previous = isFollowUpAnswer ? { evidence: lastHost.evidence, missing: lastHost.missing, isHint: lastHost.isHint } : null;
  const prevMissing = previous && Array.isArray(previous.missing) ? previous.missing : ids;
  let missing;
  let checked = null;

  if (flag) {
    // Never sent to a model: no new evidence.
    missing = prevMissing;
  } else {
    const exchange = exchangeOf(turns, false);
    checked = await checkAnswer({
      converseFn, modelId: models.checker, mainQuestion, rubric, answer, exchange, codeStatus, observed, findings, mode,
    });
    out.calls.push(...checked.calls);
    addUsage(checked.usage);
    if (checked.retried) out.repairs.push({ type: 'check_retry', fixed: !!checked.ok });
    if (checked.unavailable) { out.fallback = 'model_unavailable'; return out; }
    if (!checked.ok) {
      out.fallback = 'invalid_output';
      out.rejected = { code: 'check_invalid', reply: `${checked.error}: ${checked.reply}` };
      return out;
    }
    const followText = exchange.slice(1).map((part) => part.answer).join('\n');
    const merged = isFollowUpAnswer
      ? mergeEvidence({ rubric, previous, checked, followUpText: followText, afterHint: !!(lastHost && lastHost.isHint) })
      : { evidence: checked.evidence, missing: checked.missing };
    out.evidence = merged.evidence;
    if (checked.manipulation) {
      out.manipulation = { kind: 'model', quote: String(answer).slice(0, 300), source: 'model' };
      missing = prevMissing;
    } else {
      missing = merged.missing;
    }
  }

  if (checked && !out.manipulation) {
    // host.v7: what the checker said about the findings (recorded for the instructor and the evaluation)
    if (checked.contradicted && checked.contradicted.length) out.contradicted = checked.contradicted;
    if (checked.addressed && checked.addressed.length) out.addressed = checked.addressed;
  }
  const target = chooseTarget({ findings, askedFindings: asked, checked: out.manipulation ? null : checked, missing });
  if (!target) {
    out.decision = { action: nextMain ? 'next_main' : 'end', question: '', reason: 'check: every rubric item is shown; no follow-up needed', missing, target: null, isHint: false };
    return out;
  }

  const flagged = !!out.manipulation;
  const giveUp = flagged && isGiveUpKind(out.manipulation.kind);
  const written = await writeFollowUp({
    converseFn, modelId: models.writer, code, turns: maskFlaggedAnswers(turns, flagged), mainQuestion, rubric, missing, criteria, codeStatus, observed,
    noUsableAnswer: flagged, findings, target, mode,
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
      ? `check: answer flagged (${out.manipulation.kind}), counted as no evidence; asked about ${target.id}`
      : `check: ${target.reason}`,
    missing,
    target: target.id,
    ...(target.type === 'finding' && { targetKind: 'finding' }),
    isHint: giveUp || written.isHint,
  };
  return out;
}

module.exports = {
  DEFAULT_SPLIT_MODEL, CHECK_PROMPT_VERSION, WRITE_PROMPT_VERSION, CHECK_PROMPT_VERSION_V7, WRITE_PROMPT_VERSION_V7,
  CHECK_SYSTEM, WRITE_SYSTEM, CHECK_SYSTEM_V7, WRITE_SYSTEM_V7, REQUESTS, WITHHELD,
  resolveSplitModels, checkAnswer, writeFollowUp, decide, checkOnly, mergeEvidence, exchangeOf, chooseTarget, findingLines, problemWith,
  buildCheckMessage, buildWriteMessage, validateCheckV6, maskFlaggedAnswers, observedLines, squash,
};
