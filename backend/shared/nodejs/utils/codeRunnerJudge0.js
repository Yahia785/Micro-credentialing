/**
 * Judge0 provider for codeRunner. Reuses utils/judge0.js for the HTTP calls and
 * translates its raw result into the fixed codeRunner result shape.
 */

const judge0 = require('./judge0');

const CPP = 'cpp';

// Judge0 status ids: 3 accepted, 4 wrong answer, 5 time limit, 6 compile error,
// 7-12 runtime errors (SIGSEGV, SIGXFSZ, SIGFPE, SIGABRT, NZEC, other), 13 internal, 14 exec format.
function mapStatus(raw, memoryLimitKb) {
  const id = raw.status && raw.status.id;
  if (id === 3) return 'accepted';
  if (id === 4) return 'wrong_answer';
  if (id === 5) return 'time_limit';
  if (id === 6) return 'compile_error';
  if (id >= 7 && id <= 12) {
    // Judge0 has no memory-limit verdict; a crash at the memory limit is one.
    const memory = parseInt(raw.memory, 10) || 0;
    return memoryLimitKb && memory >= memoryLimitKb ? 'memory_limit' : 'runtime_error';
  }
  return 'internal_error';
}

function fromRaw(raw, memoryLimitKb) {
  return {
    status: mapStatus(raw, memoryLimitKb),
    stdout: raw.stdout || '',
    stderr: raw.stderr || '',
    compileOutput: raw.compile_output || '',
    timeMs: Math.round((parseFloat(raw.time) || 0) * 1000),
    memoryKb: parseInt(raw.memory, 10) || 0,
    // Provider details kept so grading can report exactly what Judge0 said.
    statusText: raw.status ? raw.status.description : null,
    runId: raw.token || null,
    message: raw.message || null
  };
}

// One submitBatch call and one pollResults call for all runs, exactly like the original grading path.
async function runBatch(runs, { deadlineMs } = {}) {
  const { apiKey, apiHost } = await judge0.getJudge0Credentials();
  const languageId = judge0.getLanguageId(CPP);
  const submissions = runs.map(({ source, stdin, expectedOutput, timeLimitMs, memoryLimitKb }) => ({
    source_code: source,
    language_id: languageId,
    stdin,
    expected_output: expectedOutput,
    cpu_time_limit: timeLimitMs / 1000,
    memory_limit: memoryLimitKb
  }));
  const tokens = (await judge0.submitBatch(submissions, apiKey, apiHost)).map(r => r.token);
  const raws = await judge0.pollResults(tokens, apiKey, apiHost, 30, 1000, deadlineMs);
  return raws.map((raw, index) => fromRaw(raw, runs[index].memoryLimitKb));
}

async function run(options) {
  const [result] = await runBatch([options], { deadlineMs: options.deadlineMs });
  return result;
}

module.exports = { run, runBatch, mapStatus, fromRaw };
