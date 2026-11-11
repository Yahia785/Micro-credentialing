const codeRunner = require('../utils/codeRunner');
const { checkAndCountAgentRun } = require('./run-limiter');
const { RateLimitError } = require('../utils/errors');
const log = require('../utils/logger');

/**
 * host.v6: run the student's submitted code on the inputs the instructor set for the main questions (config `runs`), through the same
 * runner and limits as the grader (runCppBatch, the problem's time and memory limit, the student as tenant). Each run counts against
 * the agent run limit of the interview (30, see run-limiter). This never blocks the interview: a reached limit, a runner failure
 * or code that does not compile only means the question is asked without run results, and `note` says why.
 *
 * Stored on the interview (observedRuns, one entry per main question) and copied to each main question's host turn when it is asked: runs: [{ label, stdin, stdout (2,000 characters at most), status, timeMs }] and runsNote.
 * Only the interview engine and the instructor ever see them; the student view never has them. Output is never logged.
 */
const MAX_STDOUT_CHARS = 2000;
const DEFAULT_LIMITS = Object.freeze({ timeLimitMs: 5000, memoryLimitKb: 256000 });

const NOTES = Object.freeze({
  LIMIT: 'limit_reached',
  RUNNER_FAILED: 'runner_failed',
  COMPILE_ERROR: 'compile_error',
});

/**
 * Run every input of every main question ONCE, in one batch, when the interview is created (answers never call the runner).
 * `questions` is one list of { label, stdin } per main question, in the order they are asked. Each input counts as one agent run (see
 * run-limiter): inputs are counted in order and the first refusal skips the rest. The result is aligned with `questions`:
 * [{ runs: [{ label, stdin, stdout (2,000 characters at most), status, timeMs }], note }], where note says why a question has fewer
 * runs than inputs (limit_reached, runner_failed) or that the code did not compile.
 *
 * @param {{ code: string, questions: Array<Array<{label:string, stdin:string}>>, userId: string, interviewId: string,
 *           limits?: {timeLimitMs:number, memoryLimitKb:number}, runBatch?: Function, countRun?: Function, deadlineMs?: number|null }} input
 */
async function runAllQuestions({ code, questions, userId, interviewId, limits = DEFAULT_LIMITS, runBatch = codeRunner.runCppBatch, countRun = checkAndCountAgentRun, deadlineMs = null }) {
  const out = questions.map(() => ({ runs: [], note: null }));
  const inputs = [];
  questions.forEach((list, q) => (Array.isArray(list) ? list : []).forEach((run) => inputs.push({ q, run })));
  if (inputs.length === 0 || !String(code || '').trim()) return out;

  // Count before running, one per input; stop at the first refusal.
  const allowed = [];
  let stoppedAt = inputs.length;
  let stopNote = null;
  for (let i = 0; i < inputs.length; i += 1) {
    try {
      await countRun({ userId, interviewId });
      allowed.push(inputs[i]);
    } catch (error) {
      stoppedAt = i;
      stopNote = error instanceof RateLimitError ? NOTES.LIMIT : NOTES.RUNNER_FAILED;
      log.info('Interview run skipped', { interviewId, reason: stopNote });
      break;
    }
  }
  // A question that lost inputs to the limit (or to a failure of the counter) says so.
  inputs.slice(stoppedAt).forEach(({ q }) => { out[q].note = stopNote; });
  if (allowed.length === 0) return out;

  let results;
  try {
    results = await runBatch(allowed.map(({ run }) => ({
      source: code, stdin: run.stdin, timeLimitMs: limits.timeLimitMs, memoryLimitKb: limits.memoryLimitKb,
    })), { deadlineMs, userId });
  } catch (error) {
    log.error('Interview run failed', { interviewId, error: error.name });
    results = null;
  }
  if (!Array.isArray(results) || results.length !== allowed.length || results.some((r) => !r || r.status === 'internal_error')) {
    // The provider's message may hold internals: only the fact is recorded.
    log.error('Interview run failed in the code runner', { interviewId });
    allowed.forEach(({ q }) => { out[q].note = NOTES.RUNNER_FAILED; });
    return out;
  }

  allowed.forEach(({ q, run }, i) => {
    out[q].runs.push({
      label: run.label,
      stdin: run.stdin,
      stdout: String(results[i].stdout || '').slice(0, MAX_STDOUT_CHARS),
      status: results[i].status,
      timeMs: Math.round(results[i].timeMs || 0),
    });
    if (results[i].status === 'compile_error') out[q].note = NOTES.COMPILE_ERROR;
  });
  log.info('Interview runs done', { interviewId, count: allowed.length });
  return out;
}

module.exports = { runAllQuestions, NOTES, MAX_STDOUT_CHARS };
