// node run-fixtures.js   verdicts of the runner container for the normal-program fixture
const c = require('./container');
const programs = require('./fixtures/normal');

c.start();
let bad = 0;
const rows = [];
for (const p of programs) {
  const { body } = c.invoke({
    source: p.source,
    runs: p.runs.map(r => ({ stdin: r.stdin, expectedOutput: r.expectedOutput })),
    timeLimitMs: p.timeLimitMs, memoryLimitKb: p.memoryLimitKb || 256000
  });
  p.runs.forEach((run, i) => {
    const got = body.results && body.results[i];
    const ok = got && got.status === run.status;
    if (!ok) bad++;
    rows.push({ program: p.name, run: i, expected: run.status, got: got ? got.status : JSON.stringify(body).slice(0, 80), cpuMs: got ? got.timeMs : '', result: ok ? 'ok' : 'MISMATCH' });
  });
}
console.table(rows);
console.log(`runs: ${rows.length}, programs: ${programs.length}, mismatches: ${bad}`);
c.stop();
process.exit(bad ? 1 : 0);
