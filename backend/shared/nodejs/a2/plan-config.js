/**
 * The A2 pilot interview's questions, taken from a student's plan (built by backend/scripts/a2-import/plan.js and stored on the
 * ImportedSubmissions record as `plan`). The plan decides everything that is asked; nothing here calls a model or runs code.
 *
 * What is stored on an interview is the plan WITHOUT the GitHub username (stripPlan) and a per-question log (initialLog). The username
 * never goes into an interview record, a log line or a model request.
 */
const { ValidationError } = require('../utils/errors');

const SOURCE = 'a2-pilot';
const PROMPT_VERSION = 'host.a2';
const THEME_ID = 'code';
const THEME_TITLE = 'Questions about your code';

/** A copy of the plan with every field that identifies a student removed. */
function stripPlan(plan) {
  const { githubUsername: _name, ...rest } = JSON.parse(JSON.stringify(plan));
  return rest;
}

/** The questions that are asked, in plan order. A function that cannot be asked ('unaskable') is left out. */
const askable = (plan) => (plan && Array.isArray(plan.questions) ? plan.questions.filter((q) => q.kind !== 'unaskable' && typeof q.text === 'string' && q.text.trim()) : []);

/** The plan of a record, or a ValidationError when this record has none (no code to ask about, or the plan was never built). */
function planOf(record) {
  const plan = record && record.plan;
  if (!plan || plan.noPlan || askable(plan).length === 0) throw new ValidationError('This imported submission has no interview plan');
  return plan;
}

/**
 * The interview config an interview of this plan runs with: the assessment's settings (time limit, source, follow-up budget) and the
 * plan's questions word for word as one theme. The follow-up budget is always one per main question.
 */
function buildConfig(assessmentInterview, plan) {
  return {
    enabled: true,
    interviewOnly: true,
    source: (assessmentInterview && assessmentInterview.source) || SOURCE,
    timeLimitMinutes: (assessmentInterview && assessmentInterview.timeLimitMinutes) || 20,
    maxFollowUpsPerMainQuestion: 1,
    promptVersion: PROMPT_VERSION,
    themes: [{ id: THEME_ID, title: THEME_TITLE, mainQuestions: askable(plan).map((q) => q.text.trim()), criteria: [] }],
  };
}

/** The reference solution's value at the question's stop (tracing) or the specification's answer, as the plan recorded it. */
function specAnswerOf(plan, q) {
  if (q.kind === 'predict') return q.spec === undefined ? null : q.spec;
  if (q.kind === 'tracing') {
    const stops = plan.referenceAnswers && q.input && plan.referenceAnswers[q.input.cmd] ? plan.referenceAnswers[q.input.cmd].refStops : null;
    return Array.isArray(stops) && stops[q.k - 1] !== undefined ? stops[q.k - 1] : null;
  }
  return q.answerKey === undefined ? null : q.answerKey;
}

/**
 * What is logged for every main question, filled in as the interview goes (C7): type, input, K, line, targeted, traceDiffersFromReference,
 * the answer from the code (set when the interview is prepared), the spec answer, the student's answer, the check, the follow-up and its
 * result, and the mismatch flag.
 */
function initialLog(plan) {
  return askable(plan).map((q, i) => ({
    index: i + 1,
    function: q.function,
    type: q.kind,
    input: q.input ? q.input.cmd : null,
    k: q.kind === 'tracing' ? q.k : null,
    line: q.line === undefined ? null : q.line,
    targeted: q.targeted === undefined ? null : q.targeted,
    traceDiffersFromReference: q.kind === 'tracing' ? q.traceDiffersFromReference === true : null,
    planAnswer: q.kind === 'predict' || q.kind === 'tracing' ? (q.answer === undefined ? null : q.answer) : null,
    answerFromCode: null,
    answerSource: null,
    specAnswer: specAnswerOf(plan, q),
    mismatch: null,
    studentAnswer: null,
    check: null,
    followUp: null,
  }));
}

/** The text a student sees for "the answer is X" when a value check asks the model: the code's own answer, in the plan's words. */
const displayValue = (q, truth) => (truth === null || truth === undefined ? '' : String(truth));

module.exports = { stripPlan, askable, planOf, buildConfig, initialLog, specAnswerOf, displayValue, SOURCE, PROMPT_VERSION, THEME_ID };
