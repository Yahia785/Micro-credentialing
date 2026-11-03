/**
 * Turn how a program ended into a runner status. The runner never sees the expected output, so "accepted"
 * only means "ran fine": the provider (shared/nodejs/utils/codeRunnerOwn.js) compares the output and turns
 * it into wrong_answer when it does not match. statusText uses Judge0's wording so grading stores the same
 * strings whichever provider ran the code.
 */

const SIGNALS = { 6: 'SIGABRT', 8: 'SIGFPE', 11: 'SIGSEGV', 25: 'SIGXFSZ' };
const SIGXCPU = 24;

const TEXT = {
  accepted: 'Accepted',
  time_limit: 'Time Limit Exceeded',
  compile_error: 'Compilation Error',
  memory_limit: 'Runtime Error (SIGSEGV)',
  internal_error: 'Internal Error'
};

function runtimeErrorText(signal) {
  if (signal) return `Runtime Error (${SIGNALS[signal] || 'Other'})`;
  return 'Runtime Error (NZEC)';
}

function result(status, statusText, extra) {
  return {
    status, statusText, stdout: '', stderr: '', compileOutput: '', timeMs: 0, memoryKb: 0, runId: null, message: null, ...extra
  };
}

function isValidUtf8(buffer) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{meta: object|null, stdout: Buffer, stderr: Buffer, outputTruncated: boolean, wallKilled: boolean}} run
 * @param {{ timeLimitMs: number, memoryLimitKb: number }} limits
 */
function classifyRun(run, { timeLimitMs, memoryLimitKb }) {
  const base = {
    stdout: run.stdout.toString('utf-8'),
    stderr: run.stderr.toString('utf-8'),
    // The JSON reply cannot carry invalid UTF-8 bytes, so say so: the comparison treats such output as bytes.
    stdoutInvalidUtf8: !isValidUtf8(run.stdout)
  };

  if (run.wallKilled && !run.outputTruncated) {
    return result('time_limit', TEXT.time_limit, { ...base, timeMs: timeLimitMs, memoryKb: run.meta ? run.meta.rssKb : 0 });
  }
  if (!run.meta) {
    return result('internal_error', TEXT.internal_error, { ...base, message: 'Sandbox launcher did not report' });
  }

  const { exitCode, signal, cpuMs, rssKb } = run.meta;
  const measured = { ...base, timeMs: cpuMs, memoryKb: rssKb };

  if (cpuMs > timeLimitMs || signal === SIGXCPU) {
    return result('time_limit', TEXT.time_limit, measured);
  }
  if (run.outputTruncated) {
    return result('runtime_error', 'Runtime Error (SIGXFSZ)', measured); // Judge0 reports output overflow as SIGXFSZ
  }
  if (signal || exitCode !== 0) {
    // The address-space limit makes allocation fail, which usually ends in bad_alloc -> abort.
    const memoryExhausted = rssKb >= memoryLimitKb * 0.9 || /bad_alloc/.test(base.stderr) || signal === 9;
    if (memoryExhausted) return result('memory_limit', TEXT.memory_limit, measured);
    return result('runtime_error', runtimeErrorText(signal), measured);
  }

  return result('accepted', TEXT.accepted, measured);
}

function compileFailure(compileOutput) {
  return result('compile_error', TEXT.compile_error, { compileOutput });
}

function internalError(message) {
  return result('internal_error', TEXT.internal_error, { message });
}

module.exports = { classifyRun, compileFailure, internalError };
