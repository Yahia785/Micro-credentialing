/**
 * Process helpers: run one program through the setrlimit launcher with a wall-clock kill and an
 * output cap, and sweep away anything a student program left behind. Nothing here logs source,
 * stdin or program output.
 */

const fs = require('fs');
const { spawn } = require('child_process');

const LAUNCHER = '/usr/local/bin/sandbox-launcher';
const MB = 1024 * 1024;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Ask the launcher to tear its tree down (it also reaps); fall back to a hard group kill. */
function stopLaunched(pid) {
  try { process.kill(pid, 'SIGUSR1'); } catch { /* launcher already gone */ }
  setTimeout(() => killGroup(pid), 4000).unref();
}

function killGroup(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch { /* group already gone */ }
}

/**
 * @returns {Promise<{ meta: object|null, stdout: Buffer, stderr: Buffer,
 *   outputTruncated: boolean, wallKilled: boolean }>}
 *   meta is null when the launcher itself was killed before it could report.
 */
function execLimited({ mode, dir, argv, stdin, cpuSec, asBytes, stackBytes = 64 * MB, nproc = 200,
  fsizeBytes = 16 * MB, nofile = 64, wallMs, stdoutCap = MB, stderrCap = 64 * 1024 }) {
  return new Promise(resolve => {
    const args = [mode, dir, cpuSec, asBytes, stackBytes, nproc, fsizeBytes, nofile, '--', ...argv].map(String);
    const child = spawn(LAUNCHER, args, {
      detached: true, // own session + process group, so the whole tree can be killed
      env: {},        // the launcher itself gets nothing either
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe']
    });

    const out = [];
    const err = [];
    let outSize = 0;
    let errSize = 0;
    let metaText = '';
    let outputTruncated = false;
    let wallKilled = false;

    child.on('error', () => { /* spawn failure: reported through meta === null */ });
    child.stdin.on('error', () => { /* program closed stdin early */ });
    child.stdin.end(stdin || '');

    child.stdout.on('data', chunk => {
      if (outSize + chunk.length > stdoutCap) {
        out.push(chunk.subarray(0, stdoutCap - outSize));
        outSize = stdoutCap;
        outputTruncated = true;
        stopLaunched(child.pid);
      } else {
        out.push(chunk);
        outSize += chunk.length;
      }
    });
    child.stderr.on('data', chunk => {
      if (errSize < stderrCap) {
        err.push(chunk.subarray(0, stderrCap - errSize));
        errSize += chunk.length;
      }
    });
    child.stdio[3].on('data', chunk => { metaText += chunk.toString('utf-8'); });
    child.stdio[3].on('error', () => {});

    const timer = setTimeout(() => {
      wallKilled = true;
      stopLaunched(child.pid);
    }, wallMs);

    // A daemonised child can keep the stdio pipes open forever, so do not wait for 'close':
    // 150 ms after the launcher exits we take what we have, kill the group and move on.
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killGroup(child.pid); // the student program may have left children in the group
      for (const stream of [child.stdout, child.stderr, child.stdio[3]]) stream.destroy();
      resolve({
        meta: parseMeta(metaText),
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        outputTruncated,
        wallKilled
      });
    };
    child.on('close', finish);
    child.on('exit', () => setTimeout(finish, 150));
  });
}

function parseMeta(text) {
  const match = /exit=(-?\d+) sig=(\d+) cpu_ms=(\d+) rss_kb=(\d+) landlock=(\d) seccomp=(\d) reaped=(\d+) nnp=(\w+) nnp_errno=(-?\d+) seccomp_errno=(-?\d+) subreaper_errno=(-?\d+) step=(\S+) errno=(-?\d+)/.exec(text);
  if (!match) return null;
  return {
    exitCode: Number(match[1]),
    signal: Number(match[2]),
    cpuMs: Number(match[3]),
    rssKb: Number(match[4]),
    landlock: match[5] === '1',
    seccomp: match[6] === '1',
    reaped: Number(match[7]),
    // no_new_privs: 'set' (we set it), 'already' (the platform had), 'failed'
    nnp: match[8],
    nnpErrno: Number(match[9]),
    seccompErrno: Number(match[10]),
    subreaperErrno: Number(match[11]),
    // 'none', or the launch step that failed and made the launcher refuse to run the program
    // (setrlimit, chdir, exec, no_report), with its errno
    step: match[12],
    errno: Number(match[13])
  };
}

// ---- cleanup between runs: Lambda reuses warm containers ----
//
// The launcher kills the tree it started (it is a subreaper where the platform allows that). Standard Lambda refuses
// PR_SET_CHILD_SUBREAPER, so a daemon that escapes (double fork, setsid) is re-parented elsewhere and the launcher
// cannot see it. This sweep does not depend on any of that: at start-up we note every process that exists (the Lambda
// runtime, this handler, whatever else the platform runs), and after each run every live process of our user that is
// NOT in that list is killed, until none remain or a short deadline passes.

/** pid, uid, state, ppid and start time (so a re-used pid is not mistaken for an old process); null if it vanished. */
function readProc(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf-8');
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // state is field 3; start time is field 22
    return {
      pid,
      uid: Number(/^Uid:\s+(\d+)/m.exec(status)[1]),
      state: rest[0],
      ppid: Number(rest[1]),
      start: rest[19]
    };
  } catch {
    return null; // process vanished
  }
}

function listProcesses() {
  return fs.readdirSync('/proc')
    .filter(name => /^\d+$/.test(name))
    .map(name => readProc(Number(name)))
    .filter(Boolean);
}

const keyOf = proc => `${proc.pid}:${proc.start}`;

// Taken once, when the function initialises: before any student code can have run.
let baseline = new Set();
try { baseline = new Set(listProcesses().map(keyOf)); } catch { /* no /proc (not Linux): the sweep then finds nothing */ }

/** Live processes of our user that were not there at start-up (zombies ignored). */
function findStrangers() {
  const uid = process.getuid();
  return listProcesses()
    .filter(proc => proc.pid !== process.pid && proc.uid === uid && proc.state !== 'Z' && !baseline.has(keyOf(proc)))
    .map(proc => proc.pid);
}

/**
 * Zombies of our user. Only their parent (or, once the parent is gone, PID 1) can reap them, and every one of them uses a
 * slot of RLIMIT_NPROC. Where PID 1 does not reap orphans, a fork bomb leaves its zombies behind for good.
 */
function countZombies() {
  const uid = process.getuid();
  return listProcesses().filter(proc => proc.uid === uid && proc.state === 'Z').length;
}

/**
 * Kill every leftover process and wait until none remain, or until deadlineMs has passed.
 * Returns how many were killed and how many survived (the caller fails the call if any survived).
 */
async function sweepProcesses(deadlineMs = 1500) {
  const until = Date.now() + deadlineMs;
  let killed = 0;
  for (;;) {
    const strangers = findStrangers();
    if (strangers.length === 0) return { killed, survivors: 0 };
    for (const pid of strangers) {
      try { process.kill(pid, 'SIGKILL'); killed++; } catch { /* already gone */ }
    }
    if (Date.now() >= until) return { killed, survivors: findStrangers().length };
    await sleep(25);
  }
}

/** Empty /tmp completely (students may write anywhere in it). */
function wipeTmp() {
  for (const name of fs.readdirSync('/tmp')) {
    fs.rmSync(`/tmp/${name}`, { recursive: true, force: true });
  }
}

module.exports = { execLimited, sweepProcesses, wipeTmp, countZombies, baselineSize: () => baseline.size, MB };
