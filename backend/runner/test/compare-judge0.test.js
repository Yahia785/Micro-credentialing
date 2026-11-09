// node --test test/compare-judge0.test.js   (no network: the providers are fakes)
const test = require('node:test');
const assert = require('node:assert');
const { compare, differences, toRuns, select, parseArgs } = require('../scripts/compare-judge0');
const programs = require('./fixtures/normal');

const same = runs => runs.map(r => ({ status: r.expectedOutput === 'x' ? 'wrong_answer' : 'accepted', stdout: 'out\n' }));

test('the fixture is 29 programs and 37 runs, and toRuns keeps the expected output for the providers', () => {
  assert.strictEqual(programs.length, 29);
  assert.strictEqual(programs.reduce((n, p) => n + p.runs.length, 0), 37);
  const runs = toRuns(programs[0]);
  assert.strictEqual(runs.length, 3);
  assert.deepStrictEqual(Object.keys(runs[0]).sort(), ['expectedOutput', 'memoryLimitKb', 'source', 'stdin', 'timeLimitMs']);
});

test('one batch per program on each side, and identical results give no mismatch', async () => {
  const calls = { judge0: 0, own: 0 };
  const providers = { judge0: async r => { calls.judge0++; return same(r); }, own: async r => { calls.own++; return same(r); } };
  const { rows, mismatches } = await compare(programs, providers);
  assert.deepStrictEqual(calls, { judge0: 29, own: 29 });
  assert.strictEqual(rows.length, 37);
  assert.deepStrictEqual(mismatches, []);
});

test('status and stdout differences are listed; stdout only matters for accepted / wrong_answer', () => {
  assert.deepStrictEqual(differences({ status: 'accepted', stdout: 'a' }, { status: 'accepted', stdout: 'a' }), []);
  assert.match(differences({ status: 'accepted', stdout: 'a' }, { status: 'wrong_answer', stdout: 'a' })[0], /status: judge0 accepted, own wrong_answer/);
  assert.match(differences({ status: 'accepted', stdout: 'a' }, { status: 'accepted', stdout: 'b' })[0], /^stdout/);
  assert.deepStrictEqual(differences({ status: 'runtime_error', stdout: 'a' }, { status: 'runtime_error', stdout: 'b' }), []);
});

test('a provider failure becomes internal_error for that program instead of stopping the comparison', async () => {
  const providers = { judge0: async () => { throw new Error('quota'); }, own: async r => same(r) };
  const { rows, mismatches } = await compare(programs.slice(0, 2), providers);
  assert.ok(rows.every(r => r.judge0 === 'internal_error'));
  assert.ok(mismatches.length >= 3);
});

test('select / parseArgs: --limit, --skip, --only (1-based), --dry-run', () => {
  assert.strictEqual(select(programs, { only: null, limit: 5, skip: 0 }).length, 5);
  assert.strictEqual(select(programs, { only: null, limit: 5, skip: 27 }).length, 2);
  assert.deepStrictEqual(select(programs, { only: [1, 3], limit: null, skip: 0 }).map(p => p.name), [programs[0].name, programs[2].name]);
  const o = parseArgs(['--limit', '4', '--skip', '8', '--dry-run']);
  assert.deepStrictEqual([o.limit, o.skip, o.dryRun], [4, 8, true]);
  assert.throws(() => parseArgs(['--bogus']));
});
