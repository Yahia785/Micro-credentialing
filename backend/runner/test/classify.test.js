// node --test test/classify.test.js   (no Docker needed)
// How a finished program becomes a runner status. The runner never sees the expected output, so a program that ran
// fine is "accepted"; wrong_answer is decided by the provider (shared/nodejs/utils/codeRunnerOwn.js).
const test = require('node:test');
const assert = require('node:assert');
const { classifyRun } = require('../function/lib/classify');

const out = text => Buffer.from(text, 'utf-8');

test('statuses and Judge0 wording', () => {
  const run = (meta, extra = {}) => ({ meta: { exitCode: 0, signal: 0, cpuMs: 10, rssKb: 1000, landlock: true, seccomp: true, reaped: 0, ...meta },
    stdout: out('ok\n'), stderr: out(''), outputTruncated: false, wallKilled: false, ...extra });
  const limits = { timeLimitMs: 1000, memoryLimitKb: 64000 };

  assert.strictEqual(classifyRun(run({}), limits).status, 'accepted');
  assert.strictEqual(classifyRun(run({}), limits).statusText, 'Accepted');
  assert.strictEqual(classifyRun(run({ exitCode: 3 }), limits).statusText, 'Runtime Error (NZEC)');
  assert.strictEqual(classifyRun(run({ exitCode: -1, signal: 11 }), limits).statusText, 'Runtime Error (SIGSEGV)');
  assert.strictEqual(classifyRun(run({ exitCode: -1, signal: 6 }), limits).statusText, 'Runtime Error (SIGABRT)');
  assert.strictEqual(classifyRun(run({ exitCode: -1, signal: 8 }), limits).statusText, 'Runtime Error (SIGFPE)');
  assert.strictEqual(classifyRun(run({ cpuMs: 1001 }), limits).status, 'time_limit');
  assert.strictEqual(classifyRun(run({ exitCode: -1, signal: 24 }), limits).status, 'time_limit');
  assert.strictEqual(classifyRun(run({}, { wallKilled: true }), limits).status, 'time_limit');
  assert.strictEqual(classifyRun(run({ exitCode: -1, signal: 6, rssKb: 60000 }), limits).status, 'memory_limit');
  assert.strictEqual(classifyRun(run({ exitCode: -1, signal: 6 }, { stderr: out('terminate called after throwing std::bad_alloc') }), limits).status, 'memory_limit');
  assert.strictEqual(classifyRun(run({ exitCode: -1, signal: 9 }, { outputTruncated: true }), limits).statusText, 'Runtime Error (SIGXFSZ)');
  assert.strictEqual(classifyRun({ meta: null, stdout: out(''), stderr: out(''), outputTruncated: false, wallKilled: false }, limits).status, 'internal_error');
});

test('invalid UTF-8 output is flagged, valid output is not', () => {
  const run = stdout => ({ meta: { exitCode: 0, signal: 0, cpuMs: 1, rssKb: 1, landlock: true, seccomp: true, reaped: 0 },
    stdout, stderr: out(''), outputTruncated: false, wallKilled: false });
  const limits = { timeLimitMs: 1000, memoryLimitKb: 64000 };
  assert.strictEqual(classifyRun(run(out('plain\n')), limits).stdoutInvalidUtf8, false);
  assert.strictEqual(classifyRun(run(Buffer.from([0xff, 0xfe, 0x0a])), limits).stdoutInvalidUtf8, true);
});
