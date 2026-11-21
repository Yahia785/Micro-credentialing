// A local stand-in for the code runner: the same runBatch(runs, options) shape as utils/codeRunner.js, but it compiles with a local g++
// (same flags as the runner image: -O2 -std=c++17) and runs the program here. Runs with the same source share one compile.
//   GXX=D:/raylib/w64devkit/bin/g++.exe node run-harness.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const FLAGS = ['-O2', '-std=c++17'];

function findCompiler() {
  const candidates = [process.env.GXX, 'g++'].filter(Boolean);
  for (const gxx of candidates) {
    const r = spawnSync(gxx, ['--version'], { encoding: 'utf8', env: envFor(gxx) });
    if (!r.error && r.status === 0) return { gxx, version: r.stdout.split('\n')[0] };
  }
  return null;
}

// a g++ that is not on PATH needs its own folder on PATH to find `as`, `ld` and its DLLs
const envFor = (gxx) => (path.isAbsolute(gxx) || gxx.includes('/') ? { ...process.env, PATH: path.dirname(path.resolve(gxx)) + path.delimiter + process.env.PATH } : process.env);

function makeLocalRunBatch({ gxx }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-harness-'));
  const env = envFor(gxx);
  const compiled = new Map(); // sha -> { exe } | { compileOutput }
  let compiles = 0;
  const stats = { compiles: () => compiles };

  function compile(source) {
    const sha = crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
    if (!compiled.has(sha)) {
      const src = path.join(dir, `${sha}.cpp`);
      const exe = path.join(dir, process.platform === 'win32' ? `${sha}.exe` : sha);
      fs.writeFileSync(src, source);
      compiles += 1;
      const r = spawnSync(gxx, [...FLAGS, '-fmax-errors=50', '-o', exe, src], { encoding: 'utf8', env });
      compiled.set(sha, r.status === 0 ? { exe } : { compileOutput: `${r.stderr || ''}${r.stdout || ''}${r.error ? String(r.error) : ''}` });
    }
    return compiled.get(sha);
  }

  async function runBatch(runs) {
    return runs.map((run) => {
      const c = compile(run.source);
      if (!c.exe) return { status: 'compile_error', stdout: '', stderr: '', compileOutput: c.compileOutput, timeMs: 0, memoryKb: 0 };
      const t0 = Date.now();
      const r = spawnSync(c.exe, [], { input: `${run.stdin}\n`, encoding: 'utf8', timeout: run.timeLimitMs || 5000, env, maxBuffer: 8 * 1024 * 1024 });
      const timeMs = Date.now() - t0;
      let status = 'accepted';
      if (r.error && r.error.code === 'ETIMEDOUT') status = 'time_limit';
      else if (r.status !== 0) status = 'runtime_error';
      return { status, stdout: r.stdout || '', stderr: r.stderr || '', compileOutput: '', timeMs, memoryKb: 0, exitCode: r.status };
    });
  }
  return { runBatch, stats, dir };
}

module.exports = { findCompiler, makeLocalRunBatch, FLAGS };
