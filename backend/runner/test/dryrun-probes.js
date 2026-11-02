// Local check that the deployed-sandbox probe programs behave as run-deployed.js expects (Docker, no network).
const c = require('./container');
const { OUTBOUND, ENVIRON, AWS_CALL } = require('./deployed-probes');
c.start();
let bad = 0;
for (const [name, source, expected] of [['outbound', OUTBOUND, 'blocked'], ['environ', ENVIRON, '0'], ['aws env', AWS_CALL, 'none']]) {
  const r = c.invoke({ source, runs: [{ stdin: '', expectedOutput: expected }], timeLimitMs: 15000, memoryLimitKb: 128000 }).body.results[0];
  const ok = r.status === 'accepted';
  if (!ok) bad++;
  console.log(name.padEnd(9), r.status.padEnd(14), JSON.stringify(r.stdout.trim()), r.compileOutput.slice(0, 200));
}
c.stop();
process.exit(bad ? 1 : 0);
