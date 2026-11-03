/**
 * C++ runner Lambda.
 *
 * Event:   { source, runs: [{ stdin }], timeLimitMs, memoryLimitKb }
 *          The expected output never enters the runner: an event that contains expectedOutput is rejected.
 * Returns: { results: [...], diagnostics }  with one result per run, in order. Each result has
 *          status (accepted only means "ran fine"; compile_error, runtime_error, time_limit, memory_limit,
 *          internal_error), stdout (capped), stderr, compileOutput, timeMs, memoryKb, plus statusText,
 *          runId and message. Compiles once, then runs each input one after the other.
 *          diagnostics: { seccomp, landlock, ... }. Without seccomp nothing runs (internal_error
 *          "sandbox unavailable"); Landlock is used when the kernel has it and is not required.
 *
 * Diagnose: the event { "diagnose": true } (no student code) returns what the platform lets the sandbox do, step by
 *          step with success or errno; see lib/diagnose.js. When the sandbox is unavailable, diagnostics.sandboxStep and
 *          diagnostics.errno say which launcher step failed.
 *
 * Student code is untrusted. This function never logs source, stdin or program output.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execLimited, sweepProcesses, wipeTmp, MB } = require('./lib/sandbox');
const { classifyRun, compileFailure, internalError } = require('./lib/classify');
const { diagnose } = require('./lib/diagnose');

const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_RUNS = 200;
const MAX_RESPONSE_BYTES = 5 * MB; // Lambda's synchronous response limit is 6 MB
const COMPILE_OUTPUT_CAP = 64 * 1024;
const COMPILE_CPU_SEC = 10;
const COMPILE_WALL_MS = 15000;
const COMPILE_AS_BYTES = 1400 * MB;
const MAX_TIME_LIMIT_MS = 10000;
const MAX_MEMORY_LIMIT_KB = 1000000;
const MIN_MEMORY_LIMIT_KB = 16384;
const LIBRARY_SLACK_BYTES = 16 * MB; // address space needed by libstdc++ itself
const SAFETY_MARGIN_MS = 1500;

class InputError extends Error {}

function validate(event) {
  if (!event || typeof event.source !== 'string' || event.source.length === 0) throw new InputError('source is required');
  if (Buffer.byteLength(event.source) > MAX_SOURCE_BYTES) throw new InputError('source is too large');
  if (!Array.isArray(event.runs) || event.runs.length === 0 || event.runs.length > MAX_RUNS) {
    throw new InputError(`runs must have 1 to ${MAX_RUNS} entries`);
  }
  // The runner must not learn the expected output, so refuse it instead of ignoring it.
  if (event.runs.some(run => run === null || typeof run !== 'object')) throw new InputError('each run must be an object');
  if ('expectedOutput' in event || event.runs.some(run => 'expectedOutput' in run)) {
    throw new InputError('expectedOutput is not accepted: the runner never receives the expected output');
  }
  const timeLimitMs = Number(event.timeLimitMs);
  const memoryLimitKb = Number(event.memoryLimitKb);
  if (!Number.isFinite(timeLimitMs) || timeLimitMs <= 0) throw new InputError('timeLimitMs must be a positive number');
  if (!Number.isFinite(memoryLimitKb) || memoryLimitKb <= 0) throw new InputError('memoryLimitKb must be a positive number');
  return {
    source: event.source,
    runs: event.runs.map(run => ({ stdin: typeof run.stdin === 'string' ? run.stdin : '' })),
    timeLimitMs: Math.min(timeLimitMs, MAX_TIME_LIMIT_MS),
    memoryLimitKb: Math.min(Math.max(memoryLimitKb, MIN_MEMORY_LIMIT_KB), MAX_MEMORY_LIMIT_KB)
  };
}

async function compile(dir, source) {
  fs.writeFileSync(path.join(dir, 'main.cpp'), source);
  const compiled = await execLimited({
    mode: 'compile',
    dir,
    argv: ['/usr/bin/g++', '-O2', '-std=c++17', '-fmax-errors=50', '-o', path.join(dir, 'prog'), path.join(dir, 'main.cpp')],
    stdin: '',
    cpuSec: COMPILE_CPU_SEC,
    asBytes: COMPILE_AS_BYTES,
    fsizeBytes: 64 * MB,
    nofile: 256,
    wallMs: COMPILE_WALL_MS,
    stdoutCap: COMPILE_OUTPUT_CAP,
    stderrCap: COMPILE_OUTPUT_CAP
  });

  const text = Buffer.concat([compiled.stderr, compiled.stdout]).toString('utf-8').slice(0, COMPILE_OUTPUT_CAP);
  const meta = compiled.meta;
  const landlock = meta ? meta.landlock : null;
  const seccomp = meta ? meta.seccomp : null;
  // The seccomp filter is required; Landlock is optional (the kernel may not have it).
  if (meta && !meta.seccomp) return { ok: false, landlock, seccomp: false, sandboxUnavailable: true, meta };
  if (compiled.wallKilled || (meta && meta.signal === 24)) return { ok: false, landlock, seccomp, output: 'Compilation time limit exceeded.' };
  if (!meta) return { ok: false, landlock, seccomp, output: 'Compilation failed: sandbox did not report.', internal: true };
  if (meta.exitCode !== 0 || meta.signal) return { ok: false, landlock, seccomp, output: text || `Compilation failed (exit ${meta.exitCode}, signal ${meta.signal}).` };
  return { ok: true, landlock, seccomp, meta };
}

/**
 * The seccomp filter could not be installed: nothing ran, and every run says so.
 * diagnostics.sandboxStep / errno say which launcher step failed and why (from the launcher's own report).
 */
function sandboxUnavailable(input, diagnostics, meta) {
  diagnostics.seccomp = false;
  if (meta) noteLauncherReport(diagnostics, meta);
  return { results: input.runs.map(() => internalError('sandbox unavailable')), diagnostics };
}

function noteLauncherReport(diagnostics, meta) {
  diagnostics.sandboxStep = meta.step;
  diagnostics.errno = meta.errno;
  diagnostics.subreaperErrno = meta.subreaperErrno;
}

/** Keep the reply under Lambda's response limit: results that no longer fit are replaced by an error. */
function fitResponse(results) {
  let bytes = 0;
  return results.map(result => {
    const size = Buffer.byteLength(JSON.stringify(result));
    if (bytes + size > MAX_RESPONSE_BYTES) return internalError('Output too large for one response');
    bytes += size;
    return result;
  });
}

exports.handler = async (event, context) => {
  const started = Date.now();
  if (event && event.diagnose === true) {
    // No student code: just report what the platform lets the sandbox do.
    try {
      return await diagnose();
    } catch (error) {
      return { diagnose: true, error: error.message };
    }
  }
  let input;
  try {
    input = validate(event);
  } catch (error) {
    if (error instanceof InputError) return { results: [], error: error.message };
    throw error;
  }

  const diagnostics = { leftoverKilled: 0, survivors: 0, seccomp: null, landlock: null, sandboxStep: null, errno: null, subreaperErrno: null, compileMs: 0 };
  let dir;
  try {
    wipeTmp(); // nothing from an earlier call may survive in /tmp
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));

    const compileStart = Date.now();
    const compiled = await compile(dir, input.source);
    diagnostics.compileMs = Date.now() - compileStart;
    diagnostics.landlock = compiled.landlock === undefined ? null : compiled.landlock;
    diagnostics.seccomp = compiled.seccomp === undefined ? null : compiled.seccomp;
    if (compiled.meta) noteLauncherReport(diagnostics, compiled.meta);
    if (compiled.sandboxUnavailable) return sandboxUnavailable(input, diagnostics, compiled.meta);
    if (!compiled.ok) {
      const failure = compiled.internal ? internalError(compiled.output) : compileFailure(compiled.output);
      return { results: input.runs.map(() => failure), diagnostics };
    }

    const results = [];
    const wallMs = input.timeLimitMs * 2 + 200;
    for (const run of input.runs) {
      if (context && context.getRemainingTimeInMillis() < wallMs + SAFETY_MARGIN_MS) {
        results.push(internalError('Runner is out of time for this call'));
        continue;
      }

      const outcome = await execLimited({
        mode: 'run',
        dir,
        argv: [path.join(dir, 'prog')],
        stdin: run.stdin,
        cpuSec: Math.ceil(input.timeLimitMs / 1000),
        asBytes: input.memoryLimitKb * 1024 + LIBRARY_SLACK_BYTES,
        wallMs
      });
      if (outcome.meta) {
        diagnostics.landlock = diagnostics.landlock && outcome.meta.landlock;
        diagnostics.seccomp = diagnostics.seccomp && outcome.meta.seccomp;
        diagnostics.leftoverKilled += outcome.meta.reaped;
      }
      if (outcome.meta && !outcome.meta.seccomp) return sandboxUnavailable(input, diagnostics, outcome.meta);

      // Kill anything the program left behind before the next run (or the next call).
      const sweep = await sweepProcesses();
      diagnostics.leftoverKilled += sweep.killed;
      diagnostics.survivors = sweep.survivors;
      if (sweep.survivors > 0) {
        results.push(internalError('Student process could not be stopped'));
        break;
      }
      results.push(classifyRun(outcome, input));
    }
    while (results.length < input.runs.length) results.push(internalError('Run skipped'));
    return { results: fitResponse(results), diagnostics };
  } catch (error) {
    console.error('Runner failure', { message: error.message });
    return { results: input.runs.map(() => internalError('Runner failure')), diagnostics };
  } finally {
    await sweepProcesses().catch(() => {});
    try { wipeTmp(); } catch { /* best effort */ }
    console.log('Runner call done', { runs: input.runs.length, totalMs: Date.now() - started, ...diagnostics });
  }
};
