// node run-hostile.js [--no-landlock] [--seccomp-unconfined]
// Runs every hostile program in the container, then checks status, wall time, what the program printed, and that
// nothing was left behind (no student process, empty /tmp). Also checks the NEXT call is clean.
//
// --no-landlock starts the container with a Docker profile that blocks the Landlock syscalls, which is what standard
// Lambda (kernel 5.10) looks like: seccomp is installed, Landlock is not. Cases that rely on the Landlock file
// policy (needsLandlock) are skipped there; every other case must still pass.
const c = require('./container');
const cases = require('./hostile');

const startOptions = { seccompUnconfined: process.argv.includes('--seccomp-unconfined'), noLandlock: process.argv.includes('--no-landlock') };
c.start(startOptions);

const rows = [];
let failures = 0;
let skipped = 0;
for (const t of cases) {
  if (t.needsLandlock && startOptions.noLandlock) { skipped++; rows.push({ name: t.name, status: '-', ms: '', cpu: '', killed: '', out: '', result: 'skipped (needs Landlock)' }); continue; }
  console.log('>', t.name);
  const limits = { timeLimitMs: t.timeLimitMs || 1000, memoryLimitKb: t.memoryLimitKb || 128000 };
  const { body, wallMs } = c.invoke({ source: t.source, runs: [{ stdin: '' }], ...limits });
  const r = body.results && body.results[0];
  let died = false;
  if (!c.running()) { died = true; c.start(startOptions); }
  const left = c.inspect();
  const d = body.diagnostics || {};

  const problems = [];
  if (died && !t.expectDeath) problems.push('CONTAINER DIED');
  if (!r && t.expectDeath) { /* the runtime was killed: Lambda reports a function error */ }
  else if (!r) problems.push(`no result: ${JSON.stringify(body).slice(0, 200)}`);
  else {
    if (t.expect !== 'any' && r.status !== t.expect) problems.push(`status ${r.status}, wanted ${t.expect}`);
    if (t.expectStdout !== undefined && r.stdout.trim() !== t.expectStdout) problems.push(`stdout ${JSON.stringify(r.stdout.trim().slice(0, 120))}, wanted ${JSON.stringify(t.expectStdout)}`);
    if (t.check && !t.check(r)) problems.push('content check failed');
    if (r.status === 'internal_error' && !t.allowInternal) problems.push(`internal_error: ${r.message}`);
  }
  if (d.seccomp === false) problems.push('seccomp false');
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
const after = c.invoke({ source: '#include <cstdio>\nint main(){puts("hi");}', runs: [{ stdin: '' }], timeLimitMs: 1000, memoryLimitKb: 64000 });
const healthy = after.body.results && after.body.results[0].status === 'accepted' && after.body.results[0].stdout.trim() === 'hi';
console.table(rows);
console.log('diagnostics in last call:', JSON.stringify(after.body.diagnostics));
console.log(`healthy after corpus: ${healthy}; failures: ${failures}/${cases.length - skipped} (skipped ${skipped})`);
c.stop();
process.exit(failures || !healthy ? 1 : 0);
