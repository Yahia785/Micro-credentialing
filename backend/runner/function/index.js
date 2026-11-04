/**
 * C++ runner Lambda.
 *
 * Event:   { source, runs: [{ stdin }], timeLimitMs, memoryLimitKb }
 *          The expected output never enters the runner: an event that contains expectedOutput is rejected.
 * Returns: { results: [...], diagnostics }  with one result per run, in order. Each result has
 *          status (accepted only means "ran fine"; compile_error, runtime_error, time_limit, memory_limit,
 *          internal_error), stdout (capped), stderr, compileOutput, timeMs, memoryKb, plus statusText,
 *          runId and message. Compiles once, then runs each input one after the other.
 *          diagnostics: { seccomp, landlock, ... } say which optional protections were applied. Neither is required:
 *          on standard Lambda the platform's own seccomp filter is the sandbox and refuses ours. The call fails closed
 *          (internal_error "sandbox unavailable", diagnostics.sandboxStep / errno) only when the launcher cannot start the
 *          program safely: a resource limit, the work folder or exec failed.
 *
 * Tenant isolation: the function is deployed with TenancyConfig PER_TENANT, so Lambda gives every tenant (a hash of the
 *          user id, chosen by the caller) its own execution environments and never shares one between tenants. With
 *          REQUIRE_TENANT_ID=true the handler also refuses a call that carries no tenant id (context.tenantId).
 *          Where tenant isolation is not available the fallback is RECYCLE_AFTER_CALL=true: the process ends right after
 *          each response, so student code can never see the memory of an earlier call.
 *
 * Diagnose: the event { "diagnose": true } (no student code) returns what the platform lets the sandbox do, step by
 *          step with success or errno; see lib/diagnose.js.
 *
 * Student code is untrusted. This function never logs source, stdin or program output.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execLimited, sweepProcesses, wipeTmp, countZombies, baselineSize, MB } = require('./lib/sandbox');
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

const RECYCLE_DELAY_MS = 100; // the response is posted well within this; then the process ends
const ZOMBIE_LIMIT = 120;     // of the 200 processes a run may have: more zombies than this and nothing can start any more

// Random id of this process. A new process (a new execution environment, or a recycled one) gets a new id, and
// calls in the same environment share it. run-deployed.js uses it to prove that tenants never share an environment.
const environmentId = crypto.randomBytes(8).toString('hex');
let callsInEnvironment = 0;

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
  // Landlock and seccomp are optional (the platform may refuse them). The launcher only refuses to run the program when it
  // cannot start it safely (resource limit, work folder, exec): its step is then not "none".
  if (meta && meta.step !== 'none') return { ok: false, landlock, seccomp, sandboxUnavailable: true, meta };
  if (compiled.wallKilled || (meta && meta.signal === 24)) return { ok: false, landlock, seccomp, output: 'Compilation time limit exceeded.' };
  if (!meta) return { ok: false, landlock, seccomp, output: 'Compilation failed: sandbox did not report.', internal: true };
  if (meta.exitCode !== 0 || meta.signal) return { ok: false, landlock, seccomp, output: text || `Compilation failed (exit ${meta.exitCode}, signal ${meta.signal}).` };
  return { ok: true, landlock, seccomp, meta };
}

/**
 * The launcher could not start the program safely: nothing ran, and every run says so.
 * diagnostics.sandboxStep / errno say which launcher step failed and why (from the launcher's own report).
 */
function sandboxUnavailable(input, diagnostics, meta) {
  if (meta) noteLauncherReport(diagnostics, meta);
  return { results: input.runs.map(() => internalError('sandbox unavailable')), diagnostics };
}

function noteLauncherReport(diagnostics, meta) {
  diagnostics.sandboxStep = meta.step;
  diagnostics.errno = meta.errno;
  diagnostics.subreaperErrno = meta.subreaperErrno;
  diagnostics.seccompErrno = meta.seccompErrno;
  diagnostics.nnp = meta.nnp;
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

function environmentInfo() {
  return { environmentId, callsInEnvironment, baselineProcesses: baselineSize(), pid: process.pid, tenantRequired: process.env.REQUIRE_TENANT_ID === 'true', recycle: process.env.RECYCLE_AFTER_CALL === 'true' };
}

/** Fallback when tenant isolation is unavailable: end the process right after the response, so nothing in memory survives. */
function recycleAfterResponse() {
  if (process.env.RECYCLE_AFTER_CALL === 'true') setTimeout(() => process.exit(0), RECYCLE_DELAY_MS);
}

exports.handler = async (event, context) => {
  if (process.env.REQUIRE_TENANT_ID === 'true' && !(context && typeof context.tenantId === 'string' && context.tenantId.length > 0)) {
    return { results: [], error: 'tenant id required: this runner only accepts invocations that carry a tenant id' };
  }
  callsInEnvironment++;
  try {
    return await handle(event, context);
  } finally {
    recycleAfterResponse();
  }
};

async function handle(event, context) {
  const started = Date.now();
  if (event && event.diagnose === true) {
    // No student code: just report what the platform lets the sandbox do.
    try {
      return { ...(await diagnose()), environment: environmentInfo() };
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

  const diagnostics = {
    leftoverKilled: 0, survivors: 0, seccomp: null, landlock: null, sandboxStep: null, errno: null,
    seccompErrno: null, nnp: null, subreaperErrno: null, zombies: null, compileMs: 0,
    environmentId, callsInEnvironment, baselineProcesses: baselineSize()
  };
  let dir;
  try {
    wipeTmp(); // nothing from an earlier call may survive in /tmp
    diagnostics.zombies = countZombies();
    if (diagnostics.zombies >= ZOMBIE_LIMIT) {
      // An earlier program left zombies that PID 1 never reaped. They use up the process limit, so nothing could start.
      // Say so now (instead of hanging in the compiler) and end this process so the next call starts with a fresh one.
      setTimeout(() => process.exit(1), RECYCLE_DELAY_MS);
      return { results: input.runs.map(() => internalError('Runner environment exhausted by leftover processes; try again')), diagnostics };
    }
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
      if (outcome.meta && outcome.meta.step !== 'none') return sandboxUnavailable(input, diagnostics, outcome.meta);

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
}
