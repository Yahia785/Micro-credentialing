/**
 * The A2 pilot interview's questions, taken from a student's plan (version 3, the case design; built by backend/scripts/a2-import/plan.js and
 * stored on the ImportedSubmissions record as `plan`). The plan decides everything that is asked; nothing here calls a model or runs code.
 *
 * What is stored on an interview is the plan WITHOUT the GitHub username (stripPlan) and a per-function log (initialLog). The username
 * never goes into an interview record, a log line or a model request.
 */
const { ValidationError } = require('../utils/errors');

const SOURCE = 'a2-pilot';
const PROMPT_VERSION = 'host.a2';
const THEME_ID = 'code';
const THEME_TITLE = 'Questions about your code';
const PLAN_VERSION = 3;

/** A copy of the plan with every field that identifies a student removed. */
function stripPlan(plan) {
  const { githubUsername: _name, ...rest } = JSON.parse(JSON.stringify(plan));
  return rest;
}

/** The questions that are asked, in plan order. A function that cannot be asked ('unaskable') is left out. */
const askable = (plan) => (plan && Array.isArray(plan.questions) ? plan.questions.filter((q) => q.kind !== 'unaskable' && typeof q.text === 'string' && q.text.trim()) : []);

/** The plan of a record, or a ValidationError when this record has none or has one from an older design. */
function planOf(record) {
  const plan = record && record.plan;
  if (!plan || plan.noPlan || askable(plan).length === 0) throw new ValidationError('This imported submission has no interview plan');
  if (plan.version !== PLAN_VERSION) throw new ValidationError('This imported submission has a plan from an older design: run plan.js again');
  return plan;
}

/**
 * The interview config an interview of this plan runs with: the assessment's settings (time limit, source) and the main questions word for
 * word as one theme (the follow-ups come from the plan's cases, not from the config).
 */
function buildConfig(assessmentInterview, plan) {
  return {
    enabled: true,
    interviewOnly: true,
    source: (assessmentInterview && assessmentInterview.source) || SOURCE,
    timeLimitMinutes: (assessmentInterview && assessmentInterview.timeLimitMinutes) || 20,
    maxFollowUpsPerMainQuestion: 2,
    promptVersion: PROMPT_VERSION,
    themes: [{ id: THEME_ID, title: THEME_TITLE, mainQuestions: askable(plan).map((q) => q.text.trim()), criteria: [] }],
  };
}

/** What the log says about the kind of a question: 'logic' (with or without follow-ups) or 'compile'. */
const isCompile = (q) => q.kind === 'compileError' || q.kind === 'compileErrorOutside';

/** The first step of a function's path: the main question as the plan has it. */
function mainStep(q) {
  const compile = isCompile(q);
  return {
    step: 'main', kind: compile ? 'compile' : 'logic', type: compile ? q.kind : 'logic', text: q.text,
    expected: q.answerKey, expectedSource: compile ? 'compiler' : 'spec', studentAnswer: null, result: null,
  };
}

/**
 * What is logged for every function (C8): its case, the path (each question asked with its kind, expected answer and its source, the
 * student's answer, the result and the quote), the runtime truth of the prepared code answers, and the final label.
 */
function initialLog(plan) {
  return askable(plan).map((q, i) => ({
    index: i + 1,
    function: q.function,
    ...(q.replaces ? { replaces: q.replaces } : {}),
    kind: q.kind,
    hasFollowUps: Boolean(q.cases),
    codeRight: q.codeRight === undefined ? null : q.codeRight,
    logicRight: null,
    case: null,
    clarified: false,
    path: i === 0 ? [mainStep(q)] : [],
    truth: {},
    label: null,
    done: false,
  }));
}

module.exports = { stripPlan, askable, planOf, buildConfig, initialLog, mainStep, isCompile, SOURCE, PROMPT_VERSION, THEME_ID, PLAN_VERSION };
