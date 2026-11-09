// Local check that the deployed-sandbox probe programs behave as run-deployed.js expects (Docker, no network).
const c = require('./container');
const { OUTBOUND, ENV_PRINT } = require('./deployed-probes');
c.start();
let bad = 0;
const expectations = [
  ['outbound', OUTBOUND, out => out.trim().split('\n').length === 3 && out.trim().split('\n').every(line => /socket=EPERM$/.test(line))],
  ['env print', ENV_PRINT, out => out.trim() === 'count=0\nchild_aws=0']
];
for (const [name, source, ok] of expectations) {
  const r = c.invoke({ source, runs: [{ stdin: '' }], timeLimitMs: 15000, memoryLimitKb: 128000 }).body.results[0];
  const pass = r.status === 'accepted' && ok(r.stdout);
  if (!pass) bad++;
  console.log(name.padEnd(10), r.status.padEnd(14), pass ? 'ok' : 'FAIL', JSON.stringify(r.stdout.trim()), r.compileOutput.slice(0, 200));
}
c.stop();
process.exit(bad ? 1 : 0);
