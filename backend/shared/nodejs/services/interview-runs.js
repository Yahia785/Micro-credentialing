const codeRunner = require('../utils/codeRunner');
const { checkAndCountAgentRun } = require('./run-limiter');
const { RateLimitError } = require('../utils/errors');
const log = require('../utils/logger');
const harnessBuilder = require('./harness-builder');

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

/** The time left until an absolute deadline, as the duration the runner expects (never negative); null when there is no deadline. */
const remainingMs = (deadlineAt, now = Date.now()) => (deadlineAt === null || deadlineAt === undefined ? null : Math.max(0, deadlineAt - now));

/** Why a run failed, for the instructor: the error name and a short message (no code, no output). */
const detailOf = (name, message) => `${name || 'Error'}${message ? `: ${String(message).replace(/\s+/g, ' ').trim().slice(0, 120)}` : ''}`;

const NOTES = Object.freeze({
  LIMIT: 'limit_reached',
  RUNNER_FAILED: 'runner_failed',
  COMPILE_ERROR: 'compile_error',
});

/**
 * A run may carry an optional `program`, so that one question runs its own copy of the student's code instead of the submission as it is
 * (the default, used by the tank assessment, never has one). The copies are built by harness-builder around the assignment's header and
 * driver, which the caller passes as `harness: { header, driver }`:
 *   { kind: 'plain' }                                             the student's code with header and driver
 *   { kind: 'trace', pauseLine, variables, expectStdout? }        the trace copy; the run result has `trace: { total, stops }`
 *   { kind: 'whatIf', line, find, replace }                       the changed copy
 * A copy that cannot be built, does not compile, or does not run to the end is a system error for THAT question only: it is added to
 * that question's `errors` ([{ label, kind, stage, reason }], present only when there is one), and the other questions still run. A
 * copy that cannot be built is never sent to the runner and is not counted as an agent run. `expectStdout` is the output of the plain
 * run on the same input: a trace copy whose output differs is the system error "instrumentation changed behavior".
 */
const MAX_TRACE_STOPS_KEPT = 50;
const BUILDERS = Object.freeze({
  plain: (h, code) => harnessBuilder.buildProgram({ header: h.header, driver: h.driver, studentSource: code }),
  trace: (h, code, p) => harnessBuilder.buildTraceProgram({ header: h.header, driver: h.driver, studentSource: code, pauseLine: p.pauseLine, variables: p.variables }),
  whatIf: (h, code, p) => harnessBuilder.buildWhatIfProgram({ header: h.header, driver: h.driver, studentSource: code, line: p.line, find: p.find, replace: p.replace }),
});

/** Why a copy did not compile, without any code or compiler text: our own prelude in the message means an unsupported variable type. */
const compileReason = (kind, compileOutput) => {
  if (kind === 'trace') return String(compileOutput || '').includes('harness_trace') ? 'trace: unsupported variable type' : 'trace copy did not compile';
  return kind === 'whatIf' ? 'changed copy did not compile' : 'did not compile';
};

/**
 * Run every input of every main question ONCE, in one batch, when the interview is created (answers never call the runner).
 * `questions` is one list of { label, stdin } per main question, in the order they are asked. Each input counts as one agent run (see
 * run-limiter): inputs are counted in order and the first refusal skips the rest. The result is aligned with `questions`:
 * [{ runs: [{ label, stdin, stdout (2,000 characters at most), status, timeMs }], note }], where note says why a question has fewer
 * runs than inputs (limit_reached, runner_failed) or that the code did not compile.
 *
 * @param {{ code: string, questions: Array<Array<{label:string, stdin:string}>>, userId: string, interviewId: string,
 *           limits?: {timeLimitMs:number, memoryLimitKb:number}, runBatch?: Function, countRun?: Function, deadlineAt?: number|null }} input
 *   deadlineAt is an ABSOLUTE time (epoch ms) by which the runs must be done. The runner wants the time that is LEFT (a duration), so it is
 *   worked out here at the moment of the call: max(0, deadlineAt - now).
 */
async function runAllQuestions({ code, questions, userId, interviewId, limits = DEFAULT_LIMITS, runBatch = codeRunner.runCppBatch, countRun = checkAndCountAgentRun, deadlineAt = null, harness = null }) {
  const out = questions.map(() => ({ runs: [], note: null }));
  const addError = (q, run, stage, reason) => {
    if (!out[q].errors) out[q].errors = [];
    out[q].errors.push({ label: run.label, kind: run.program.kind, stage, reason });
    log.error('Interview run system error', { stage, kind: run.program.kind });
  };
  const inputs = [];
  questions.forEach((list, q) => (Array.isArray(list) ? list : []).forEach((run) => inputs.push({ q, run, source: code })));
  if (inputs.length === 0 || !String(code || '').trim()) return out;

  // A run with a program spec gets its own source; one that cannot be built is a system error for its question and is not run.
  const perProgram = inputs.some(({ run }) => run.program);
  if (perProgram) {
    const cache = new Map();
    for (let i = inputs.length - 1; i >= 0; i -= 1) {
      const { q, run } = inputs[i];
      if (!run.program) continue;
      const builder = BUILDERS[run.program.kind];
      let built;
      if (!harness || !harness.header || !harness.driver) built = { ok: false, reason: 'no harness (header and driver) is configured' };
      else if (!builder) built = { ok: false, reason: `unknown program kind "${run.program.kind}"` };
      else {
        const key = JSON.stringify([run.program.kind, run.program.pauseLine, run.program.variables, run.program.line, run.program.find, run.program.replace]);
        if (!cache.has(key)) cache.set(key, builder(harness, code, run.program));
        built = cache.get(key);
      }
      if (!built.ok) {
        addError(q, run, 'build', built.reason);
        inputs.splice(i, 1);
      } else {
        inputs[i].source = built.source;
        inputs[i].marker = built.marker;
      }
    }
    if (inputs.length === 0) return out;
  }

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
      stopNote = error instanceof RateLimitError ? NOTES.LIMIT : `${NOTES.RUNNER_FAILED}: ${detailOf(error.name, error.message)}`;
      log.info('Interview run skipped', { interviewId, reason: stopNote });
      break;
    }
  }
  // A question that lost inputs to the limit (or to a failure of the counter) says so.
  inputs.slice(stoppedAt).forEach(({ q }) => { out[q].note = stopNote; });
  if (allowed.length === 0) return out;

  let results;
  let failure = null;
  try {
    results = await runBatch(allowed.map(({ run, source }) => ({
      source, stdin: run.stdin, timeLimitMs: limits.timeLimitMs, memoryLimitKb: limits.memoryLimitKb,
    })), { deadlineMs: remainingMs(deadlineAt), userId });
  } catch (error) {
    log.error('Interview run failed', { interviewId, error: error.name });
    failure = detailOf(error.name, error.message);
    results = null;
  }
  // With per-question programs one failed run only fails its own question (handled below); otherwise any failure fails them all.
  const brokenRun = (r) => !r || r.status === 'internal_error';
  if (!Array.isArray(results) || results.length !== allowed.length || (!perProgram && results.some(brokenRun))) {
    // Only the error name goes to the log; the note says why, for the instructor.
    log.error('Interview run failed in the code runner', { interviewId });
    const bad = Array.isArray(results) ? results.find((r) => r && r.status === 'internal_error') : null;
    if (!failure) failure = bad ? detailOf('internal_error', bad.message) : 'the runner returned no usable result';
    allowed.forEach(({ q }) => { out[q].note = `${NOTES.RUNNER_FAILED}: ${failure}`; });
    return out;
  }

  allowed.forEach(({ q, run, marker }, i) => {
    const result = results[i];
    if (brokenRun(result)) {
      addError(q, run, 'runner', detailOf('internal_error', result && result.message));
      return;
    }
    const entry = {
      label: run.label,
      stdin: run.stdin,
      stdout: String(result.stdout || '').slice(0, MAX_STDOUT_CHARS),
      status: result.status,
      timeMs: Math.round(result.timeMs || 0),
    };
    const program = run.program;
    if (program) {
      entry.kind = program.kind;
      if (program.kind !== 'plain' && result.status === 'compile_error') addError(q, run, 'compile', compileReason(program.kind, result.compileOutput));
      else if (program.kind !== 'plain' && result.status !== 'accepted') addError(q, run, 'run', result.status);
      else if (program.kind === 'trace') {
        const stops = harnessBuilder.parseAllStops(result.stderr, marker);
        entry.trace = { total: stops.length, stops: stops.slice(0, MAX_TRACE_STOPS_KEPT) };
        if (typeof program.expectStdout === 'string' && program.expectStdout.slice(0, MAX_STDOUT_CHARS) !== entry.stdout) {
          addError(q, run, 'check', 'instrumentation changed behavior');
          entry.trace.rejected = true;
        }
      }
    }
    out[q].runs.push(entry);
    if (result.status === 'compile_error' && (!program || program.kind === 'plain')) out[q].note = NOTES.COMPILE_ERROR;
  });
  log.info('Interview runs done', { interviewId, count: allowed.length });
  return out;
}

module.exports = { runAllQuestions, remainingMs, NOTES, MAX_STDOUT_CHARS };
