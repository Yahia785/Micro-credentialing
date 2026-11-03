// node --test test/failclosed.test.js   (no Docker needed)
// The launcher reports landlock=<0|1> seccomp=<0|1>.
//   seccomp is REQUIRED: if the filter cannot be installed the launcher does not run the program, and the handler must
//   return internal_error "sandbox unavailable" for every run, with diagnostics.seccomp false, and never start a student program.
//   Landlock is OPTIONAL: standard Lambda runs kernel 5.10 (Landlock needs 5.13), so runs must work without it and
//   diagnostics.landlock must say so.
// The handler also rejects any event that contains expectedOutput.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// Replace the process sandbox with a fake before the handler loads it.
const sandboxPath = require.resolve('../function/lib/sandbox');
const calls = [];
let script = [];
let onExec = null;
require.cache[sandboxPath] = {
  id: sandboxPath, filename: sandboxPath, loaded: true,
  exports: {
    MB: 1024 * 1024,
    execLimited: async options => { calls.push(options.mode); return onExec ? onExec(options) : script.shift(); },
    sweepProcesses: async () => ({ killed: 0, survivors: 0 }),
    wipeTmp: () => {}
  }
};
const { handler } = require('../function/index');

const meta = (extra = {}) => ({ exitCode: 0, signal: 0, cpuMs: 5, rssKb: 900, landlock: true, seccomp: true, reaped: 0, ...extra });
const done = (m, extra = {}) => ({ meta: m, stdout: Buffer.from('ok\n'), stderr: Buffer.alloc(0), outputTruncated: false, wallKilled: false, ...extra });
const event = { source: 'int main(){}', runs: [{ stdin: '' }, { stdin: '' }], timeLimitMs: 1000, memoryLimitKb: 64000 };
const context = { getRemainingTimeInMillis: () => 30000 };

// ---- seccomp required (fails closed) ----

test('seccomp fails while compiling: nothing runs, every run is internal_error, diagnostics.seccomp false', async () => {
  calls.length = 0;
  // The launcher exits 125 without running g++ when the filter cannot be installed.
  script = [done(meta({ seccomp: false, exitCode: 125 }), { stdout: Buffer.alloc(0) })];
  const out = await handler(event, context);

  assert.deepStrictEqual(calls, ['compile']);
  assert.strictEqual(out.results.length, 2);
  for (const result of out.results) {
    assert.strictEqual(result.status, 'internal_error');
    assert.strictEqual(result.message, 'sandbox unavailable');
    assert.strictEqual(result.stdout, '');
  }
  assert.strictEqual(out.diagnostics.seccomp, false);
});

test('seccomp fails when running the program: no further run starts, every run is internal_error', async () => {
  calls.length = 0;
  script = [done(meta()), done(meta({ seccomp: false, exitCode: 125 }), { stdout: Buffer.alloc(0) })];
  const out = await handler(event, context);

  assert.deepStrictEqual(calls, ['compile', 'run']); // the second run was never started
  assert.deepStrictEqual(out.results.map(r => r.status), ['internal_error', 'internal_error']);
  assert.ok(out.results.every(r => r.message === 'sandbox unavailable'));
  assert.strictEqual(out.diagnostics.seccomp, false);
});

test('seccomp installed: the runs execute and diagnostics.seccomp is true', async () => {
  calls.length = 0;
  script = [done(meta()), done(meta()), done(meta())];
  const out = await handler(event, context);
  assert.deepStrictEqual(calls, ['compile', 'run', 'run']);
  assert.deepStrictEqual(out.results.map(r => r.status), ['accepted', 'accepted']);
  assert.strictEqual(out.diagnostics.seccomp, true);
});

test('a compile error is still a compile error when seccomp is installed', async () => {
  calls.length = 0;
  script = [done(meta({ exitCode: 1 }), { stderr: Buffer.from('error: x') })];
  const out = await handler(event, context);
  assert.deepStrictEqual(out.results.map(r => r.status), ['compile_error', 'compile_error']);
  assert.strictEqual(out.diagnostics.seccomp, true);
});

// ---- Landlock optional ----

test('no Landlock (old kernel) does not stop anything: runs execute, diagnostics.landlock is false, seccomp true', async () => {
  calls.length = 0;
  script = [done(meta({ landlock: false })), done(meta({ landlock: false })), done(meta({ landlock: false }))];
  const out = await handler(event, context);

  assert.deepStrictEqual(calls, ['compile', 'run', 'run']);
  assert.deepStrictEqual(out.results.map(r => r.status), ['accepted', 'accepted']);
  assert.strictEqual(out.diagnostics.landlock, false);
  assert.strictEqual(out.diagnostics.seccomp, true);
});

test('with Landlock applied diagnostics.landlock is true', async () => {
  calls.length = 0;
  script = [done(meta()), done(meta()), done(meta())];
  const out = await handler(event, context);
  assert.strictEqual(out.diagnostics.landlock, true);
});

test('no Landlock AND no seccomp: still fails closed because of seccomp', async () => {
  calls.length = 0;
  script = [done(meta({ landlock: false, seccomp: false, exitCode: 125 }), { stdout: Buffer.alloc(0) })];
  const out = await handler(event, context);
  assert.ok(out.results.every(r => r.status === 'internal_error' && r.message === 'sandbox unavailable'));
  assert.strictEqual(out.diagnostics.seccomp, false);
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
