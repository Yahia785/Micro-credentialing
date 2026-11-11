const { getMilestone } = require('../db/milestones');
const { getUser } = require('../db/users');
const { getTestCasesByMilestone } = require('../db/testcases');
const { runCpp, runCppBatch } = require('../utils/codeRunner');
const { checkAndCountRun, getRunsLeft } = require('./run-limiter');
const { canSeeProblem } = require('../utils/assessment-view');
const { ValidationError, NotFoundError, ForbiddenError, ExternalServiceError } = require('../utils/errors');
const log = require('../utils/logger');

/**
 * The Run button: run the student's current code before they submit, either on their own input or on the visible sample
 * tests. Never grades, never saves, never touches hidden tests. Counts against the run limits (see run-limiter).
 */

const MAX_CODE_CHARS = 100000;
const MAX_INPUT_CHARS = 10000;
const MAX_OUTPUT_CHARS = 10000;

/** Cuts long text so a runaway program cannot flood the response. */
function trim(text) {
  const value = typeof text === 'string' ? text : '';
  return value.length > MAX_OUTPUT_CHARS ? `${value.slice(0, MAX_OUTPUT_CHARS)}\n[output cut at ${MAX_OUTPUT_CHARS} characters]` : value;
}

function runLimits(milestone) {
  return { timeLimitMs: milestone.timeLimit || 5000, memoryLimitKb: milestone.memoryLimit || 256000 };
}

/** Throws unless the caller may run this problem now. Returns the milestone. Nothing is counted yet. */
async function checkRunAllowed({ userId, milestoneId }) {
  const milestone = await getMilestone(milestoneId);
  if (!milestone) throw new NotFoundError('Milestone');

  const user = await getUser(userId);
  // Same rule as the test case list: a hidden problem does not exist for people who cannot see it.
  if (!canSeeProblem(milestone, userId, { isAdmin: !!user && user.role === 'admin', ok: true })) {
    throw new NotFoundError('Milestone');
  }

  if (String(milestone.language || '').toLowerCase() !== 'cpp') {
    throw new ValidationError('Running code is only available for C++ problems');
  }

  // One attempt per problem: after the submission there is nothing left to try.
  if ((user?.completedMilestones || []).some(m => m.milestoneId === milestoneId)) {
    throw new ForbiddenError('You have already submitted this problem, so it can no longer be run');
  }
  return milestone;
}

/**
 * @param {{ userId: string, milestoneId: string, code: string, input?: string, sample?: boolean, deadlineMs?: number|null }} request
 * @returns custom input: { mode: 'custom', status, stdout, stderr, compileOutput, timeMs, runsLeft }
 *          sample tests:  { mode: 'sample', status, compileOutput, results: [{ index, passed, status, input, expectedOutput,
 *                          actualOutput, stderr, timeMs }], passed, total, timeMs, runsLeft }
 */
async function runStudentCode({ userId, milestoneId, code, input, sample, deadlineMs = null }) {
  if (!milestoneId || typeof milestoneId !== 'string') throw new ValidationError('milestoneId is required');
  if (typeof code !== 'string' || !code.trim()) throw new ValidationError('code is required');
  if (code.length > MAX_CODE_CHARS) throw new ValidationError(`code is too long (at most ${MAX_CODE_CHARS} characters)`);
  if (sample !== undefined && typeof sample !== 'boolean') throw new ValidationError('sample must be true or false');
  if (input !== undefined && typeof input !== 'string') throw new ValidationError('input must be text');
  if ((input || '').length > MAX_INPUT_CHARS) throw new ValidationError(`input is too long (at most ${MAX_INPUT_CHARS} characters)`);

  const milestone = await checkRunAllowed({ userId, milestoneId });
  const limits = runLimits(milestone);

  // Only the visible tests are ever loaded into a run. Hidden ones are filtered out before anything else sees them.
  let visibleTests = [];
  if (sample === true) {
    visibleTests = (await getTestCasesByMilestone(milestoneId))
      .filter(testCase => testCase.isHidden !== true)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    if (visibleTests.length === 0) throw new ValidationError('This problem has no sample tests to run');
  }

  // Counted only now, so a refused or invalid request never uses up a run. 429 comes from here.
  await checkAndCountRun({ userId, assessmentId: milestoneId });
  const runsLeft = await getRunsLeft({ userId, assessmentId: milestoneId });
  log.info('Run', { userId, milestoneId, mode: sample === true ? 'sample' : 'custom', tests: visibleTests.length });

  if (sample === true) {
    const runs = await runCppBatch(visibleTests.map(testCase => ({
      source: code, stdin: testCase.input, expectedOutput: testCase.expectedOutput, ...limits
    })), { deadlineMs, userId });
    return sampleResponse(visibleTests, runs, runsLeft);
  }

  const result = await runCpp({ source: code, stdin: input || '', ...limits, deadlineMs, userId });
  if (result.status === 'internal_error') throw unavailable(result);
  return {
    mode: 'custom',
    status: result.status,
    stdout: trim(result.stdout),
    stderr: trim(result.stderr),
    compileOutput: trim(result.compileOutput),
    timeMs: result.timeMs || 0,
    runsLeft
  };
}

function unavailable(result) {
  // The provider's own message may hold internals: log it, show a generic one.
  log.error('Run failed in the code runner', { error: result.message });
  return new ExternalServiceError('Code runner', 'it is not available right now, please try again in a moment');
}

function sampleResponse(tests, runs, runsLeft) {
  if (runs.some(run => run.status === 'internal_error')) throw unavailable(runs.find(run => run.status === 'internal_error'));

  // One compile for all tests: if it failed, it failed for every test and there is nothing to compare.
  const compileFailure = runs.find(run => run.status === 'compile_error');
  const results = tests.map((testCase, index) => ({
    index: index + 1,
    passed: runs[index].status === 'accepted',
    status: runs[index].status,
    input: testCase.input,
    expectedOutput: testCase.expectedOutput,
    actualOutput: trim(runs[index].stdout),
    stderr: trim(runs[index].stderr),
    timeMs: runs[index].timeMs || 0
  }));

  return {
    mode: 'sample',
    status: compileFailure ? 'compile_error' : results.every(result => result.passed) ? 'accepted' : 'failed',
    compileOutput: compileFailure ? trim(compileFailure.compileOutput) : '',
    results: compileFailure ? [] : results,
    passed: results.filter(result => result.passed).length,
    total: results.length,
    timeMs: results.reduce((sum, result) => sum + result.timeMs, 0),
    runsLeft
  };
}

module.exports = { runStudentCode, MAX_CODE_CHARS, MAX_INPUT_CHARS };
