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
  if (submission.type === 'embedded' || submission.language !== 'cpp') {
    throw new ValidationError('Interviews are only available for C++ coding assessments');
  }

  const milestone = await getMilestone(submission.milestoneId);
  if (!milestone) throw new NotFoundError('Assessment');
  const config = milestone.interview;
  if (milestone.type === 'embedded' || milestone.language !== 'cpp' || !config || !config.enabled) {
    throw new ValidationError('An interview is not enabled for this assessment');
  }

  const interviewId = interviews.interviewIdFor(submissionId);
  if (await interviews.getInterviewBySubmission(submissionId)) {
    throw new AppError('An interview already exists for this submission', 409);
  }

  const first = engine.firstQuestion(config);
  const startedAt = new Date(now).toISOString();
  const deadline = new Date(now + config.timeLimitMinutes * 60000).toISOString();

  await interviews.createInterview(
    {
      interviewId,
      submissionId,
      userId,
      milestoneId: submission.milestoneId,
      status: STATUS.IN_PROGRESS,
      startedAt,
      endedAt: null,
      endReason: null,
      deadline,
      modelId: bedrock.resolveModelId(),
      promptVersion: engine.resolvePromptVersion(),
      ...stateFields(first.state),
      turnCount: 1,
      configSnapshot: config,
    },
    { role: 'host', text: first.question, themeId: first.themeId, kind: first.kind, createdAt: startedAt, reason: 'first main question' }
  );

  log.info('Interview started', { interviewId, submissionId, milestoneId: submission.milestoneId });
  return { interviewId, question: first.question, deadline, serverNow: startedAt };
}

/**
 * Store the student's answer and return the next question, or { ended: true }.
 */
async function submitAnswer({ userId, interviewId, answer, clientTiming, now = Date.now(), converseFn }) {
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
        },
      },
      now,
    });
    log.info('Interview completed', logFields);
    return { ended: true, status: STATUS.COMPLETED };
  }

  const hostTurn = {
    role: 'host',
    text: decision.question,
    themeId: decision.themeId,
    kind: decision.kind,
    reason: decision.reason,
    ...(decision.modelReason && { modelReason: decision.modelReason }),
    ...(decision.fallback && { fallback: decision.fallback }),
    latencyMs: decision.usage.latencyMs,
    inputTokens: decision.usage.inputTokens,
    outputTokens: decision.usage.outputTokens,
    createdAt: new Date().toISOString(),
  };
  await interviews.appendTurns({
    interviewId,
    expectedTurnCount: meta.turnCount,
    turns: [studentTurn, hostTurn],
    metaUpdates: stateFields(decision.state),
    now,
  });
  log.info('Interview answer processed', logFields);
  return { question: decision.question, deadline: meta.deadline };
}

/** Student view: transcript without reasons, themes, timing, tokens or criteria. */
function toStudentInterview(meta, turns) {
  return {
    interviewId: meta.interviewId,
    status: meta.status,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt || null,
    deadline: meta.deadline,
    turns: turns.map((t) => ({ role: t.role, text: t.text, createdAt: t.createdAt })),
  };
}

/** Admin view: everything the interview recorded. */
function toAdminInterview(meta, turns) {
  const { sk, ...metaFields } = meta;
  return { ...metaFields, turns: turns.map(({ sk: _sk, ...t }) => t) };
}

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
  const view = isAdmin ? toAdminInterview(current, turns) : toStudentInterview(current, turns);
  return { interview: { ...view, serverNow: new Date(now).toISOString() } };
}

module.exports = {
  startInterview,
  submitAnswer,
  getInterview,
  toStudentInterview,
  toAdminInterview,
  sanitizeClientTiming,
  STATUS,
  MAX_ANSWER_LENGTH,
};
