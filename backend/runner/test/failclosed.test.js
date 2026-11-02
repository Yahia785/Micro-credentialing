// node --test runner/test/failclosed.test.js   (no Docker needed)
// When Landlock cannot be applied the launcher reports landlock=0 and does not run the program.
// The handler must then return internal_error "sandbox unavailable" for every run, with
// diagnostics.landlock false, and must never start a student program.
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

const meta = (extra = {}) => ({ exitCode: 0, signal: 0, cpuMs: 5, rssKb: 900, landlock: true, reaped: 0, ...extra });
const done = (m, extra = {}) => ({ meta: m, stdout: Buffer.from('ok\n'), stderr: Buffer.alloc(0), outputTruncated: false, wallKilled: false, ...extra });
const event = { source: 'int main(){}', runs: [{ stdin: '', expectedOutput: 'ok' }, { stdin: '', expectedOutput: 'ok' }], timeLimitMs: 1000, memoryLimitKb: 64000 };
const context = { getRemainingTimeInMillis: () => 30000 };

test('Landlock fails while compiling: nothing runs, every run is internal_error', async () => {
  calls.length = 0;
  // The launcher exits 125 without running g++ when Landlock cannot be applied.
  script = [done(meta({ landlock: false, exitCode: 125 }), { stdout: Buffer.alloc(0) })];
  const out = await handler(event, context);

  assert.deepStrictEqual(calls, ['compile']);
  assert.strictEqual(out.results.length, 2);
  for (const result of out.results) {
    assert.strictEqual(result.status, 'internal_error');
    assert.strictEqual(result.message, 'sandbox unavailable');
    assert.strictEqual(result.stdout, '');
  }
  assert.strictEqual(out.diagnostics.landlock, false);
});

test('Landlock fails when running the program: no further run starts, every run is internal_error', async () => {
  calls.length = 0;
  script = [done(meta()), done(meta({ landlock: false, exitCode: 125 }), { stdout: Buffer.alloc(0) })];
  const out = await handler(event, context);

  assert.deepStrictEqual(calls, ['compile', 'run']); // the second run was never started
  assert.deepStrictEqual(out.results.map(r => r.status), ['internal_error', 'internal_error']);
  assert.ok(out.results.every(r => r.message === 'sandbox unavailable'));
  assert.strictEqual(out.diagnostics.landlock, false);
});

test('a compile error is still a compile error when Landlock works', async () => {
  calls.length = 0;
  script = [done(meta({ exitCode: 1 }), { stderr: Buffer.from('error: x') })];
  const out = await handler(event, context);
  assert.deepStrictEqual(out.results.map(r => r.status), ['compile_error', 'compile_error']);
  assert.strictEqual(out.diagnostics.landlock, true);
});

test('with Landlock applied the runs execute and diagnostics.landlock is true', async () => {
  calls.length = 0;
  script = [done(meta()), done(meta()), done(meta())];
  const out = await handler(event, context);
  assert.deepStrictEqual(calls, ['compile', 'run', 'run']);
  assert.deepStrictEqual(out.results.map(r => r.status), ['accepted', 'accepted']);
  assert.strictEqual(out.diagnostics.landlock, true);
});

test('the compile command limits error output to 50 errors', async () => {
  let argv;
  onExec = options => { argv = options.argv; return done(meta({ exitCode: 1 })); };
  await handler(event, context);
  assert.ok(argv.includes('-fmax-errors=50'));
  assert.strictEqual(path.basename(argv[0]), 'g++');
  onExec = null;
});
