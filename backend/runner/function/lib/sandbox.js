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
  const match = /exit=(-?\d+) sig=(\d+) cpu_ms=(\d+) rss_kb=(\d+) landlock=(\d) seccomp=(\d) reaped=(\d+)/.exec(text);
  if (!match) return null;
  return {
    exitCode: Number(match[1]),
    signal: Number(match[2]),
    cpuMs: Number(match[3]),
    rssKb: Number(match[4]),
    landlock: match[5] === '1',
    seccomp: match[6] === '1',
    reaped: Number(match[7])
  };
}

// ---- cleanup between runs: Lambda reuses warm containers ----

function readStatus(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf-8');
    return {
      uid: Number(/^Uid:\s+(\d+)/m.exec(status)[1]),
      state: /^State:\s+(\S)/m.exec(status)[1],
      ppid: Number(/^PPid:\s+(\d+)/m.exec(status)[1])
    };
  } catch {
    return null; // process vanished
  }
}

function ancestorsOfSelf() {
  const keep = new Set([process.pid]);
  let pid = process.pid;
  while (pid > 1) {
    const info = readStatus(pid);
    if (!info || keep.has(info.ppid)) break;
    keep.add(info.ppid);
    pid = info.ppid;
  }
  return keep;
}

/** Live processes owned by our user that are not us or one of our ancestors (zombies ignored). */
function findStrangers() {
  const keep = ancestorsOfSelf();
  const uid = process.getuid();
  return fs.readdirSync('/proc')
    .filter(name => /^\d+$/.test(name))
    .map(Number)
    .filter(pid => !keep.has(pid))
    .filter(pid => {
      const info = readStatus(pid);
      return info && info.uid === uid && info.state !== 'Z';
    });
}

/**
 * Kill every leftover process (a program can escape its group with setsid or fork a daemon) and
 * wait until none remain. Returns how many were killed and how many survived.
 */
async function sweepProcesses() {
  let killed = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    const strangers = findStrangers();
    if (strangers.length === 0) return { killed, survivors: 0 };
    for (const pid of strangers) {
      try { process.kill(pid, 'SIGKILL'); killed++; } catch { /* already gone */ }
    }
    await sleep(25);
  }
  return { killed, survivors: findStrangers().length };
}

/** Empty /tmp completely (students may write anywhere in it). */
function wipeTmp() {
  for (const name of fs.readdirSync('/tmp')) {
    fs.rmSync(`/tmp/${name}`, { recursive: true, force: true });
  }
}

module.exports = { execLimited, sweepProcesses, wipeTmp, MB };
