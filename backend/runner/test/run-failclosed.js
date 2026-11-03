// node run-failclosed.js   Docker test of the three sandbox paths.
//   A. seccomp cannot be installed (Docker profile blocks the seccomp syscall): FAILS CLOSED. Nothing may run: every run is
//      internal_error "sandbox unavailable" and diagnostics.seccomp is false.
//   B. Landlock is missing (Docker profile blocks the landlock syscalls, like Lambda's kernel 5.10): the runs still work,
//      diagnostics.landlock is false and diagnostics.seccomp is true, and the network is still denied.
//   C. Everything available: diagnostics.landlock and diagnostics.seccomp are both true.
// An event that contains expectedOutput is also rejected (path C).
const c = require('./container');

const marker = '#include <cstdio>\nint main(){ FILE* f = fopen("ran.txt", "w"); if (f) fclose(f); puts("RAN"); }';
const socketProbe = '#include <sys/socket.h>\n#include <cerrno>\n#include <cstdio>\nint main(){ int s = socket(AF_INET, SOCK_STREAM, 0); puts(s < 0 && errno == EPERM ? "EPERM" : "OPEN"); }';
const call = source => c.invoke({ source, runs: [{ stdin: '' }, { stdin: '' }], timeLimitMs: 1000, memoryLimitKb: 64000 }).body;

const rows = [];
const check = (path, name, ok) => rows.push({ path, check: name, result: ok ? 'ok' : 'FAIL' });

// A
c.start({ noSeccomp: true });
let body = call(marker);
let left = c.inspect();
c.stop();
let results = body.results || [];
check('A seccomp blocked', 'every run is internal_error', results.length === 2 && results.every(r => r.status === 'internal_error'));
check('A seccomp blocked', 'message is "sandbox unavailable"', results.every(r => r.message === 'sandbox unavailable'));
check('A seccomp blocked', 'no program output', results.every(r => r.stdout === ''));
check('A seccomp blocked', 'diagnostics.seccomp is false', !!body.diagnostics && body.diagnostics.seccomp === false);
check('A seccomp blocked', 'nothing left behind', left.strangers.length === 0 && left.tmp.length === 0);
check('A seccomp blocked', 'diagnostics.sandboxStep is seccomp_set_mode_filter, errno 1 (EPERM)', !!body.diagnostics && body.diagnostics.sandboxStep === 'seccomp_set_mode_filter' && body.diagnostics.errno === 1);

// B
c.start({ noLandlock: true });
body = call(marker);
const probe = call(socketProbe);
c.stop();
results = body.results || [];
check('B no Landlock', 'runs are accepted (ran fine)', results.length === 2 && results.every(r => r.status === 'accepted' && r.stdout.trim() === 'RAN'));
check('B no Landlock', 'diagnostics.landlock is false', !!body.diagnostics && body.diagnostics.landlock === false);
check('B no Landlock', 'diagnostics.seccomp is true', !!body.diagnostics && body.diagnostics.seccomp === true);
check('B no Landlock', 'socket() still fails with EPERM', (probe.results || []).every(r => r.stdout.trim() === 'EPERM'));

// C
c.start();
body = call(marker);
const rejected = c.invoke({ source: marker, runs: [{ stdin: '', expectedOutput: 'RAN' }], timeLimitMs: 1000, memoryLimitKb: 64000 }).body;
c.stop();
results = body.results || [];
check('C all available', 'runs are accepted (ran fine)', results.length === 2 && results.every(r => r.status === 'accepted'));
check('C all available', 'diagnostics.sandboxStep is none, errno 0', !!body.diagnostics && body.diagnostics.sandboxStep === 'none' && body.diagnostics.errno === 0 && body.diagnostics.subreaperErrno === 0);
check('C all available', 'diagnostics.landlock and seccomp are true', !!body.diagnostics && body.diagnostics.landlock === true && body.diagnostics.seccomp === true);
check('C all available', 'an event with expectedOutput is rejected', /expectedOutput is not accepted/.test(rejected.error || '') && (rejected.results || []).length === 0);

console.table(rows);
process.exit(rows.every(r => r.result === 'ok') ? 0 : 1);
