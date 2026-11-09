// node --test test/stress-runner.test.js   (no AWS: only the planning, workload and report helpers)
const test = require('node:test');
const assert = require('node:assert');
const s = require('../scripts/stress-runner');

test('workload: 10% slow, 5% compile errors, the rest typical, 5 test inputs each, always the same for a seed', () => {
  const w = s.buildWorkload(100);
  const count = k => w.filter(c => c.kind === k).length;
  assert.deepStrictEqual([count('slow'), count('compileError'), count('typical')], [10, 5, 85]);
  assert.ok(w.every(c => c.event.runs.length === 5));
  assert.ok(w.filter(c => c.kind === 'slow').every(c => c.event.timeLimitMs === 1000));
  assert.deepStrictEqual(s.buildWorkload(100), w);
  assert.strictEqual(s.buildWorkload(1).length, 1);
  assert.strictEqual(s.buildWorkload(1)[0].kind, 'typical');
  assert.ok(w.every(c => !('expectedOutput' in c.event.runs[0])));
});

test('levels: the cap is the account limit minus 20; below 50 only levels 1 and 5 and no steady load', () => {
  assert.deepStrictEqual(s.planLevels(1000), { cap: 980, levels: [1, 5, 10, 25, 50, 100], steady: true });
  assert.deepStrictEqual(s.planLevels(100), { cap: 80, levels: [1, 5, 10, 25, 50], steady: true });
  assert.deepStrictEqual(s.planLevels(60), { cap: 40, levels: [1, 5, 10, 25], steady: true });
  assert.deepStrictEqual(s.planLevels(45), { cap: 25, levels: [1, 5], steady: false });
  assert.deepStrictEqual(s.planLevels(10), { cap: 5, levels: [1, 5], steady: false });
  assert.deepStrictEqual(s.planLevels(4), { cap: 2, levels: [1], steady: false });
  for (const limit of [4, 10, 45, 60, 100, 1000]) assert.ok(s.planLevels(limit).levels.every(l => l <= s.planLevels(limit).cap));
});

test('percentiles, REPORT parsing and cost', () => {
  const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.strictEqual(s.percentile(sorted, 50), 50);
  assert.strictEqual(s.percentile(sorted, 95), 100);
  assert.strictEqual(s.percentile([], 95), 0);
  assert.deepStrictEqual(s.parseReport('REPORT RequestId: x Duration: 1.2 ms Billed Duration: 2 ms Memory Size: 1769 MB Init Duration: 512.5 ms'), { billedMs: 2, coldStart: true, initMs: 512.5 });
  assert.strictEqual(s.parseReport('REPORT Billed Duration: 7 ms').coldStart, false);
  assert.strictEqual(s.parseReport(null).billedMs, null);
  // 1 GB-second at 1769 MB = 1.7275 GB-s: 1000 ms -> 1.7275 * 0.0000166667, plus one request
  assert.ok(Math.abs(s.costOf(1000, 1) - (1.7275 * 0.0000166667 + 0.0000002)) < 1e-8);
  assert.ok(Math.abs(s.costOf(0, 1e6) - 0.2) < 1e-9);
});

test('summary counts throttles, function errors, internal errors, cold starts; failure rate drives the 5% stop', () => {
  const results = [
    { latencyMs: 100, billedMs: 100, coldStart: true },
    { latencyMs: 200, billedMs: 200 },
    { latencyMs: 5, throttled: true, error: 'TooManyRequestsException: x' },
    { latencyMs: 300, billedMs: 300, functionError: 'Unhandled' },
    { latencyMs: 400, billedMs: 400, internalErrors: 2 }
  ];
  const sum = s.summarize(results, 1000);
  assert.deepStrictEqual([sum.calls, sum.coldStarts, sum.throttles, sum.functionErrors, sum.otherErrors, sum.internalErrors, sum.billedMs], [5, 1, 1, 1, 0, 2, 1000]);
  assert.strictEqual(sum.max, 400);
  assert.strictEqual(s.failureRate(sum), 0.4);
  assert.strictEqual(s.failureRate(s.summarize([{ latencyMs: 1 }, { latencyMs: 1 }], 0)), 0);
});

test('recommendation: reserved concurrency within what the account allows, and whether the limit is enough for 100 students', () => {
  const small = s.recommend({ accountLimit: 10, meanLatencySec: 1, highestCleanLevel: 5 });
  assert.strictEqual(small.reserved, 0);
  assert.strictEqual(small.enough, false);
  const big = s.recommend({ accountLimit: 1000, meanLatencySec: 1, highestCleanLevel: 100 });
  assert.strictEqual(big.worstSustained, 17); // 100 students x 10 runs/min / 60 x 1 s
  assert.strictEqual(big.reserved, 26);
  assert.strictEqual(big.enough, true);
  assert.strictEqual(s.recommend({ accountLimit: 110, meanLatencySec: 1, highestCleanLevel: 5 }).reserved, 10);
});

test('estimate and arguments', () => {
  const e = s.estimate({ typical: 85, slow: 10, compileError: 5 });
  assert.strictEqual(e.calls, 100);
  assert.ok(e.cost > 0 && e.cost < 0.01);
  assert.strictEqual(s.parseArgs(['--dry-run', '--account-limit', '10']).accountLimit, 10);
  assert.throws(() => s.parseArgs(['--x']));
});
