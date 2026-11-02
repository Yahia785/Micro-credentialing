/**
 * The one entry point for running student C++ code.
 *
 * runCpp({ source, stdin, timeLimitMs, memoryLimitKb }) always resolves (never throws) to:
 *   {
 *     status: 'accepted' | 'compile_error' | 'runtime_error' | 'time_limit' | 'memory_limit' | 'internal_error',
 *     stdout, stderr, compileOutput, timeMs, memoryKb
 *   }
 * plus informational extras: statusText, runId, message (message holds the reason for internal_error).
 *
 * runCppBatch(runs, { deadlineMs }) takes an array of the same inputs and returns results in order.
 *
 * Optional inputs: expectedOutput (the provider compares stdout and returns status 'wrong_answer'
 * on a mismatch) and deadlineMs (Lambda time budget, so polling can stop early).
 *
 * The provider is chosen by the CODE_RUNNER environment variable ('judge0' by default, or 'own'). To add a
 * provider, register a module exposing runBatch(runs, { deadlineMs }) in PROVIDERS; no caller changes.
 */

const log = require('./logger');

const PROVIDERS = {
  judge0: () => require('./codeRunnerJudge0'),
  own: () => require('./codeRunnerOwn')
};

function internalError(message) {
  return {
    status: 'internal_error',
    stdout: '',
    stderr: '',
    compileOutput: '',
    timeMs: 0,
    memoryKb: 0,
    statusText: null,
    runId: null,
    message
  };
}

function loadProvider() {
  const name = process.env.CODE_RUNNER || 'judge0';
  const load = PROVIDERS[name];
  if (!load) {
    log.error('Unknown CODE_RUNNER provider', { provider: name });
    return { name, error: `Unknown code runner: ${name}` };
  }
  return { name, provider: load() };
}

async function runCpp({ source, stdin, expectedOutput, timeLimitMs, memoryLimitKb, deadlineMs } = {}) {
  const [result] = await runCppBatch([{ source, stdin, expectedOutput, timeLimitMs, memoryLimitKb }], { deadlineMs });
  return result;
}

/**
 * Run several C++ programs in one provider round trip (Judge0: one submit call, one poll loop).
 * Results come back in the same order and shape as runCpp. Never throws: if the batch fails,
 * every entry is an internal_error carrying the provider's message.
 */
async function runCppBatch(runs, { deadlineMs } = {}) {
  if (!runs.length) return [];

  const { name, provider, error } = loadProvider();
  if (error) return runs.map(() => internalError(error));

  try {
    return await provider.runBatch(runs, { deadlineMs });
  } catch (err) {
    // Provider errors, quota and polling timeouts all become internal_error; callers decide what to do.
    log.error('Code runner error', { provider: name, error: err.message });
    return runs.map(() => internalError(err.message));
  }
}

module.exports = { runCpp, runCppBatch };
