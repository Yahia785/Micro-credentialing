// node --test runner/test    (no Docker needed)
// Each case is derived from Judge0's rule:  strip(t) = t.split("\n").collect(&:rstrip).join("\n").rstrip
// and  expected.nil? || strip(expected) == strip(stdout)   (empty stdout counts as nil).
const test = require('node:test');
const assert = require('node:assert');
const { outputMatches, judge0Strip } = require('../function/lib/compare');
const { classifyRun } = require('../function/lib/classify');

const out = text => Buffer.from(text, 'utf-8');

test('trailing whitespace on every line is ignored', () => {
  assert.ok(outputMatches('a\nb', out('a  \nb\t\n')));
  assert.ok(outputMatches('a  \nb', out('a\nb')));
});

test('CRLF equals LF (the \\r is trailing whitespace)', () => {
  assert.ok(outputMatches('1\n2\n', out('1\r\n2\r\n')));
});

test('trailing blank lines and a missing final newline are ignored', () => {
  assert.ok(outputMatches('x', out('x\n\n\n')));
  assert.ok(outputMatches('x\n\n', out('x')));
  assert.ok(outputMatches('x \n \n', out('x')));
});

test('NUL, \\v and \\f count as trailing whitespace like Ruby rstrip', () => {
  assert.ok(outputMatches('x', out('x\0\0')));
  assert.ok(outputMatches('x', out('x\v\f')));
});

test('leading whitespace, inner blank lines, inner spaces and case are significant', () => {
  assert.ok(!outputMatches('x', out(' x')));
  assert.ok(!outputMatches('a\nb', out('a\n\nb')));
  assert.ok(!outputMatches('a b', out('a  b')));
  assert.ok(!outputMatches('yes', out('Yes')));
});

test('no expected output means accepted, whatever the program printed', () => {
  assert.ok(outputMatches(undefined, out('anything')));
  assert.ok(outputMatches(null, out('')));
  assert.ok(outputMatches('', out('anything')));
});

test('empty stdout is nil, so it only matches a nil expected output', () => {
  assert.ok(!outputMatches('x', out('')));
  assert.ok(!outputMatches('\n', out(''))); // strip("\n") is "" but strip(nil) is nil
  assert.ok(outputMatches('\n', out('\n'))); // "" == ""
});

test('invalid UTF-8 is compared byte for byte (Ruby raises ArgumentError and returns the text as is)', () => {
  const bad = Buffer.from([0xff, 0xfe, 0x0a]);
  assert.ok(Buffer.isBuffer(judge0Strip(bad)));
  assert.ok(!outputMatches('x', bad));
  assert.ok(!outputMatches('��', bad));
});

test('classify: statuses and Judge0 wording', () => {
  const run = (meta, extra = {}) => ({ meta: { exitCode: 0, signal: 0, cpuMs: 10, rssKb: 1000, landlock: true, reaped: 0, ...meta },
    stdout: out('ok\n'), stderr: out(''), outputTruncated: false, wallKilled: false, ...extra });
  const limits = { timeLimitMs: 1000, memoryLimitKb: 64000, expectedOutput: 'ok' };

  assert.strictEqual(classifyRun(run({}), limits).status, 'accepted');
  assert.strictEqual(classifyRun(run({}), { ...limits, expectedOutput: 'no' }).statusText, 'Wrong Answer');
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
