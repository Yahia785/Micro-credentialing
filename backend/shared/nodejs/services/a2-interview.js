/**
 * The interview-only flow of the A2 pilot (prompt version host.a2): the questions, the correct / wrong check and the follow-up come
 * from a student's plan. interview-service.js does the storage and the timing; this file decides what happens after each answer.
 *
 * Per main question: the student answers; the answer is checked (a2/check.js: a plain comparison with the code's answer, the checker
 * model only when that is not clear); a correct answer gets the plan's fixed follow-up (when there is one), a wrong or unclear one gets ONE
 * agent-written follow-up (a2/follow-up.js, never the answer); the answer to a follow-up is checked and logged and never gets another follow-up.
 *
 * The interview record holds the importId, the form, the plan WITHOUT the GitHub username (a2Plan) and the per-question log (a2Log).
 * Nothing here logs answers, questions, code or model replies.
 */
const engine = require('../agent/interview-engine');
const splitV6 = require('../agent/split-agent-v6');
const bedrock = require('../agent/bedrock-client');
const planConfig = require('../a2/plan-config');
const { checkMainAnswer, checkFixedFollowUp, VERDICT } = require('../a2/check');
const { fixedFollowUpFor, writeAgentFollowUp, SOURCE } = require('../a2/follow-up');
const { ValidationError } = require('../utils/errors');

const trimmed = (text) => String(text === null || text === undefined ? '' : text).trim();

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

/** What the log says the code answers for a question: the runtime result, else the plan's own answer. */
function truthOf(entry) {
  if (entry.answerFromCode !== null && entry.answerFromCode !== undefined) return entry.answerFromCode;
  return entry.planAnswer === undefined ? null : entry.planAnswer;
}

const sumUsage = (...parts) => parts.reduce((total, u) => (u ? {
  inputTokens: total.inputTokens + (u.inputTokens || 0), outputTokens: total.outputTokens + (u.outputTokens || 0), latencyMs: total.latencyMs + (u.latencyMs || 0),
} : total), { inputTokens: 0, outputTokens: 0, latencyMs: 0 });

/** The check as it is logged: the verdict, the quote it relies on, how it was decided. */
const logCheck = (result) => ({
  verdict: result.verdict,
  ...(result.quote && { quote: result.quote }),
  method: result.method,
  modelUsed: result.modelUsed === true,
  ...(result.note && { note: result.note }),
});

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
  if (!q || !meta.a2Log || !meta.a2Log[index]) throw new ValidationError('This interview is in an inconsistent state');
  const log = meta.a2Log.map((entry) => ({ ...entry }));
  const entry = log[index];
  const models = { checker: meta.checkerModelId || splitV6.resolveSplitModels().checker, writer: meta.writerModelId || splitV6.resolveSplitModels().writer };
  const answeringFollowUp = meta.followUpCount > 0;
  let usage = sumUsage();
  const hostFields = {};

  if (!answeringFollowUp) {
    // The prepare step did not give a runtime answer (it failed, or was skipped): the plan's own answer is used, and the log says so.
    if ((q.kind === 'predict' || q.kind === 'tracing') && (entry.answerFromCode === null || entry.answerFromCode === undefined)) {
      entry.answerFromCode = entry.planAnswer;
      entry.answerSource = entry.planAnswer === null ? null : 'plan';
      if (!entry.mismatch) entry.mismatch = { kind: 'runtime_unavailable', planAnswer: entry.planAnswer, runtimeAnswer: null };
    }
    const truth = truthOf(entry);
    const result = await checkMainAnswer({ q, truth, answer: trimmed(answer), converseFn, modelId: models.checker, code });
    usage = sumUsage(usage, result.usage);
    entry.studentAnswer = trimmed(answer);
    entry.check = logCheck(result);

    if (result.verdict === VERDICT.CORRECT) {
      const fixed = fixedFollowUpFor(q);
      if (fixed) {
        entry.followUp = { source: SOURCE.FIXED, text: fixed.text, answerKey: fixed.answerKey, studentAnswer: null, check: null };
        return stepFollowUp({ log, meta, text: fixed.text, reason: 'check: correct; asked the fixed follow-up', usage, hostFields: { fixedFollowUp: true } });
      }
      entry.followUp = { source: null, skipped: 'none for this kind of question' };
      return stepOn({ log, meta, asked, usage, reason: 'check: correct; no follow-up for this question; moved on' });
    }

    // wrong or unclear: one follow-up from the agent, to find where the reasoning went off
    const written = await writeAgentFollowUp({ converseFn, writerModelId: models.writer, code, turns, q, truth });
    usage = sumUsage(usage, written.usage);
    if (written.ok) {
      entry.followUp = { source: SOURCE.AGENT, text: written.text, isHint: written.isHint, studentAnswer: null, check: null };
      if (written.repairs.length) hostFields.repairs = written.repairs;
      return stepFollowUp({ log, meta, text: written.text, reason: `check: ${result.verdict}; asked an agent follow-up`, usage, hostFields: { ...hostFields, isHint: written.isHint } });
    }
    entry.followUp = { source: SOURCE.AGENT, skipped: written.reason };
    return stepOn({ log, meta, asked, usage, reason: `check: ${result.verdict}; no follow-up could be written (${written.reason}); moved on` });
  }

  // the answer to the follow-up: a simple correct / wrong, logged, and never another follow-up
  const followUp = entry.followUp || {};
  let result;
  if (followUp.source === SOURCE.FIXED) {
    result = await checkFixedFollowUp({ followUp: { question: followUp.text, answerKey: followUp.answerKey }, answer: trimmed(answer), converseFn, modelId: models.checker });
  } else {
    // an agent follow-up has no answer key of its own: the answer is checked against the same answer as the main question
    result = await checkMainAnswer({ q, truth: truthOf(entry), answer: trimmed(answer), converseFn, modelId: models.checker, code });
  }
  usage = sumUsage(usage, result.usage);
  entry.followUp = { ...followUp, studentAnswer: trimmed(answer), check: logCheck(result) };
  return stepOn({ log, meta, asked, usage, reason: 'engine: the follow-up was answered; moved on' });
}

function stepFollowUp({ log, meta, text, reason, usage, hostFields }) {
  return {
    action: engine.ACTIONS.FOLLOW_UP, question: text, kind: 'follow_up', reason, log, usage, hostFields,
    state: { themeIndex: 0, mainIndex: meta.mainIndex, followUpCount: 1, fallbackCount: meta.fallbackCount || 0 },
  };
}

function stepOn({ log, meta, asked, usage, reason }) {
  const next = meta.mainIndex + 1;
  if (next < asked.length) {
    return {
      action: engine.ACTIONS.NEXT_MAIN, question: asked[next].text.trim(), kind: 'main', reason, log, usage, hostFields: {},
      state: { themeIndex: 0, mainIndex: next, followUpCount: 0, fallbackCount: meta.fallbackCount || 0 },
    };
  }
  return {
    action: engine.ACTIONS.END, question: '', kind: null, reason: reason.replace(/moved on$/, 'ended'), log, usage, hostFields: {},
    state: { themeIndex: 0, mainIndex: meta.mainIndex, followUpCount: meta.followUpCount, fallbackCount: meta.fallbackCount || 0 },
  };
}

/** The log with the runtime results of the prepare step filled in (runPlan's result, one entry per asked question). */
function applyRuntime(log, results) {
  return log.map((entry, i) => {
    const r = results[i];
    if (!r) return entry;
    return { ...entry, answerFromCode: r.answerFromCode, answerSource: r.answerSource, mismatch: r.mismatch, ...(r.runtimeNote && { runtimeNote: r.runtimeNote }) };
  });
}

module.exports = { isInterviewOnly, assertInterviewOnlyAssessment, newImportedInterview, answerStep, applyRuntime, truthOf };
