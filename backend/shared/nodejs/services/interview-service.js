/**
 * Interview workflow: start, answer, read.
 *
 * Only IDs, timings, token counts and error names are ever logged here. Never answers,
 * questions, code or criteria.
 */
const interviews = require('../db/interviews');
const { getSubmission } = require('../db/submissions');
const { getMilestone } = require('../db/milestones');
const engine = require('../agent/interview-engine');
const bedrock = require('../agent/bedrock-client');
const split = require('../agent/split-agent');
const view = require('../utils/interview-view');
const log = require('../utils/logger');
const { END_REASONS } = require('../utils/submission-end-reason');
const { AppError, ValidationError, NotFoundError, ForbiddenError } = require('../utils/errors');

const MAX_ANSWER_LENGTH = 2000;
const STATUS = Object.freeze({
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  TIMED_OUT: 'timed_out',
  ABANDONED: 'abandoned',
});

function boundedNumber(value, max, { integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) return null;
  return integer ? Math.floor(value) : value;
}

/** Client timing is advisory data for the instructor: keep only well-formed, bounded numbers. */
function sanitizeClientTiming(raw) {
  const timing = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    firstKeystrokeMs: boundedNumber(timing.firstKeystrokeMs, 3600000),
    pasteCount: boundedNumber(timing.pasteCount, 1000, { integer: true }),
    focusLossCount: boundedNumber(timing.focusLossCount, 1000, { integer: true }),
  };
}

function interviewState(meta) {
  return {
    themeIndex: meta.themeIndex,
    mainIndex: meta.mainIndex,
    followUpCount: meta.followUpCount,
    fallbackCount: meta.fallbackCount || 0,
  };
}

function stateFields(state) {
  return {
    themeIndex: state.themeIndex,
    mainIndex: state.mainIndex,
    followUpCount: state.followUpCount,
    fallbackCount: state.fallbackCount,
  };
}

/** The prompt version for a new interview: the assessment's own setting, else AGENT_PROMPT_VERSION, else the code default. */
function promptVersionFor(config) {
  return engine.resolvePromptVersion(config.promptVersion || undefined);
}

/** The model ids an interview is started with, stored so the interview keeps them even if the environment changes. */
function modelFields(promptVersion) {
  const fields = { modelId: bedrock.resolveModelId() };
  if (engine.usesSplit(promptVersion)) {
    const models = split.resolveSplitModels();
    fields.checkerModelId = models.checker;
    fields.writerModelId = models.writer;
  }
  return fields;
}

/** Build the META item, the first host turn and the API result of a new interview. */
function newInterview({ interviewId, submission, config, userId, isPractice, now }) {
  const first = engine.firstQuestion(config);
  const startedAt = new Date(now).toISOString();
  const deadline = new Date(now + config.timeLimitMinutes * 60000).toISOString();
  const promptVersion = promptVersionFor(config);
  const meta = {
    interviewId,
    submissionId: submission.submissionId,
    userId,
    milestoneId: submission.milestoneId,
    status: STATUS.IN_PROGRESS,
    isPractice,
    startedAt,
    endedAt: null,
    endReason: null,
    deadline,
    ...modelFields(promptVersion),
    promptVersion,
    ...stateFields(first.state),
    turnCount: 1,
    configSnapshot: config,
  };
  const firstTurn = { role: 'host', text: first.question, themeId: first.themeId, kind: first.kind, createdAt: startedAt, reason: 'first main question' };
  return { meta, firstTurn, result: { interviewId, question: first.question, deadline, serverNow: startedAt } };
}

/** The assessment's interview setup for a C++ coding submission, or a ValidationError/NotFoundError. */
async function interviewConfigFor(submission) {
  if (submission.type === 'embedded' || submission.language !== 'cpp') {
    throw new ValidationError('Interviews are only available for C++ coding assessments');
  }
  const milestone = await getMilestone(submission.milestoneId);
  if (!milestone) throw new NotFoundError('Assessment');
  const config = milestone.interview;
  if (milestone.type === 'embedded' || milestone.language !== 'cpp' || !config || !config.enabled) {
    throw new ValidationError('An interview is not enabled for this assessment');
  }
  return config;
}

/**
 * Start the interview for a submission.
 * @returns {Promise<{ interviewId, question, deadline, serverNow }>}
 */
async function startInterview({ userId, submissionId, now = Date.now() }) {
  if (!submissionId || typeof submissionId !== 'string') {
    throw new ValidationError('submissionId is required');
  }

  const submission = await getSubmission(submissionId);
  if (!submission) throw new NotFoundError('Submission');
  if (submission.userId !== userId) {
    throw new ForbiddenError('You can only start an interview for your own submission');
  }

  // A submission with status "grading_failed" still gets its interview: that failure is not the
  // student's fault. A session that ended by leaving the page does not.
  if (submission.endedBy === END_REASONS.LEFT_PAGE) {
    throw new ValidationError('An interview is not available for a session that ended by leaving the page');
  }
  const config = await interviewConfigFor(submission);

  const interviewId = interviews.interviewIdFor(submissionId);
  // Practice interviews are never returned here, so they never block the real one.
  if (await interviews.getInterviewBySubmission(submissionId)) {
    throw new AppError('An interview already exists for this submission', 409);
  }

  const { meta, firstTurn, result } = newInterview({ interviewId, submission, config, userId, isPractice: false, now });
  await interviews.createInterview(meta, firstTurn);

  log.info('Interview started', { interviewId, submissionId, milestoneId: submission.milestoneId });
  return result;
}

/**
 * Admin only (the handler enforces it): start a practice interview on an existing submission's code. Same engine, timing and
 * prompt version as a real one, owned by the admin who started it, marked isPractice. It is not limited by the one interview
 * per submission rule, and getInterviewBySubmission never returns it.
 * @returns {Promise<{ interviewId, question, deadline, serverNow, isPractice: true }>}
 */
async function startPracticeInterview({ userId, submissionId, now = Date.now() }) {
  if (!submissionId || typeof submissionId !== 'string') {
    throw new ValidationError('submissionId is required');
  }
  const submission = await getSubmission(submissionId);
  if (!submission) throw new NotFoundError('Submission');
  const config = await interviewConfigFor(submission);

  const interviewId = interviews.practiceInterviewId();
  const { meta, firstTurn, result } = newInterview({ interviewId, submission, config, userId, isPractice: true, now });
  await interviews.createInterview(meta, firstTurn);

  log.info('Practice interview started', { interviewId, submissionId, milestoneId: submission.milestoneId });
  return { ...result, isPractice: true };
}

/**
 * Store the student's answer and return the next question, or { ended: true }.
 */
/** Milliseconds from a monotonic clock, for measuring how long the agent worked. */
const monotonicMs = () => performance.now();

async function submitAnswer({ userId, interviewId, answer, clientTiming, now = Date.now(), converseFn, clock = monotonicMs }) {
  if (typeof answer !== 'string' || !answer.trim()) throw new ValidationError('answer is required');
  if (answer.length > MAX_ANSWER_LENGTH) {
    throw new ValidationError(`answer must not exceed ${MAX_ANSWER_LENGTH} characters`);
  }

  const meta = await interviews.getInterviewMeta(interviewId);
  if (!meta) throw new NotFoundError('Interview');
  if (meta.userId !== userId) throw new ForbiddenError('You can only answer your own interview');
  if (meta.status !== STATUS.IN_PROGRESS) throw new AppError('This interview has already ended', 409);

  if (now > Date.parse(meta.deadline)) {
    await interviews.endInterview(interviewId, { status: STATUS.TIMED_OUT, endReason: 'deadline_passed', now });
    log.info('Interview timed out', { interviewId });
    return { ended: true, status: STATUS.TIMED_OUT };
  }

  // The answer arrived in time. From here until the next question is ready is the agent's working time: it is added to the
  // deadline below, so the student's clock does not run while they wait.
  const workStartedAt = clock();

  const [turns, submission] = await Promise.all([
    interviews.getInterviewTurns(interviewId),
    getSubmission(meta.submissionId),
  ]);
  if (!submission || turns.length !== meta.turnCount || turns[turns.length - 1].role !== 'host') {
    throw new AppError('This interview is in an inconsistent state', 409);
  }

  const asked = turns[turns.length - 1];
  const studentTurn = {
    role: 'student',
    text: answer.trim(),
    themeId: asked.themeId,
    kind: asked.kind,
    createdAt: new Date(now).toISOString(),
    clientTiming: sanitizeClientTiming(clientTiming),
  };

  const config = meta.configSnapshot;
  const decision = await engine.decideNext({
    config,
    state: interviewState(meta),
    code: submission.code || '',
    turns: [...turns, studentTurn],
    modelId: meta.modelId,
    // host.v5: the checker and writer the interview started with (absent on older interviews: the environment decides).
    ...(meta.checkerModelId && { checkerModelId: meta.checkerModelId }),
    ...(meta.writerModelId && { writerModelId: meta.writerModelId }),
    // An interview keeps the prompt version it started with.
    promptVersion: meta.promptVersion,
    ...(converseFn && { converseFn }),
  });

  // The student's answer is always stored, even when the model failed and we fell back.
  const logFields = {
    interviewId,
    action: decision.action,
    fallback: decision.fallback,
    latencyMs: decision.usage.latencyMs,
    inputTokens: decision.usage.inputTokens,
    outputTokens: decision.usage.outputTokens,
  };

  if (decision.action === engine.ACTIONS.END) {
    await interviews.appendTurns({
      interviewId,
      expectedTurnCount: meta.turnCount,
      turns: [studentTurn],
      metaUpdates: {
        ...stateFields(decision.state),
        status: STATUS.COMPLETED,
        endedAt: new Date(now).toISOString(),
        endReason: 'completed',
        // Why the Host ended it, for the instructor: what the engine did, and what the model said.
        endDetail: {
          reason: decision.reason,
          ...(decision.modelReason && { modelReason: decision.modelReason }),
          ...(decision.fallback && { fallback: decision.fallback }),
          ...engine.recordFields(decision),
        },
      },
      now,
    });
    log.info('Interview completed', logFields);
    return { ended: true, status: STATUS.COMPLETED };
  }

  // Exactly the time spent producing the next question (database reads and model calls included).
  const addedMs = Math.max(0, Math.round(clock() - workStartedAt));
  const deadline = new Date(Date.parse(meta.deadline) + addedMs).toISOString();

  const hostTurn = {
    role: 'host',
    text: decision.question,
    themeId: decision.themeId,
    kind: decision.kind,
    reason: decision.reason,
    ...(decision.modelReason && { modelReason: decision.modelReason }),
    ...(decision.fallback && { fallback: decision.fallback }),
    ...engine.recordFields(decision),
    latencyMs: decision.usage.latencyMs,
    inputTokens: decision.usage.inputTokens,
    outputTokens: decision.usage.outputTokens,
    createdAt: new Date().toISOString(),
  };
  await interviews.appendTurns({
    interviewId,
    expectedTurnCount: meta.turnCount,
    turns: [studentTurn, hostTurn],
    metaUpdates: { ...stateFields(decision.state), deadline, extraTimeMs: (meta.extraTimeMs || 0) + addedMs },
    now,
  });
  log.info('Interview answer processed', { ...logFields, addedMs });
  return { question: decision.question, deadline, serverNow: new Date().toISOString() };
}

const toStudentInterview = view.toStudentInterview;
const toAdminInterview = view.toAdminInterview;

/**
 * One interview. The owner gets the student view; an admin gets the instructor view (also for a practice interview). A student
 * can never read someone else's interview, and a practice interview is owned by the admin who started it.
 */
async function getInterview({ userId, interviewId, isAdmin, now = Date.now() }) {
  const meta = await interviews.getInterviewMeta(interviewId);
  if (!meta) throw new NotFoundError('Interview');
  if (meta.userId !== userId && !isAdmin) throw new ForbiddenError('You can only view your own interview');

  let current = meta;
  if (meta.status === STATUS.IN_PROGRESS && now > Date.parse(meta.deadline)) {
    await interviews.endInterview(interviewId, { status: STATUS.TIMED_OUT, endReason: 'deadline_passed', now });
    current = { ...meta, status: STATUS.TIMED_OUT, endedAt: new Date(now).toISOString() };
  }

  const turns = await interviews.getInterviewTurns(interviewId);
  const submission = await getSubmission(meta.submissionId);
  if (!isAdmin) {
    const code = current.status === STATUS.IN_PROGRESS && submission ? submission.code || '' : null;
    return { interview: toStudentInterview(current, turns, { now, code }) };
  }

  return { interview: toAdminInterview(current, turns, { code: submission ? submission.code || '' : null, now }) };
}

/** Admin only (the handler enforces it): every interview of one submission, real and practice, oldest first. */
async function listSubmissionInterviews({ submissionId }) {
  if (!submissionId || typeof submissionId !== 'string') {
    throw new ValidationError('submissionId is required');
  }
  const items = await interviews.listInterviewsBySubmission(submissionId);
  return { submissionId, interviews: items.map(view.toInterviewSummary) };
}

const MAX_REVIEW_NOTE_LENGTH = 4000;

/**
 * Admin only (the handler enforces it): save the instructor's review of an interview. `overrides` maps a main question
 * number to { rubricItemId: true|false } (shown / not shown); only items the instructor changed are sent. The grade is a
 * number from 0 to 100 or null. The agent's own checks are stored on the turns and are not touched.
 */
async function saveInterviewReview({ userId, interviewId, body, now = Date.now() }) {
  if (!interviewId || typeof interviewId !== 'string') throw new ValidationError('interviewId is required');
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};

  const meta = await interviews.getInterviewMeta(interviewId);
  if (!meta) throw new NotFoundError('Interview');

  const { grade = null, note = '', overrides = {} } = input;
  if (grade !== null && (typeof grade !== 'number' || !Number.isFinite(grade) || grade < 0 || grade > 100)) {
    throw new ValidationError('grade must be a number from 0 to 100, or null');
  }
  if (typeof note !== 'string' || note.length > MAX_REVIEW_NOTE_LENGTH) {
    throw new ValidationError(`note must be text of at most ${MAX_REVIEW_NOTE_LENGTH} characters`);
  }
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new ValidationError('overrides must be an object');
  }

  const positions = view.mainPositions(meta.configSnapshot);
  const clean = {};
  Object.entries(overrides).forEach(([questionKey, items]) => {
    const number = Number(questionKey);
    if (!Number.isInteger(number) || number < 1 || number > positions.length) {
      throw new ValidationError(`Unknown main question: ${questionKey}`);
    }
    if (!items || typeof items !== 'object' || Array.isArray(items)) {
      throw new ValidationError(`overrides for question ${questionKey} must be an object`);
    }
    const rubric = engine.rubricFor(meta.configSnapshot, positions[number - 1]);
    const kept = {};
    Object.entries(items).forEach(([itemId, value]) => {
      if (!rubric.some((item) => item.id === itemId)) {
        throw new ValidationError(`Unknown rubric item ${itemId} for question ${questionKey}`);
      }
      if (typeof value !== 'boolean') throw new ValidationError('Each override must be true (shown) or false (not shown)');
      kept[itemId] = value;
    });
    if (Object.keys(kept).length) clean[String(number)] = kept;
  });

  const review = {
    overrides: clean,
    grade,
    note: note.trim(),
    reviewedBy: userId,
    reviewedAt: new Date(now).toISOString(),
  };
  await interviews.saveInterviewReview(interviewId, review);
  log.info('Interview review saved', { interviewId, overrideCount: Object.values(clean).reduce((n, o) => n + Object.keys(o).length, 0) });
  return { review };
}

module.exports = {
  saveInterviewReview,
  MAX_REVIEW_NOTE_LENGTH,
  startInterview,
  startPracticeInterview,
  listSubmissionInterviews,
  submitAnswer,
  getInterview,
  toStudentInterview,
  toAdminInterview,
  sanitizeClientTiming,
  STATUS,
  MAX_ANSWER_LENGTH,
};
