// node run-fixtures.js   verdicts for the normal-program fixture: the runner container runs the programs (it never sees an
// expected output), and the verdict is decided the way the provider does it, with the Judge0-matching comparison
// from shared/nodejs/utils/outputCompare.js.
const c = require('./container');
const programs = require('./fixtures/normal');
const { outputMatches } = require('../../shared/nodejs/utils/outputCompare');

/** What codeRunnerOwn.js does with the runner's reply. */
function verdict(reply, expectedOutput) {
  if (reply.status !== 'accepted') return reply.status;
  const none = expectedOutput === undefined || expectedOutput === null || expectedOutput === '';
  const matches = none || (!reply.stdoutInvalidUtf8 && outputMatches(expectedOutput, Buffer.from(reply.stdout, 'utf-8')));
  return matches ? 'accepted' : 'wrong_answer';
}

c.start();
let bad = 0;
const rows = [];
for (const p of programs) {
  const { body } = c.invoke({
    source: p.source,
    runs: p.runs.map(r => ({ stdin: r.stdin })),
    timeLimitMs: p.timeLimitMs, memoryLimitKb: p.memoryLimitKb || 256000
  });
  p.runs.forEach((run, i) => {
    const got = body.results && body.results[i];
    const status = got ? verdict(got, run.expectedOutput) : null;
    const ok = status === run.status;
    if (!ok) bad++;
    rows.push({ program: p.name, run: i, expected: run.status, got: status || JSON.stringify(body).slice(0, 80), cpuMs: got ? got.timeMs : '', result: ok ? 'ok' : 'MISMATCH' });
  });
}
console.table(rows);
console.log(`runs: ${rows.length}, programs: ${programs.length}, mismatches: ${bad}`);
c.stop();
process.exit(bad ? 1 : 0);
