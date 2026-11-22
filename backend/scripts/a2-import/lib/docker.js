// Compiling and running student code in Docker: image gcc:13, no network. One container per repository (started lazily, removed at the
// end); the student's source is written into a temporary work folder that is deleted at the end. Student code never runs outside the container.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const IMAGE = 'gcc:13';
const RUNNER_FLAGS = '-std=c++17 -O2'; // the runner image's flags
const SANITIZER_FLAGS = '-std=c++17 -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer';
const RUN_TIMEOUT_S = 5;

const docker = (args, options = {}) => spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });

function dockerAvailable() {
  const r = docker(['info', '--format', '{{.ServerVersion}}']);
  return !r.error && r.status === 0;
}

function makeDocker({ image = IMAGE } = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-import-'));
  let container = null;

  function start() {
    if (container) return;
    const r = docker(['run', '-d', '--rm', '--network', 'none', '--memory', '2g', '--cpus', '2', '--pids-limit', '512', '-v', `${workDir}:/w`, '-w', '/w', image, 'sleep', '3600']);
    if (r.status !== 0) throw new Error(`docker run failed: ${(r.stderr || '').trim().split('\n')[0]}`);
    container = r.stdout.trim();
  }

  function exec(script, timeoutMs = 120000) {
    start();
    return docker(['exec', container, 'sh', '-c', script], { timeout: timeoutMs });
  }

  const read = (file) => { try { return fs.readFileSync(path.join(workDir, file), 'utf8'); } catch { return ''; } };

  /** Compile one source file with the runner's flags. Returns { ok, errors } (errors: the compiler's output, first 8,000 characters). */
  async function compile(source) {
    fs.writeFileSync(path.join(workDir, 'main.cpp'), source);
    fs.rmSync(path.join(workDir, 'build.code'), { force: true });
    exec(`g++ ${RUNNER_FLAGS} -fmax-errors=30 -o build.bin main.cpp > build.log 2>&1; echo $? > build.code`);
    return { ok: read('build.code').trim() === '0', errors: read('build.log').slice(0, 8000) };
  }

  /**
   * Compile `source` twice (sanitizers; the runner's flags) and run every command on both. Returns
   * { sanCompile, plainCompile, runs: [{ san: { code, stderr }, plain: { code, stdout } }] } aligned with `cmds`.
   * Exit code 124 is the time limit (5 s per run, 15 s under the sanitizers).
   */
  async function runInputs({ source, cmds }) {
    fs.writeFileSync(path.join(workDir, 'main.cpp'), source);
    fs.writeFileSync(path.join(workDir, 'inputs.txt'), `${cmds.join('\n')}\n`);
    for (const f of fs.readdirSync(workDir)) if (/^(san|plain)\./.test(f)) fs.rmSync(path.join(workDir, f), { force: true });
    const script = [
      `g++ ${SANITIZER_FLAGS} -o san.bin main.cpp > san.log 2>&1; echo $? > san.build`,
      `g++ ${RUNNER_FLAGS} -o plain.bin main.cpp > plain.log 2>&1; echo $? > plain.build`,
      'export ASAN_OPTIONS=detect_leaks=0:abort_on_error=0',
      'i=0',
      'while IFS= read -r line; do',
      `  if [ "$(cat san.build)" = "0" ]; then printf '%s\\n' "$line" | timeout ${RUN_TIMEOUT_S * 3} ./san.bin > san.out.$i 2> san.err.$i; echo $? > san.code.$i; fi`,
      `  if [ "$(cat plain.build)" = "0" ]; then printf '%s\\n' "$line" | timeout ${RUN_TIMEOUT_S} ./plain.bin > plain.out.$i 2> plain.err.$i; echo $? > plain.code.$i; fi`,
      '  i=$((i+1))',
      'done < inputs.txt',
    ].join('\n');
    exec(script, 120000 + cmds.length * 25000);
    const num = (f) => { const t = read(f).trim(); return t === '' ? null : Number(t); };
    return {
      sanCompile: { ok: read('san.build').trim() === '0', errors: read('san.log').slice(0, 2000) },
      plainCompile: { ok: read('plain.build').trim() === '0', errors: read('plain.log').slice(0, 2000) },
      runs: cmds.map((_, i) => ({
        san: { code: num(`san.code.${i}`), stderr: read(`san.err.${i}`).slice(0, 20000) },
        plain: { code: num(`plain.code.${i}`), stdout: read(`plain.out.${i}`).slice(0, 5000) },
      })),
    };
  }

  /**
   * Compile `source` with the runner's flags and run every command (no sanitizers). Returns
   * { compile: { ok, errors }, runs: [{ code, stdout, stderr }] } aligned with `cmds`; code 124 is the time limit.
   */
  async function runPlain({ source, cmds, timeoutS = RUN_TIMEOUT_S }) {
    fs.writeFileSync(path.join(workDir, 'main.cpp'), source);
    fs.writeFileSync(path.join(workDir, 'inputs.txt'), `${cmds.join('\n')}\n`);
    for (const f of fs.readdirSync(workDir)) if (/^rp\./.test(f)) fs.rmSync(path.join(workDir, f), { force: true });
    const script = [
      `g++ ${RUNNER_FLAGS} -fmax-errors=30 -o rp.bin main.cpp > rp.log 2>&1; echo $? > rp.build`,
      'i=0',
      'while IFS= read -r line; do',
      `  if [ "$(cat rp.build)" = "0" ]; then printf '%s\\n' "$line" | timeout ${timeoutS} ./rp.bin > rp.out.$i 2> rp.err.$i; echo $? > rp.code.$i; fi`,
      '  i=$((i+1))',
      'done < inputs.txt',
    ].join('\n');
    exec(script, 60000 + cmds.length * (timeoutS + 5) * 1000);
    const num = (f) => { const t = read(f).trim(); return t === '' ? null : Number(t); };
    return {
      compile: { ok: read('rp.build').trim() === '0', errors: read('rp.log').slice(0, 8000) },
      runs: cmds.map((_, i) => ({ code: num(`rp.code.${i}`), stdout: read(`rp.out.${i}`).slice(0, 5000), stderr: read(`rp.err.${i}`).slice(0, 20000) })),
    };
  }

  /** Remove the container and the work folder (student copies). */
  function cleanup() {
    if (container) docker(['rm', '-f', container]);
    container = null;
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  return { compile, runInputs, runPlain, cleanup, workDir };
}

module.exports = { makeDocker, dockerAvailable, IMAGE, RUNNER_FLAGS, SANITIZER_FLAGS };
