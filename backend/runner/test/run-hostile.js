// node run-hostile.js [--seccomp-unconfined]
// Runs every hostile program in the container, then checks status, wall time, and that nothing was
// left behind (no student process, empty /tmp). Also checks the NEXT call is clean.
const c = require('./container');
const cases = require('./hostile');

c.start({ seccompUnconfined: process.argv.includes('--seccomp-unconfined') });

const rows = [];
let failures = 0;
for (const t of cases) {
  console.log('>', t.name);
  const limits = { timeLimitMs: t.timeLimitMs || 1000, memoryLimitKb: t.memoryLimitKb || 128000 };
  const { body, wallMs } = c.invoke({ source: t.source, runs: [{ stdin: '', expectedOutput: t.expectedOutput }], ...limits });
  const r = body.results && body.results[0];
  let died = false;
  if (!c.running()) { died = true; c.start({ seccompUnconfined: process.argv.includes('--seccomp-unconfined') }); }
  const left = c.inspect();
  const d = body.diagnostics || {};

  const problems = [];
  if (died && !t.expectDeath) problems.push('CONTAINER DIED');
  if (!r && t.expectDeath) { /* the runtime was killed: Lambda reports a function error */ }
  else if (!r) problems.push(`no result: ${JSON.stringify(body).slice(0, 200)}`);
  else {
    if (t.expect !== 'any' && r.status !== t.expect) problems.push(`status ${r.status}, wanted ${t.expect}`);
    if (t.check && !t.check(r)) problems.push('content check failed');
    if (r.status === 'internal_error' && !t.allowInternal) problems.push(`internal_error: ${r.message}`);
  }
  if (wallMs > (t.maxWallMs || 6000)) problems.push(`took ${wallMs} ms`);
  if (left.strangers.length) problems.push(`processes left: ${left.strangers.join(',')}`);
  if (left.tmp.length && !t.expectDeath) problems.push(`/tmp not empty: ${left.tmp.join(',')}`);
  if (t.expectLeftoversKilled && !(d.leftoverKilled >= 1)) problems.push('sweep did not report a killed leftover');
  if (problems.length) failures++;

  rows.push({
    name: t.name + (died ? ' [container died, restarted]' : ''), status: r ? r.status : 'none', ms: wallMs, cpu: r ? r.timeMs : '', killed: d.leftoverKilled ?? '',
    out: r ? (r.stdout.length ? `${r.stdout.length}B out` : '') : '', result: problems.length ? `FAIL ${problems.join('; ')}` : 'ok'
  });
}

// A final normal call proves the container is still healthy after all of that.
const after = c.invoke({ source: '#include <cstdio>\nint main(){puts("hi");}', runs: [{ stdin: '', expectedOutput: 'hi' }], timeLimitMs: 1000, memoryLimitKb: 64000 });
const healthy = after.body.results && after.body.results[0].status === 'accepted';
console.table(rows);
console.log('landlock in last call:', JSON.stringify(after.body.diagnostics));
console.log(`healthy after corpus: ${healthy}; failures: ${failures}/${cases.length}`);
c.stop();
process.exit(failures || !healthy ? 1 : 0);
