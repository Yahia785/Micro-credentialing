// node run-failclosed.js   Landlock syscalls are blocked (seccomp), so the sandbox cannot be built.
// Nothing may run: every run must be internal_error "sandbox unavailable" and diagnostics.landlock false.
const c = require('./container');

c.start({ noLandlock: true });
const marker = '#include <cstdio>\nint main(){ FILE* f = fopen("ran.txt", "w"); if (f) fclose(f); puts("RAN"); }';
const { body } = c.invoke({ source: marker, runs: [{ stdin: '', expectedOutput: 'RAN' }, { stdin: '' }], timeLimitMs: 1000, memoryLimitKb: 64000 });
const left = c.inspect();
c.stop();

const results = body.results || [];
const checks = {
  'every run is internal_error': results.length === 2 && results.every(r => r.status === 'internal_error'),
  'message is "sandbox unavailable"': results.every(r => r.message === 'sandbox unavailable'),
  'no program output': results.every(r => r.stdout === ''),
  'diagnostics.landlock is false': body.diagnostics && body.diagnostics.landlock === false,
  'nothing left behind': left.strangers.length === 0 && left.tmp.length === 0
};
console.table(Object.entries(checks).map(([check, ok]) => ({ check, result: ok ? 'ok' : 'FAIL' })));
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
