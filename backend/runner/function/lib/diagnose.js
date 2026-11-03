/**
 * Diagnose mode ({ "diagnose": true }): no student code is involved. Runs sandbox-probe (function/probe.c), which tries
 * every sandbox step the launcher uses and reports success or errno for each, in three ways:
 *   direct       the probe is a direct child of the handler
 *   grandchild   the probe is a grandchild of the handler (handler -> relay -> probe)
 *   viaLauncher  the probe runs as the "program" of the real launcher, so the launcher's own report
 *                (step, errno, seccomp, landlock) is included next to what the probe sees afterwards
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { execLimited, MB } = require('./sandbox');

const PROBE = '/usr/local/bin/sandbox-probe';

function parseProbe(stdout, error, stderr) {
  try {
    return JSON.parse(String(stdout).trim().split('\n').pop());
  } catch {
    return { error: (error && error.message) || 'probe printed no JSON', stderr: String(stderr || '').slice(0, 300), results: [] };
  }
}

function runDirect(args) {
  return new Promise(resolve => {
    // Empty environment, like the launcher gives the student program.
    execFile(PROBE, args, { env: {}, timeout: 20000, maxBuffer: MB }, (error, stdout, stderr) => resolve(parseProbe(stdout, error, stderr)));
  });
}

async function diagnose() {
  const direct = await runDirect(['run']);
  const grandchild = await runDirect(['relay']);

  let viaLauncher;
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-'));
    const outcome = await execLimited({
      mode: 'run', dir, argv: [PROBE, 'run'], stdin: '', cpuSec: 10, asBytes: 1400 * MB, wallMs: 15000
    });
    viaLauncher = {
      launcher: outcome.meta, // exit, signal, landlock, seccomp, step, errno, subreaperErrno; null when the launcher did not report
      probe: parseProbe(outcome.stdout.toString('utf-8'), null, outcome.stderr.toString('utf-8'))
    };
  } catch (error) {
    viaLauncher = { launcher: null, probe: { error: error.message, results: [] } };
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  return { diagnose: true, direct, grandchild, viaLauncher };
}

module.exports = { diagnose };
