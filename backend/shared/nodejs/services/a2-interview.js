/**
 * The interview-only flow of the A2 pilot (prompt version host.a2), the case design. interview-service.js does the storage and the timing;
 * this file decides what happens after each answer.
 *
 * Per function (one logic main question, the same for every student, asked word for word from the plan):
 *   1. The answer is checked against the spec key: a plain comparison, the checker model only when that is not clear. An unclear answer gets
 *      "Can you give the exact result?" once (not a follow-up); if it is still unclear it is logged as unclear and counts as logic wrong.
 *   2. The case: logic result x the plan's codeRight. 1 right/right, 2 logic right/code wrong, 3 logic wrong/code right, 4 both wrong.
 *      codeRight null (no safe input ran) takes the case 4 path.
 *   3. Up to two follow-ups, exactly as the plan prepared them for that case. Each answer is checked by its kind and never gets a follow-up:
 *      code questions (predict, tracing, what-if, case 3) against what their code does (the runtime result of the prepare step; the plan's
 *      answer when it could not be run), the smaller logic question (case 4) against the spec key, "why" and "which line" (case 2) judged by
 *      the checker model, a smaller code step against the private value it asked about. Unclear follow-up answers get no clarify.
 *   4. The smaller code step is the only text the agent writes (a2/follow-up.js). If it cannot write an acceptable one, follow-up 2 is skipped.
 *   5. The function ends with a short label, e.g. "case 2 | why: right | line: wrong".
 * Compile-error and logic-only questions (no code to ask about) have no follow-ups and no clarify; their labels are "compile error: right|wrong"
 * and "no code: right|wrong".
 *
 * The interview record holds the importId, the form, the plan WITHOUT the GitHub username (a2Plan) and the per-function log (a2Log).
 * Nothing here logs answers, questions, code or model replies.
 */
const engine = require('../agent/interview-engine');
const splitV6 = require('../agent/split-agent-v6');
const bedrock = require('../agent/bedrock-client');
const planConfig = require('../a2/plan-config');
const { checkValue, checkMainAnswer, judgeExplanation, VERDICT } = require('../a2/check');
const { writeSmallStep } = require('../a2/follow-up');
const { ValidationError } = require('../utils/errors');

const trimmed = (text) => String(text === null || text === undefined ? '' : text).trim();
const clone = (value) => JSON.parse(JSON.stringify(value));

/** True for an interview of the A2 pilot (the config says so, or the interview was started from an import). */
const isInterviewOnly = (meta) => !!(meta && (meta.interviewOnly === true || (meta.configSnapshot && meta.configSnapshot.interviewOnly === true)));

/** The assessment's interview setup must be an interview-only one. */
function assertInterviewOnlyAssessment(milestone) {
  const config = milestone && milestone.interview;
  if (!config || !config.enabled || config.interviewOnly !== true) throw new ValidationError('This assessment is not an interview-only assessment');
  return config;
}

/** The META item, the first host turn and the API result of a new interview-only interview. The prepare step fills in the rest. */
function newImportedInterview({ interviewId, record, milestone, userId, isPractice, now, runLimits }) {
  const assessmentConfig = assertInterviewOnlyAssessment(milestone);
  const plan = planConfig.stripPlan(planConfig.planOf(record));
  const config = planConfig.buildConfig(assessmentConfig, plan);
  const first = engine.firstQuestion(config);
  const startedAt = new Date(now).toISOString();
  const models = splitV6.resolveSplitModels();
  const meta = {
    interviewId,
    // tied to the import, not to a submission: there is no submissionId, and the GitHub username is never stored
    importId: record.importId,
    form: plan.form || null,
    interviewOnly: true,
    source: config.source,
    userId,
    milestoneId: milestone.milestoneId,
    status: 'in_progress',
    isPractice,
    startedAt,
    endedAt: null,
    endReason: null,
    deadline: null, // the clock starts when the interview is ready (see prepareImported)
    prepareStatus: 'preparing',
    modelId: bedrock.resolveModelId(),
    checkerModelId: models.checker,
    writerModelId: models.writer,
    promptVersion: planConfig.PROMPT_VERSION,
    runLimits,
    themeIndex: first.state.themeIndex,
    mainIndex: first.state.mainIndex,
    followUpCount: first.state.followUpCount,
    fallbackCount: 0,
    turnCount: 1,
    configSnapshot: config,
    a2Plan: plan,
    a2Log: planConfig.initialLog(plan),
  };
  const firstTurn = { role: 'host', text: first.question, themeId: first.themeId, kind: 'main', createdAt: startedAt, reason: 'first main question' };
  return {
    meta, firstTurn,
    result: {
      interviewId, question: first.question, deadline: null, timeLimitMinutes: config.timeLimitMinutes, questionCount: config.themes[0].mainQuestions.length,
      serverNow: startedAt, prepareStatus: 'preparing',
    },
  };
}

const sumUsage = (...parts) => parts.reduce((total, u) => (u ? {
  inputTokens: total.inputTokens + (u.inputTokens || 0), outputTokens: total.outputTokens + (u.outputTokens || 0), latencyMs: total.latencyMs + (u.latencyMs || 0),
} : total), { inputTokens: 0, outputTokens: 0, latencyMs: 0 });

/** The result words of the log: right, partly, wrong, unclear. */
const RESULT = Object.freeze({ [VERDICT.CORRECT]: 'right', [VERDICT.PARTLY]: 'partly', [VERDICT.WRONG]: 'wrong', [VERDICT.UNCLEAR]: 'unclear' });
const SHORT = Object.freeze({ predict: 'predict', tracing: 'trace', whatIf: 'what-if', debug: 'why', change: 'line', smallLogic: 'small logic', smallStep: 'step' });

/** The case of a function: logic result x codeRight. codeRight null (nothing safe was run) takes the case 4 path. */
function routeCase(codeRight, logicRight) {
  if (codeRight === true) return logicRight ? 1 : 3;
  if (codeRight === false) return logicRight ? 2 : 4;
  return 4;
}

const CASE_MEANING = Object.freeze({
  1: 'right idea, right code',
  2: 'right idea, buggy code',
  3: 'wrong idea, right code',
  4: 'wrong idea, buggy code',
});

/** The final label of a function in the fixed short form. */
function labelOf(entry) {
  if (!entry.hasFollowUps) {
    const word = entry.path[0] && entry.path[0].result === 'right' ? 'right' : 'wrong';
    return entry.kind === 'logic' ? `no code: ${word}` : `compile error: ${word}`;
  }
  const parts = entry.path.filter((s) => s.step === 'followUp1' || s.step === 'followUp2').map((s) => `${SHORT[s.type] || s.type}: ${s.skipped ? 'skipped' : s.result}`);
  return `case ${entry.case}${entry.clarified ? ' (clarified)' : ''} | ${parts.length ? parts.join(' | ') : 'no follow-ups'}`;
}

/** What a check says, as it is written on a step of the path. */
const written = (result) => ({
  result: RESULT[result.verdict], method: result.method, modelUsed: result.modelUsed === true,
  ...(result.quote && { quote: result.quote }), ...(result.note && { note: result.note }),
});

/** Check the answer of the step that is open, by its kind. Returns the check result (verdict correct|partly|wrong|unclear). */
async function checkStep({ step, q, entry, code, converseFn, modelId, theirOutputOf }) {
  const answer = step.studentAnswer;
  if (step.kind === 'compile') return checkMainAnswer({ q, truth: null, answer, converseFn, modelId, code });
  if (step.type === 'logic' || step.type === 'smallLogic') return checkValue({ kind: 'predict', expected: step.expected, question: step.type === 'logic' ? q.text : step.text, answer, converseFn, modelId });
  if (step.type === 'debug' || step.type === 'change') {
    const earlier = step.type === 'change' ? ((entry.path.find((s) => s.type === 'debug') || {}).studentAnswer || null) : null;
    return judgeExplanation({
      mode: step.type === 'change' ? 'line' : 'why', question: step.text, code, input: step.input, theirOutput: theirOutputOf(step), specAnswer: step.specAnswer, earlier, answer, converseFn, modelId,
    });
  }
  // predict, tracing, what-if, case 3 predict and smaller steps: a value
  return checkValue({ kind: step.type === 'tracing' ? 'tracing' : 'predict', expected: step.expected, question: step.text, answer, converseFn, modelId });
}

/**
 * The step after one student answer.
 * @param {{ meta: object, turns: object[], answer: string, code: string, converseFn?: Function }} input  `turns` end with the student's answer
 * @returns {Promise<{ action: 'follow_up'|'next_main'|'end', question: string, kind: 'main'|'follow_up'|null, reason: string, log: object[],
 *   state: object, hostFields: object, usage: object }>}
 */
async function answerStep({ meta, turns, answer, code, converseFn = bedrock.converse }) {
  const plan = meta.a2Plan;
  const asked = planConfig.askable(plan);
  const index = meta.mainIndex;
  const q = asked[index];
  const log = clone(meta.a2Log || []);
  const entry = log[index];
  const step = entry && entry.path[entry.path.length - 1];
  if (!q || !entry || !step || step.studentAnswer !== null || step.skipped) throw new ValidationError('This interview is in an inconsistent state');
  const models = { checker: meta.checkerModelId || splitV6.resolveSplitModels().checker, writer: meta.writerModelId || splitV6.resolveSplitModels().writer };
  let usage = sumUsage();
  let calls = [];

  step.studentAnswer = trimmed(answer);
  const theirOutputOf = (s) => s.theirOutput;
  const checked = await checkStep({ step, q, entry, code, converseFn, modelId: models.checker, theirOutputOf });
  usage = sumUsage(usage, checked.usage);
  Object.assign(step, written(checked));

  const state = (over = {}) => ({ themeIndex: 0, mainIndex: index, followUpCount: Math.max(0, entry.path.length - 1), fallbackCount: meta.fallbackCount || 0, ...over });
  const askStep = (next, reason, hostFields = {}) => {
    entry.path.push(next);
    return { action: engine.ACTIONS.FOLLOW_UP, question: next.text, kind: 'follow_up', reason, log, usage, hostFields: { ...hostFields, ...(calls.length && { calls }) }, state: state({ followUpCount: entry.path.length - 1 }) };
  };

  /** The function is over: its label, then the next function's main question or the end. */
  const finish = (reason) => {
    entry.label = labelOf(entry);
    entry.done = true;
    const next = index + 1;
    if (next < asked.length) {
      log[next].path = [planConfig.mainStep(asked[next])];
      return { action: engine.ACTIONS.NEXT_MAIN, question: asked[next].text.trim(), kind: 'main', reason: `${reason}; label: ${entry.label}`, log, usage, hostFields: {}, state: { themeIndex: 0, mainIndex: next, followUpCount: 0, fallbackCount: meta.fallbackCount || 0 } };
    }
    return { action: engine.ACTIONS.END, question: '', kind: null, reason: `${reason}; label: ${entry.label}; ended`, log, usage, hostFields: {}, state: state() };
  };

  /** The follow-up `n` (1 or 2) of the case, as the plan prepared it; follow-up 1 that is not available hands over to follow-up 2. */
  const askNext = async (n) => {
    const co = q.cases[`case${entry.case}`];
    for (let k = n; k <= 2; k += 1) {
      const f = co && co.available ? co[`followUp${k}`] : null;
      if (!f || f.unavailable) continue;
      const base = { step: `followUp${k}`, type: f.type, studentAnswer: null, result: null };
      const truth = entry.truth[`case${entry.case}.followUp${k}`];
      const codeExpected = () => {
        const fromRun = truth && truth.answer !== undefined && truth.answer !== null;
        return { expected: fromRun ? truth.answer : f.answer, expectedSource: fromRun && truth.source === 'runtime' ? 'code' : 'code (plan)', ...(truth && truth.mismatch ? { mismatch: truth.mismatch } : {}), ...(!truth ? { mismatch: { kind: 'runtime_unavailable', plan: f.answer, runtime: null } } : {}) };
      };
      if (f.type === 'predict' || f.type === 'tracing' || f.type === 'whatIf') return askStep({ ...base, kind: 'code', text: f.text, ...codeExpected() }, `case ${entry.case}: asked follow-up ${k} (${f.type})`);
      if (f.type === 'smallLogic') return askStep({ ...base, kind: 'logic', text: f.text, expected: f.answerKey, expectedSource: 'spec' }, `case ${entry.case}: asked follow-up ${k} (smaller logic question)`);
      if (f.type === 'debug') {
        const output = truth && truth.answer !== undefined && truth.answer !== null ? truth.answer : f.theirOutput;
        return askStep({
          ...base, kind: 'code', text: f.text, expected: `the cause of the difference between ${output} and ${f.specAnswer}`, expectedSource: 'model',
          input: f.input.display, theirOutput: output, specAnswer: f.specAnswer, ...(truth && truth.mismatch ? { mismatch: truth.mismatch } : {}),
        }, 'case 2: asked follow-up 1 (why)');
      }
      if (f.type === 'change') {
        const why = entry.path.find((s) => s.type === 'debug') || {};
        return askStep({
          ...base, kind: 'code', text: f.text, expected: 'a line of their function and a change that makes it give the spec answer', expectedSource: 'model',
          input: why.input, theirOutput: why.theirOutput, specAnswer: why.specAnswer,
        }, 'case 2: asked follow-up 2 (which line)');
      }
      if (f.type === 'smallStep') {
        const material = f.material;
        const materialTruth = entry.truth.material;
        if (!material || !material.available) { entry.path.push({ ...base, kind: 'code', skipped: 'no private material for this function' }); continue; }
        const secrets = [];
        const mainTruth = entry.truth['case3.followUp1'];
        if (mainTruth && mainTruth.answer) secrets.push(mainTruth.answer);
        const wrote = await writeSmallStep({ converseFn, modelId: models.writer, code, q, caseNo: entry.case, material, truth: materialTruth && materialTruth.stops ? materialTruth : null, secrets });
        usage = sumUsage(usage, wrote.usage);
        calls = wrote.calls;
        if (!wrote.ok) { entry.path.push({ ...base, kind: 'code', skipped: wrote.reason }); continue; }
        return askStep({
          ...base, kind: 'code', text: wrote.text, expected: wrote.expected, expectedSource: materialTruth && materialTruth.source === 'runtime' ? 'code' : 'code (plan)',
          variable: wrote.variable, expression: wrote.expression, stop: wrote.stop, writtenByAgent: true, ...(materialTruth && materialTruth.mismatch ? { mismatch: materialTruth.mismatch } : {}),
        }, `case ${entry.case}: asked follow-up ${k} (smaller code step, agent-written)`);
      }
    }
    return finish(`case ${entry.case}: no more follow-ups`);
  };

  // ---- the main question and the clarify ---------------------------------------------------------------------------------------
  if (step.step === 'main' || step.step === 'clarify') {
    if (!entry.hasFollowUps) return finish(step.kind === 'compile' ? 'compile-error question answered' : 'logic-only question answered (no code to ask about)');
    if (checked.verdict === VERDICT.UNCLEAR && step.step === 'main') {
      entry.clarified = true;
      return askStep({ step: 'clarify', kind: 'logic', type: 'logic', text: q.clarify, expected: q.answerKey, expectedSource: 'spec', studentAnswer: null, result: null }, 'check: unclear; asked to give the exact result (not a follow-up)', { clarify: true });
    }
    entry.logicRight = checked.verdict === VERDICT.CORRECT;
    entry.case = routeCase(entry.codeRight, entry.logicRight);
    entry.caseMeaning = CASE_MEANING[entry.case];
    if (entry.codeRight === null) entry.caseNote = 'their code is unknown (no safe input ran): case 4 path';
    return askNext(1);
  }
  if (step.step === 'followUp1') return askNext(2);
  return finish(`case ${entry.case}: follow-ups done`);
}

/** The log with the runtime truth of the prepare step filled in (runPlan's result, one entry per asked question). */
function applyRuntime(log, results) {
  return log.map((entry, i) => (results[i] ? { ...entry, truth: results[i].truth } : entry));
}

/** The number of mismatch flags in a log (the runtime differed from the plan, or nothing could be run). */
const mismatchCount = (results) => results.reduce((n, r) => n + Object.values(r.truth || {}).filter((t) => t.mismatch).length, 0);

/** For the scripted run only: put a freshly started interview at one function (its main question is asked next). */
function positionAt(meta, index) {
  const asked = planConfig.askable(meta.a2Plan);
  meta.mainIndex = index;
  meta.followUpCount = 0;
  meta.a2Log.forEach((entry, i) => { if (i >= index) entry.path = i === index ? [planConfig.mainStep(asked[i])] : []; });
  return asked[index].text.trim();
}

module.exports = { isInterviewOnly, assertInterviewOnlyAssessment, newImportedInterview, answerStep, applyRuntime, mismatchCount, labelOf, routeCase, positionAt, CASE_MEANING, RESULT };
