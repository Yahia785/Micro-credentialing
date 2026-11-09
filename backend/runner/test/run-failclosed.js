// node run-failclosed.js   Docker test of the sandbox paths. Landlock, seccomp and no_new_privs are best effort (the platform
// may refuse them; on standard Lambda its own filter is the sandbox). The launcher fails closed only when it cannot start the
// program safely: a resource limit, the work folder or exec fails.
//
//   A  Lambda-like       seccomp() refused, no Landlock, prctls refused, NoNewPrivs already 1: runs work, nothing left behind
//   B  seccomp refused   no_new_privs can be set, seccomp() is refused: runs work, diagnostics.seccomp false + errno
//   C  prctl refused     NoNewPrivs already 1 and the prctl would fail: the launcher must not call it, seccomp still installed
//   D  Landlock missing  only Landlock refused: runs work, network still EPERM
//   E  setrlimit refused FAILS CLOSED: nothing runs, internal_error "sandbox unavailable", sandboxStep setrlimit
//   F  launcher steps    chdir and exec failures are reported as such (launcher run by hand)
//   G  all available     everything on; an event with expectedOutput is rejected
//   H  PID 1 never reaps after a fork bomb, the zombies use up the process limit: the next call says so quickly, no hang
const { spawnSync } = require('child_process');
const c = require('./container');
const hostile = require('./hostile');

const marker = '#include <cstdio>\nint main(){ FILE* f = fopen("ran.txt", "w"); if (f) fclose(f); puts("RAN"); }';
const socketProbe = '#include <sys/socket.h>\n#include <cerrno>\n#include <cstdio>\nint main(){ int s = socket(AF_INET, SOCK_STREAM, 0); puts(s < 0 && errno == EPERM ? "EPERM" : "OPEN"); }';
const call = source => c.invoke({ source, runs: [{ stdin: '' }, { stdin: '' }], timeLimitMs: 1000, memoryLimitKb: 64000 }).body;

const rows = [];
const check = (path, name, ok) => rows.push({ path, check: name, result: ok ? 'ok' : 'FAIL' });
const ran = (results, n = 2) => results.length === n && results.every(r => r.status === 'accepted' && r.stdout.trim() === 'RAN');

// A
c.start({ lambdaLike: true });
let body = call(marker);
const background = hostile.find(h => h.name === 'daemon: double fork + setsid escapes the process group');
const daemon = c.invoke({ source: background.source, runs: [{ stdin: '' }], timeLimitMs: 1000, memoryLimitKb: 64000 }).body;
let left = c.inspect();
c.stop();
let d = body.diagnostics || {};
check('A Lambda-like', 'runs are accepted (ran fine)', ran(body.results || []));
check('A Lambda-like', 'nothing refused makes the call fail: sandboxStep none, errno 0', d.sandboxStep === 'none' && d.errno === 0);
check('A Lambda-like', 'seccomp false (errno 1), landlock false, nnp already, subreaper errno 1', d.seccomp === false && d.seccompErrno === 1 && d.landlock === false && d.nnp === 'already' && d.subreaperErrno === 1);
check('A Lambda-like', 'a daemon that escapes the process group is killed by the /proc sweep', (daemon.results || [])[0] && daemon.results[0].status === 'accepted' && daemon.diagnostics.leftoverKilled >= 1);
check('A Lambda-like', 'nothing left behind', left.strangers.length === 0 && left.tmp.length === 0);

// B
c.start({ noSeccomp: true });
body = call(marker);
c.stop();
d = body.diagnostics || {};
check('B seccomp refused', 'runs are accepted (ran fine)', ran(body.results || []));
check('B seccomp refused', 'diagnostics.seccomp false with errno 1, nnp set, step none', d.seccomp === false && d.seccompErrno === 1 && d.nnp === 'set' && d.sandboxStep === 'none');

// C
c.start({ profile: 'seccomp-no-nnp-prctl.json', noNewPrivileges: true });
body = call(marker);
c.stop();
d = body.diagnostics || {};
check('C prctl refused', 'runs are accepted (ran fine)', ran(body.results || []));
check('C prctl refused', 'nnp already (prctl not called), seccomp still installed', d.nnp === 'already' && d.seccomp === true);

// D
c.start({ noLandlock: true });
body = call(marker);
const probe = call(socketProbe);
c.stop();
d = body.diagnostics || {};
check('D no Landlock', 'runs are accepted (ran fine)', ran(body.results || []));
check('D no Landlock', 'diagnostics.landlock false, seccomp true', d.landlock === false && d.seccomp === true);
check('D no Landlock', 'socket() still fails with EPERM', (probe.results || []).every(r => r.stdout.trim() === 'EPERM'));

// E
c.start({ profile: 'seccomp-no-setrlimit.json' });
body = call(marker);
left = c.inspect();
c.stop();
let results = body.results || [];
d = body.diagnostics || {};
check('E setrlimit refused', 'every run is internal_error "sandbox unavailable"', results.length === 2 && results.every(r => r.status === 'internal_error' && r.message === 'sandbox unavailable'));
check('E setrlimit refused', 'no program output', results.every(r => r.stdout === ''));
check('E setrlimit refused', 'diagnostics.sandboxStep is setrlimit, errno 1', d.sandboxStep === 'setrlimit' && d.errno === 1);
check('E setrlimit refused', 'nothing left behind', left.strangers.length === 0 && left.tmp.length === 0);

// F  (the launcher by hand: chdir into a missing folder, and exec of a missing program)
c.start();
const launcher = args => spawnSync('docker', ['exec', '-u', '1051', c.NAME, 'sh', '-c', `/usr/local/bin/sandbox-launcher ${args} 3>&1`],
  { encoding: 'utf-8', timeout: 30000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).stdout || '';
const chdirOut = launcher('run /nonexistent-dir 5 1000000000 8388608 100 1000000 64 -- /usr/bin/true');
const execOut = launcher('run /tmp 5 1000000000 8388608 100 1000000 64 -- /nonexistent/program');
const okOut = launcher('run /tmp 5 1000000000 8388608 100 1000000 64 -- /usr/bin/true');
c.stop();
check('F launcher steps', 'chdir failure: step=chdir errno=2', /step=chdir errno=2/.test(chdirOut));
check('F launcher steps', 'exec failure: step=exec errno=2', /step=exec errno=2/.test(execOut));
check('F launcher steps', 'a normal run: step=none errno=0', /step=none errno=0/.test(okOut));

// G
c.start();
body = call(marker);
const rejected = c.invoke({ source: marker, runs: [{ stdin: '', expectedOutput: 'RAN' }], timeLimitMs: 1000, memoryLimitKb: 64000 }).body;
c.stop();
d = body.diagnostics || {};
check('G all available', 'runs are accepted (ran fine)', ran(body.results || []));
check('G all available', 'sandboxStep none, errno 0, nnp set, subreaper ok', d.sandboxStep === 'none' && d.errno === 0 && d.nnp === 'set' && d.subreaperErrno === 0);
check('G all available', 'landlock and seccomp are true', d.landlock === true && d.seccomp === true);
check('G all available', 'an event with expectedOutput is rejected', /expectedOutput is not accepted/.test(rejected.error || '') && (rejected.results || []).length === 0);

// H  (lambda-like but PID 1 is the emulator, which never reaps orphaned zombies)
c.start({ lambdaLike: true, init: false });
const bomb = hostile.find(h => h.name === 'fork bomb');
const first = c.invoke({ source: bomb.source, runs: [{ stdin: '' }], timeLimitMs: 1000, memoryLimitKb: 128000 }).body;
const second = c.invoke({ source: marker, runs: [{ stdin: '' }], timeLimitMs: 1000, memoryLimitKb: 64000 });
c.stop();
check('H PID 1 never reaps', 'the fork bomb itself ends as time_limit', (first.results || [])[0] && first.results[0].status === 'time_limit');
check('H PID 1 never reaps', 'the next call says the environment is exhausted, quickly (no hang)',
  (second.body.results || [])[0] && second.body.results[0].status === 'internal_error' && /exhausted/.test(second.body.results[0].message) && second.wallMs < 5000);

console.table(rows);
process.exit(rows.every(r => r.result === 'ok') ? 0 : 1);
