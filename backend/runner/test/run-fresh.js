// node run-fresh.js   Docker + the Lambda Runtime Interface Emulator: 10 sequential calls through the custom runtime
// (bootstrap -> one-shot worker). Every call must succeed without a function error, run in a fresh worker process (new
// environment id, call #1), and the bootstrap must stay the same process throughout.
const c = require('./container');
const { execFileSync } = require('child_process');

const SRC = '#include <cstdio>\nint main(){puts("ok");}';
const ev = { source: SRC, runs: [{ stdin: '' }], timeLimitMs: 2000, memoryLimitKb: 65536 };

const bootstrapPid = () => {
  const out = execFileSync('docker', ['exec', '-u', '0', c.NAME, 'sh', '-c', 'for p in /proc/[0-9]*; do n=$(cat $p/comm 2>/dev/null); [ "$n" = runner-bootstra ] && echo ${p#/proc/}; done; true'], { encoding: 'utf-8' });
  return out.trim().split(/\s+/).join(',');
};

c.start();
const problems = [];
const rows = [];
let before = '';
for (let i = 1; i <= 10; i++) {
  const { body, wallMs } = c.invoke(ev);
  const r = body.results && body.results[0];
  const d = body.diagnostics || {};
  rows.push({ call: i, status: r ? r.status : (body.errorMessage || body.transportError || 'no result'), 'call#': d.callsInEnvironment, env: d.environmentId, ms: wallMs });
  if (!r || r.status !== 'accepted' || r.stdout.trim() !== 'ok') problems.push(`call ${i}: ${JSON.stringify(body).slice(0, 200)}`);
  if (i === 1) before = bootstrapPid(); // the emulator starts the bootstrap at the first invocation
  if (d.callsInEnvironment !== 1) problems.push(`call ${i}: call# ${d.callsInEnvironment}`);
}
const after = bootstrapPid();
console.table(rows);
if (new Set(rows.map(r => r.env)).size !== 10) problems.push('environment ids repeat: a worker was reused');
if (!before || before !== after || before.includes(',')) problems.push(`bootstrap pid changed or not unique: ${before} -> ${after}`);
if (!c.running()) problems.push('container stopped');
c.stop();
console.log(problems.length ? `FAIL\n${problems.join('\n')}` : `OK: 10 sequential calls, no errors, 10 different workers, one bootstrap (pid ${before})`);
process.exit(problems.length ? 1 : 0);
