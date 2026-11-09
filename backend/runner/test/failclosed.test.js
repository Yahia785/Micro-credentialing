// node --test test/failclosed.test.js   (no Docker needed)
// The launcher reports landlock=<0|1> seccomp=<0|1> nnp=... and step=<none|setrlimit|chdir|exec|no_report> errno=<n>.
//   Landlock, seccomp and no_new_privs are OPTIONAL: standard Lambda runs kernel 5.10 and its own seccomp filter refuses
//   ours, so runs must work without them and diagnostics must say what was applied.
//   The call fails closed (internal_error "sandbox unavailable", diagnostics.sandboxStep / errno, nothing runs) only when the
//   launcher cannot start the program safely: a resource limit, the work folder or exec failed, or the child never reported.
// The handler also rejects any event that contains expectedOutput and requires a tenant id when REQUIRE_TENANT_ID=true.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// Replace the process sandbox with a fake before the handler loads it.
const sandboxPath = require.resolve('../function/lib/sandbox');
const calls = [];
let script = [];
let onExec = null;
let zombies = 0;
require.cache[sandboxPath] = {
  id: sandboxPath, filename: sandboxPath, loaded: true,
  exports: {
    MB: 1024 * 1024,
    execLimited: async options => { calls.push(options.mode); return onExec ? onExec(options) : script.shift(); },
    sweepProcesses: async () => ({ killed: 0, survivors: 0 }),
    wipeTmp: () => {},
    countZombies: () => zombies,
    baselineSize: () => 3
  }
};
const { handler } = require('../function/index');

const meta = (extra = {}) => ({
  exitCode: 0, signal: 0, cpuMs: 5, rssKb: 900, landlock: true, seccomp: true, reaped: 0,
  nnp: 'set', nnpErrno: 0, seccompErrno: 0, subreaperErrno: 0, step: 'none', errno: 0, ...extra
});
const done = (m, extra = {}) => ({ meta: m, stdout: Buffer.from('ok\n'), stderr: Buffer.alloc(0), outputTruncated: false, wallKilled: false, ...extra });
const none = { stdout: Buffer.alloc(0) };
const event = { source: 'int main(){}', runs: [{ stdin: '' }, { stdin: '' }], timeLimitMs: 1000, memoryLimitKb: 64000 };
const context = { getRemainingTimeInMillis: () => 30000, tenantId: 'a'.repeat(64) };

// ---- seccomp / Landlock / no_new_privs are optional ----

test('seccomp refused (Lambda): the runs still execute, diagnostics.seccomp false with its errno', async () => {
  calls.length = 0;
  script = [done(meta({ seccomp: false, seccompErrno: 1 })), done(meta({ seccomp: false, seccompErrno: 1 })), done(meta({ seccomp: false, seccompErrno: 1 }))];
  const out = await handler(event, context);
  assert.deepStrictEqual(calls, ['compile', 'run', 'run']);
  assert.deepStrictEqual(out.results.map(r => r.status), ['accepted', 'accepted']);
  assert.strictEqual(out.diagnostics.seccomp, false);
  assert.strictEqual(out.diagnostics.seccompErrno, 1);
  assert.strictEqual(out.diagnostics.sandboxStep, 'none');
});

test('everything refused like on Lambda (no seccomp, no Landlock, nnp already, subreaper refused): runs work and all is reported', async () => {
  calls.length = 0;
  const lambda = () => done(meta({ seccomp: false, landlock: false, nnp: 'already', seccompErrno: 1, subreaperErrno: 1 }));
  script = [lambda(), lambda(), lambda()];
  const out = await handler(event, context);
  assert.deepStrictEqual(out.results.map(r => r.status), ['accepted', 'accepted']);
  assert.strictEqual(out.diagnostics.seccomp, false);
  assert.strictEqual(out.diagnostics.landlock, false);
  assert.strictEqual(out.diagnostics.nnp, 'already');
  assert.strictEqual(out.diagnostics.subreaperErrno, 1);
});

test('seccomp installed: diagnostics.seccomp is true', async () => {
  calls.length = 0;
  script = [done(meta()), done(meta()), done(meta())];
  const out = await handler(event, context);
  assert.strictEqual(out.diagnostics.seccomp, true);
  assert.strictEqual(out.diagnostics.landlock, true);
  assert.strictEqual(out.diagnostics.nnp, 'set');
});

test('a compile error is still a compile error when the platform refuses seccomp', async () => {
  calls.length = 0;
  script = [done(meta({ seccomp: false, seccompErrno: 1, exitCode: 1 }), { stderr: Buffer.from('error: x') })];
  const out = await handler(event, context);
  assert.deepStrictEqual(out.results.map(r => r.status), ['compile_error', 'compile_error']);
  assert.strictEqual(out.diagnostics.seccomp, false);
});

// ---- fail closed only when the program cannot be launched safely ----

for (const [step, errno] of [['setrlimit', 1], ['setpgid', 1], ['chdir', 2], ['exec', 2], ['no_report', 0]]) {
  test(`launcher step ${step} fails while compiling: nothing runs, every run is internal_error, diagnostics say which step`, async () => {
    calls.length = 0;
    script = [done(meta({ exitCode: 125, step, errno }), none)];
    const out = await handler(event, context);

    assert.deepStrictEqual(calls, ['compile']);
    assert.strictEqual(out.results.length, 2);
    for (const result of out.results) {
      assert.strictEqual(result.status, 'internal_error');
      assert.strictEqual(result.message, 'sandbox unavailable');
      assert.strictEqual(result.stdout, '');
    }
    assert.strictEqual(out.diagnostics.sandboxStep, step);
    assert.strictEqual(out.diagnostics.errno, errno);
  });
}

test('the failing step is also reported when the failure happens while running the program', async () => {
  calls.length = 0;
  script = [done(meta()), done(meta({ exitCode: 125, step: 'setrlimit', errno: 22 }), none)];
  const out = await handler(event, context);
  assert.deepStrictEqual(calls, ['compile', 'run']); // the second run was never started
  assert.deepStrictEqual(out.results.map(r => r.status), ['internal_error', 'internal_error']);
  assert.ok(out.results.every(r => r.message === 'sandbox unavailable'));
  assert.strictEqual(out.diagnostics.sandboxStep, 'setrlimit');
  assert.strictEqual(out.diagnostics.errno, 22);
});

test('when everything works sandboxStep is none, errno 0, and a refused PR_SET_CHILD_SUBREAPER is still visible', async () => {
  calls.length = 0;
  script = [done(meta({ subreaperErrno: 1 })), done(meta()), done(meta())];
  const out = await handler(event, context);
  assert.strictEqual(out.diagnostics.sandboxStep, 'none');
  assert.strictEqual(out.diagnostics.errno, 0);
  assert.strictEqual(out.diagnostics.subreaperErrno, 1);
  assert.deepStrictEqual(out.results.map(r => r.status), ['accepted', 'accepted']);
});

// ---- diagnose mode: no student code ----

test('{ diagnose: true } runs the probe and never compiles or runs student code', async () => {
  calls.length = 0;
  const seen = [];
  onExec = options => { seen.push(options); return done(meta(), { stdout: Buffer.from('{"results":[]}\n') }); };
  const out = await handler({ diagnose: true }, context);
  onExec = null;

  assert.strictEqual(out.diagnose, true);
  assert.ok('direct' in out && 'grandchild' in out && 'viaLauncher' in out);
  assert.strictEqual(out.viaLauncher.launcher.step, 'none'); // the launcher's own report is passed through
  assert.strictEqual(typeof out.environment.environmentId, 'string');
  assert.deepStrictEqual(calls, ['run']);
  assert.strictEqual(path.basename(seen[0].argv[0]), 'sandbox-probe');
  assert.ok(!seen.some(o => o.argv.some(a => /main\.cpp|prog$/.test(a))));
});

test('diagnose ignores any source in the event', async () => {
  calls.length = 0;
  onExec = () => done(meta(), { stdout: Buffer.from('{"results":[]}\n') });
  const out = await handler({ diagnose: true, source: 'int main(){ for(;;); }', runs: [{ stdin: '' }] }, context);
  onExec = null;
  assert.strictEqual(out.diagnose, true);
  assert.ok(!calls.includes('compile'));
});

test('only diagnose === true switches the mode on', async () => {
  const out = await handler({ diagnose: 'true' }, context);
  assert.match(out.error, /source is required/);
});

// ---- the runner never sees the expected output ----

test('an event with expectedOutput on a run is rejected and nothing runs', async () => {
  calls.length = 0;
  const out = await handler({ ...event, runs: [{ stdin: '', expectedOutput: 'secret' }] }, context);
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(out.results, []);
  assert.match(out.error, /expectedOutput is not accepted/);
});

test('an event with expectedOutput at the top level is rejected, even when it is empty or null', async () => {
  for (const value of ['x', '', null, undefined]) {
    calls.length = 0;
    const out = await handler({ ...event, expectedOutput: value }, context);
    assert.deepStrictEqual(calls, []);
    assert.match(out.error, /expectedOutput is not accepted/);
  }
});

test('expectedOutput on any run is rejected, even when other runs are fine', async () => {
  calls.length = 0;
  const out = await handler({ ...event, runs: [{ stdin: '' }, { stdin: '', expectedOutput: '' }] }, context);
  assert.deepStrictEqual(calls, []);
  assert.match(out.error, /expectedOutput is not accepted/);
});

test('a run that is not an object is rejected', async () => {
  const out = await handler({ ...event, runs: ['abc'] }, context);
  assert.match(out.error, /each run must be an object/);
});

test('results never contain a verdict on the output: a program that ran fine is "accepted", whatever it printed', async () => {
  calls.length = 0;
  script = [done(meta()), done(meta(), { stdout: Buffer.from('anything at all') }), done(meta(), { stdout: Buffer.alloc(0) })];
  const out = await handler(event, context);
  assert.deepStrictEqual(out.results.map(r => r.status), ['accepted', 'accepted']);
  assert.ok(out.results.every(r => !('expectedOutput' in r)));
});

// ---- tenant id ----

test('with REQUIRE_TENANT_ID=true a call without a tenant id is refused and nothing runs', async () => {
  process.env.REQUIRE_TENANT_ID = 'true';
  try {
    for (const ctx of [{ getRemainingTimeInMillis: () => 30000 }, { ...context, tenantId: '' }, { ...context, tenantId: undefined }, undefined]) {
      calls.length = 0;
      const out = await handler(event, ctx);
      assert.deepStrictEqual(calls, []);
      assert.deepStrictEqual(out.results, []);
      assert.match(out.error, /tenant id required/);
    }
    // diagnose is refused as well
    assert.match((await handler({ diagnose: true }, { getRemainingTimeInMillis: () => 1 })).error, /tenant id required/);
  } finally {
    delete process.env.REQUIRE_TENANT_ID;
  }
});

test('with REQUIRE_TENANT_ID=true a call that carries a tenant id runs normally', async () => {
  process.env.REQUIRE_TENANT_ID = 'true';
  try {
    calls.length = 0;
    script = [done(meta()), done(meta()), done(meta())];
    const out = await handler(event, context);
    assert.deepStrictEqual(out.results.map(r => r.status), ['accepted', 'accepted']);
  } finally {
    delete process.env.REQUIRE_TENANT_ID;
  }
});

test('without REQUIRE_TENANT_ID (local Docker tests) no tenant id is needed', async () => {
  calls.length = 0;
  script = [done(meta()), done(meta()), done(meta())];
  const out = await handler(event, { getRemainingTimeInMillis: () => 30000 });
  assert.deepStrictEqual(out.results.map(r => r.status), ['accepted', 'accepted']);
});

// ---- environment id (used to prove that tenants never share an environment) ----

test('every reply names the environment, and calls in the same environment share the id and count up', async () => {
  script = [done(meta()), done(meta()), done(meta()), done(meta()), done(meta()), done(meta())];
  const a = await handler(event, context);
  const b = await handler(event, context);
  assert.match(a.diagnostics.environmentId, /^[0-9a-f]{16}$/);
  assert.strictEqual(a.diagnostics.environmentId, b.diagnostics.environmentId);
  assert.strictEqual(b.diagnostics.callsInEnvironment, a.diagnostics.callsInEnvironment + 1);
});

// ---- the handler never ends the process: once.js does, after posting the response ----

test('the handler itself never ends the process (once.js posts the response, then exits)', async () => {
  const realExit = process.exit;
  let exitedWith = null;
  process.exit = code => { exitedWith = code; };
  try {
    script = [done(meta()), done(meta()), done(meta())];
    const out = await handler(event, context);
    assert.deepStrictEqual(out.results.map(r => r.status), ['accepted', 'accepted']);
    await new Promise(r => setTimeout(r, 250));
    assert.strictEqual(exitedWith, null);
  } finally {
    process.exit = realExit;
  }
});

// ---- zombies that nobody reaps ----

test('when leftover zombies have used up the process limit the call says so at once', async () => {
  calls.length = 0;
  zombies = 150;
  try {
    const out = await handler(event, context);
    assert.deepStrictEqual(calls, []); // nothing was started
    assert.ok(out.results.every(r => r.status === 'internal_error' && /exhausted/.test(r.message)));
    assert.strictEqual(out.diagnostics.zombies, 150);
  } finally {
    zombies = 0;
  }
});

// ---- compile command ----

test('the compile command limits error output to 50 errors', async () => {
  let argv;
  onExec = options => { argv = options.argv; return done(meta({ exitCode: 1 })); };
  await handler(event, context);
  assert.ok(argv.includes('-fmax-errors=50'));
  assert.strictEqual(path.basename(argv[0]), 'g++');
  onExec = null;
});

// ---- reply size ----

test('a reply that would exceed Lambda\'s response limit replaces the results that no longer fit', async () => {
  calls.length = 0;
  const big = Buffer.alloc(1024 * 1024, 'a'); // 1 MB of output per run, 8 runs
  const runs = Array.from({ length: 8 }, () => ({ stdin: '' }));
  onExec = options => (options.mode === 'compile' ? done(meta()) : done(meta(), { stdout: big }));
  const out = await handler({ ...event, runs }, context);
  onExec = null;
  assert.strictEqual(out.results.length, 8);
  assert.ok(Buffer.byteLength(JSON.stringify(out.results)) < 6 * 1024 * 1024);
  assert.strictEqual(out.results[0].status, 'accepted');
  assert.strictEqual(out.results[7].status, 'internal_error');
  assert.match(out.results[7].message, /too large/);
});
