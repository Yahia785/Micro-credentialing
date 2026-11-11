/**
 * Interview workflow: start, answer, read.
 *
 * Only IDs, timings, token counts and error names are ever logged here. Never answers,
 * questions, code or criteria.
 */
const crypto = require('crypto');
const interviews = require('../db/interviews');
const { getSubmission } = require('../db/submissions');
const { getMilestone } = require('../db/milestones');
const engine = require('../agent/interview-engine');
const bedrock = require('../agent/bedrock-client');
const split = require('../agent/split-agent');
const splitV6 = require('../agent/split-agent-v6');
const { classifyCode, NOT_FINISHED_SENTENCE } = require('../agent/code-status');
const { runAllQuestions } = require('./interview-runs');
const { analyzeCode, buildContext } = require('./interview-analysis');
const { launchPrepare } = require('./prepare-launcher');
const view = require('../utils/interview-view');
const log = require('../utils/logger');
const { END_REASONS } = require('../utils/submission-end-reason');
const { AppError, ValidationError, NotFoundError, ForbiddenError } = require('../utils/errors');

const MAX_ANSWER_LENGTH = 2000;
/** How long the student's page waits for the prepare step before it opens the interview without the analysis (the frontend uses the same number). */
const PREPARE_STATUS = Object.freeze({ PREPARING: 'preparing', READY: 'ready', FAILED: 'failed', SKIPPED: 'skipped' });
const LEFT_PAGE = 'left_page';
const LEFT_PAGE_MESSAGE = 'This interview has ended because you left the page.';
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
    const models = (engine.usesV6(promptVersion) ? splitV6 : split).resolveSplitModels();
    fields.checkerModelId = models.checker;
    fields.writerModelId = models.writer;
  }
  return fields;
}

/** The position of the main question a state is at, counting every main question in the order they are asked (0 is the first). */
function ordinalOf(config, state) {
  return view.mainPositions(config).findIndex((p) => p.themeIndex === state.themeIndex && p.mainIndex === state.mainIndex);
}

/**
 * host.v6 and host.v7, the prepare step: classify the code once (compiles, tests passed, stubs) and run ALL the interview's run inputs
 * once, in one batch. The results are stored on the interview and copied to each main question when it is asked: answering never calls
 * the runner. Returns what the prepare step stores.
 */
async function prepareV6Start({ submission, config, userId, interviewId, runLimits, runBatch, countRun, deadlineAt }) {
  const questions = view.mainPositions(config).map((position) => engine.runsAt(config, position));
  const observed = await runAllQuestions({
    code: submission.code || '', questions, userId, interviewId, limits: runLimits, runBatch, countRun, deadlineAt,
  });
  const codeStatus = classifyCode({ code: submission.code || '', submission, runs: observed.flatMap((entry) => entry.runs) });
  return { codeStatus, observed, firstRuns: observed[0] || { runs: [], note: null } };
}

/** A random session key for the student's page, and the hash that is stored (the key itself is never stored or logged). */
const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');
const newSessionKey = () => crypto.randomBytes(24).toString('hex');

/** Build the META item, the first host turn and the API result of a new interview. The prepare step fills in the rest. */
function newInterview({ interviewId, submission, config, userId, isPractice, now, runLimits, sessionKey }) {
  const first = engine.firstQuestion(config);
  const startedAt = new Date(now).toISOString();
  const promptVersion = promptVersionFor(config);
  // host.v6 and host.v7 have a prepare step (runs, code status, and for host.v7 the analysis). The other versions have nothing to prepare.
  const prepareStatus = engine.usesV6(promptVersion) ? PREPARE_STATUS.PREPARING : PREPARE_STATUS.READY;
  // A real interview's clock does not start here: it starts when the student's page first opens the interview (see startClock), so the
  // waiting page, the recording upload and the prepare step never use up their time. A practice interview's clock starts when it is
  // ready (at once when there is nothing to prepare).
  const deadline = isPractice && prepareStatus === PREPARE_STATUS.READY ? new Date(now + config.timeLimitMinutes * 60000).toISOString() : null;
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
    prepareStatus,
    ...(sessionKey && { sessionKeyHash: hashKey(sessionKey) }),
    ...modelFields(promptVersion),
    promptVersion,
    ...(prepareStatus === PREPARE_STATUS.PREPARING && { runLimits }),
    ...stateFields(first.state),
    turnCount: 1,
    configSnapshot: config,
  };
  const firstTurn = { role: 'host', text: first.question, themeId: first.themeId, kind: first.kind, createdAt: startedAt, reason: 'first main question' };
  return {
    meta, firstTurn,
    result: {
      interviewId, question: first.question, deadline, timeLimitMinutes: config.timeLimitMinutes, questionCount: view.mainPositions(config).length,
      serverNow: startedAt, prepareStatus, ...(sessionKey && { sessionKey }),
    },
  };
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
  return { config, milestone, runLimits: { timeLimitMs: milestone.timeLimit || 5000, memoryLimitKb: milestone.memoryLimit || 256000 } };
}

/**
 * Start the interview for a submission: save it as "preparing" and start the prepare step (a separate function, asynchronously, so the
 * API's 29 second limit never applies). The result carries the session key; only the page that gets it can take the interview.
 * @returns {Promise<{ interviewId, question, deadline, serverNow, prepareStatus, sessionKey }>}
 */
async function startInterview({ userId, submissionId, now = Date.now(), invokePrepare }) {
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
  const { config, runLimits } = await interviewConfigFor(submission);

  const interviewId = interviews.interviewIdFor(submissionId);
  // Practice interviews are never returned here, so they never block the real one.
  if (await interviews.getInterviewBySubmission(submissionId)) {
    throw new AppError('An interview already exists for this submission', 409);
  }

  const { meta, firstTurn, result } = newInterview({ interviewId, submission, config, userId, isPractice: false, now, runLimits, sessionKey: newSessionKey() });
  await interviews.createInterview(meta, firstTurn);
  if (meta.prepareStatus === PREPARE_STATUS.PREPARING) await launchPrepare({ interviewId, invokePrepare, prepare: prepareInterview });

  log.info('Interview started', { interviewId, submissionId, milestoneId: submission.milestoneId });
  return result;
}

/**
 * Admin only (the handler enforces it): start a practice interview on an existing submission's code. Same engine, timing and
 * prompt version as a real one, owned by the admin who started it, marked isPractice. It is not limited by the one interview
 * per submission rule, and getInterviewBySubmission never returns it. It has no session key (the admin may leave and come back).
 * @returns {Promise<{ interviewId, question, deadline, serverNow, prepareStatus, isPractice: true }>}
 */
async function startPracticeInterview({ userId, submissionId, now = Date.now(), invokePrepare }) {
  if (!submissionId || typeof submissionId !== 'string') {
    throw new ValidationError('submissionId is required');
  }
  const submission = await getSubmission(submissionId);
  if (!submission) throw new NotFoundError('Submission');
  const { config, runLimits } = await interviewConfigFor(submission);

  const interviewId = interviews.practiceInterviewId();
  const { meta, firstTurn, result } = newInterview({ interviewId, submission, config, userId, isPractice: true, now, runLimits });
  await interviews.createInterview(meta, firstTurn);
  if (meta.prepareStatus === PREPARE_STATUS.PREPARING) await launchPrepare({ interviewId, invokePrepare, prepare: prepareInterview });

  log.info('Practice interview started', { interviewId, submissionId, milestoneId: submission.milestoneId });
  return { ...result, isPractice: true };
}

/**
 * The prepare step (its own Lambda, started by create; the eval and the tests call it directly). For host.v6 and host.v7 it classifies the
 * code and runs every run input once; for host.v7 it also analyzes the code (a plan call, the runs it chose, an analysis call). It stores
 * the results on the interview and marks it "ready", or "failed" when the step itself fails (the interview then goes on without them).
 * Nothing happens when the interview is not waiting for it any more (the student opened it without waiting, or left).
 * @returns {Promise<{ prepared: boolean, prepareStatus: string }>}
 */
async function prepareInterview({ interviewId, converseFn = bedrock.converse, runBatch, countRun, clock = monotonicMs, now = Date.now(), deadlineAt }) {
  const meta = await interviews.getInterviewMeta(interviewId);
  if (!meta || meta.prepareStatus !== PREPARE_STATUS.PREPARING || meta.status !== STATUS.IN_PROGRESS) {
    return { prepared: false, prepareStatus: meta ? meta.prepareStatus || PREPARE_STATUS.READY : 'missing' };
  }
  const startedAt = clock();
  const config = meta.configSnapshot;
  const runLimits = meta.runLimits || { timeLimitMs: 5000, memoryLimitKb: 256000 };
  // An absolute time (epoch ms) by which the runs must be done; the runs turn it into the time that is left.
  const budget = deadlineAt || Date.now() + 100000;
  try {
    const submission = await getSubmission(meta.submissionId);
    if (!submission) throw new NotFoundError('Submission');
    const prepared = await prepareV6Start({
      submission, config, userId: meta.userId, interviewId, runLimits, runBatch, countRun, deadlineAt: budget,
    });

    let analysis = null;
    if (engine.usesV7(meta.promptVersion)) {
      const milestone = await getMilestone(meta.milestoneId);
      analysis = await analyzeCode({
        converseFn,
        models: { checker: splitV6.resolveSplitModels({ checkerModelId: meta.checkerModelId, writerModelId: meta.writerModelId }).checker },
        context: buildContext({ submission, milestone, config, codeStatus: prepared.codeStatus }),
        instructorRuns: prepared.observed.flatMap((entry) => entry.runs),
        instructorRunsByQuestion: prepared.observed.map((entry) => entry.runs),
        userId: meta.userId, interviewId, limits: runLimits, runBatch, countRun, deadlineAt: budget, clock,
      });
    }

    const prepareMs = Math.max(0, Math.round(clock() - startedAt));
    const clockFields = meta.isPractice
      ? { startedAt: new Date(now).toISOString(), deadline: new Date(now + config.timeLimitMinutes * 60000).toISOString() }
      : {};
    const first = prepared.firstRuns;
    const applied = await interviews.finishPrepare(interviewId, {
      metaUpdates: {
        prepareStatus: PREPARE_STATUS.READY,
        prepareMs,
        codeStatus: prepared.codeStatus,
        observedRuns: prepared.observed,
        ...(analysis && { analysis }),
        ...clockFields,
      },
      // The first question is already stored; what the prepare step found about the code goes onto it.
      firstTurnUpdates: {
        ...(prepared.codeStatus.unfinished && { notice: NOT_FINISHED_SENTENCE }),
        ...(first.runs.length > 0 && { runs: first.runs }),
        ...(first.note && { runsNote: first.note }),
      },
      now,
    });
    log.info('Interview prepared', { interviewId, prepareMs, applied });
    return { prepared: applied, prepareStatus: applied ? PREPARE_STATUS.READY : PREPARE_STATUS.SKIPPED };
  } catch (error) {
    log.error('Interview prepare failed', { interviewId, error: error.name });
    try {
      await interviews.finishPrepare(interviewId, {
        metaUpdates: { prepareStatus: PREPARE_STATUS.FAILED, ...(meta.isPractice && { startedAt: new Date(now).toISOString(), deadline: new Date(now + config.timeLimitMinutes * 60000).toISOString() }) },
        firstTurnUpdates: {}, now,
      });
    } catch (again) {
      log.error('Could not mark the interview prepare step as failed', { interviewId, error: again.name });
    }
    return { prepared: false, prepareStatus: PREPARE_STATUS.FAILED };
  }
}

/**
 * Start a real interview's clock (once): startedAt and the deadline become "now" and "now + the time limit". Returns the META with
 * them. Nothing happens when the clock already runs (every interview from before this change, practice interviews, a second tab).
 */
async function startClock(meta, now) {
  if (meta.deadline) return meta;
  const startedAt = new Date(now).toISOString();
  const deadline = new Date(now + meta.configSnapshot.timeLimitMinutes * 60000).toISOString();
  if (await interviews.startInterviewClock(meta.interviewId, { startedAt, deadline, now })) {
    log.info('Interview clock started', { interviewId: meta.interviewId });
    return { ...meta, startedAt, deadline };
  }
  // Someone else (another tab) started it a moment ago: use theirs.
  return (await interviews.getInterviewMeta(meta.interviewId)) || meta;
}

/** End an interview because its page was left: no retake. Returns the stored META after the change. */
async function abandon(meta, now) {
  await interviews.endInterview(meta.interviewId, { status: STATUS.ABANDONED, endReason: LEFT_PAGE, now });
  log.info('Interview abandoned', { interviewId: meta.interviewId });
  return (await interviews.getInterviewMeta(meta.interviewId)) || { ...meta, status: STATUS.ABANDONED, endReason: LEFT_PAGE, endedAt: new Date(now).toISOString() };
}

/**
 * The student's page opens or answers a real interview: it must be the page that created it. An interview taken without its session key
 * (a reload, a closed tab, another browser, a later visit) counts as abandoned. Interviews from before the key existed, and practice
 * interviews, have no key to check. Opening it also ends the wait for the prepare step: what the step has not finished by then is dropped.
 * @returns {Promise<{ meta: object, abandoned: boolean }>}
 */
async function openAsStudent(stored, sessionKey, now) {
  if (stored.sessionKeyHash && !stored.isPractice && stored.status === STATUS.IN_PROGRESS) {
    if (typeof sessionKey !== 'string' || !sessionKey || hashKey(sessionKey) !== stored.sessionKeyHash) {
      return { meta: await abandon(stored, now), abandoned: true };
    }
  }
  let meta = stored;
  if (meta.prepareStatus === PREPARE_STATUS.PREPARING && meta.status === STATUS.IN_PROGRESS && !meta.isPractice) {
    // The page did not wait any longer: the interview goes on without what is not ready, and the prepare step cannot change it any more.
    if (await interviews.skipPrepare(meta.interviewId, { now })) meta = { ...meta, prepareStatus: PREPARE_STATUS.SKIPPED };
    else meta = (await interviews.getInterviewMeta(meta.interviewId)) || meta; // it finished a moment ago: use that
  }
  return { meta, abandoned: false };
}

/** The code findings of one main question (host.v7), or null for the other versions. */
function findingsAt(meta, config, state) {
  if (!engine.usesV7(meta.promptVersion)) return null;
  const number = ordinalOf(config, state) + 1;
  return ((meta.analysis && meta.analysis.findings) || []).filter((finding) => finding.relatedQuestion === number);
}

/**
 * Store the student's answer and return the next question, or { ended: true }.
 */
/** Milliseconds from a monotonic clock, for measuring how long the agent worked. */
const monotonicMs = () => performance.now();

async function submitAnswer({ userId, interviewId, answer, clientTiming, sessionKey, now = Date.now(), converseFn, clock = monotonicMs }) {
  if (typeof answer !== 'string' || !answer.trim()) throw new ValidationError('answer is required');
  if (answer.length > MAX_ANSWER_LENGTH) {
    throw new ValidationError(`answer must not exceed ${MAX_ANSWER_LENGTH} characters`);
  }

  const stored = await interviews.getInterviewMeta(interviewId);
  if (!stored) throw new NotFoundError('Interview');
  if (stored.userId !== userId) throw new ForbiddenError('You can only answer your own interview');
  if (stored.status !== STATUS.IN_PROGRESS) throw new AppError('This interview has already ended', 409);
  // Only the page that created the interview may answer it. An answer before the page ever opened the interview starts the clock too.
  const opened = await openAsStudent(stored, sessionKey, now);
  if (opened.abandoned) return { ended: true, status: STATUS.ABANDONED };
  const meta = await startClock(opened.meta, now);

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
  const isV6 = engine.usesV6(meta.promptVersion);
  // host.v6: what the student's code printed for the main question being answered (stored on that question's host turn).
  const currentMain = [...turns].reverse().find((t) => t.role === 'host' && t.kind === 'main');
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
    ...(isV6 && { observed: (currentMain && currentMain.runs) || [], codeStatus: meta.codeStatus || null }),
    // host.v7: what the analysis found about the main question being answered
    ...(engine.usesV7(meta.promptVersion) && { findings: findingsAt(meta, config, interviewState(meta)) }),
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

  // host.v6: the runs of the next main question were done when the interview was created; this only copies them (the runner is never called here).
  const nextRuns = isV6 && decision.action === engine.ACTIONS.NEXT_MAIN
    ? (meta.observedRuns || [])[ordinalOf(config, decision.state)] || null
    : null;

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
    ...(nextRuns && nextRuns.runs.length > 0 && { runs: nextRuns.runs }),
    ...(nextRuns && nextRuns.note && { runsNote: nextRuns.note }),
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
  // The student sees the engine's fixed sentence (if any) in front of the question; the question text itself stays as stored.
  const question = decision.notice ? `${decision.notice}\n\n${decision.question}` : decision.question;
  return { question, deadline, serverNow: new Date().toISOString() };
}

const toStudentInterview = view.toStudentInterview;
const toAdminInterview = view.toAdminInterview;

/**
 * One interview. The owner gets the student view; an admin gets the instructor view (also for a practice interview). A student
 * can never read someone else's interview, and a practice interview is owned by the admin who started it.
 */
async function getInterview({ userId, interviewId, isAdmin, peek = false, sessionKey, now = Date.now() }) {
  const stored = await interviews.getInterviewMeta(interviewId);
  if (!stored) throw new NotFoundError('Interview');
  if (stored.userId !== userId && !isAdmin) throw new ForbiddenError('You can only view your own interview');

  // The owner opening a running interview is "the first question is shown": that is when the clock starts, and it must be the page that
  // created the interview (its session key): a later open without it ends the interview. An instructor looking at it never starts or
  // ends anything, and `peek` (is it ready yet?) does not either.
  let meta = stored;
  if (!isAdmin && !peek && stored.status === STATUS.IN_PROGRESS) {
    const opened = await openAsStudent(stored, sessionKey, now);
    meta = opened.abandoned ? opened.meta : await startClock(opened.meta, now);
  }

  let current = meta;
  if (meta.status === STATUS.IN_PROGRESS && meta.deadline && now > Date.parse(meta.deadline)) {
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

/**
 * The student leaves the interview on purpose (in-app navigation, confirmed): it ends now, "abandoned", and cannot be retaken. Owner only.
 * @returns {Promise<{ status: string }>}
 */
async function abandonInterview({ userId, interviewId, now = Date.now() }) {
  const stored = await interviews.getInterviewMeta(interviewId);
  if (!stored) throw new NotFoundError('Interview');
  if (stored.userId !== userId) throw new ForbiddenError('You can only leave your own interview');
  if (stored.status !== STATUS.IN_PROGRESS) return { status: stored.status };
  const meta = await abandon(stored, now);
  return { status: meta.status };
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
  prepareInterview,
  abandonInterview,
  listSubmissionInterviews,
  submitAnswer,
  getInterview,
  toStudentInterview,
  toAdminInterview,
  sanitizeClientTiming,
  STATUS,
  PREPARE_STATUS,
  LEFT_PAGE,
  LEFT_PAGE_MESSAGE,
  MAX_ANSWER_LENGTH,
};
