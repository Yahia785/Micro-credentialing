#!/usr/bin/env node
// Compiles the reference and every variant with the driver (ONE source file via build.js), runs every input in questions.json and writes
//   results/matrix.md   inputs x (reference + variants), differing cells marked; predict spec answers; the reference's trace stops;
//                       the input the targeting rules pick for each submission and function; bugs that no usable input catches
// It also fills the computed fields of questions.json: "spec" (the reference's output, the answer of a predict question) and
// "refStops" (the reference's trace stops, only used to choose a K for targeted tracing questions). Tracing has no spec answer.
//
//   node run-all.js              (from anywhere)
//   GXX=/path/to/g++ node run-all.js     use a specific g++ that is not on PATH
//   RUNNER=docker node run-all.js        force docker (gcc:13, --network none)
//
// Compiler choice: $GXX, else g++ on PATH, else docker with the gcc:13 image. Flags are the ones of the runner image (-O2 -std=c++17).
// The docker path has not been exercised yet on this machine (the Docker daemon was off).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { build } = require('./build');
const harness = require('../../../shared/nodejs/services/harness-builder');
const { selectInput, undefinedInput } = require('./selection');

const ROOT = __dirname;
const RESULTS = path.join(ROOT, 'results');
const BUILD_DIR = path.join(RESULTS, '.build');
const TIMEOUT_MS = 5000;

// ---------- toolchain ----------
function detectToolchain() {
  const works = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8' }); return !r.error && r.status === 0; };
  if (process.env.RUNNER !== 'docker') {
    const gxx = process.env.GXX || 'g++';
    if (works(gxx, ['--version'])) return { kind: 'native', gxx };
  }
  if (works('docker', ['info'])) return { kind: 'docker' };
  console.error('No C++ compiler found. Put g++ on PATH (or set GXX=/path/to/g++), or start Docker (image gcc:13).');
  process.exit(1);
}

// compile source and run every command; returns [{out, err, code, timedOut}] or {compileError}
function compileAndRun(tc, name, source, cmds) {
  const dir = path.join(BUILD_DIR, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'main.cpp'), source);
  if (tc.kind === 'native') {
    const exe = path.join(dir, process.platform === 'win32' ? 'prog.exe' : 'prog');
    // a g++ that is not on PATH needs its own folder on PATH to find `as`, `ld` and the DLLs
    const env = { ...process.env, PATH: path.dirname(path.resolve(tc.gxx)) + path.delimiter + process.env.PATH };
    const c = spawnSync(tc.gxx, ['-std=c++17', '-O2', '-o', exe, path.join(dir, 'main.cpp')], { encoding: 'utf8', env });
    if (c.status !== 0) return { compileError: (c.stderr || String(c.error)).slice(0, 2000) };
    return cmds.map((cmd) => {
      const r = spawnSync(exe, [], { input: cmd + '\n', encoding: 'utf8', timeout: TIMEOUT_MS, env });
      return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), code: r.status, timedOut: !!r.error && r.error.code === 'ETIMEDOUT' };
    });
  }
  // docker: one container per build, compiles and runs every command (no network)
  fs.writeFileSync(path.join(dir, 'cmds.txt'), cmds.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'run.sh'), [
    'g++ -std=c++17 -O2 -o prog main.cpp 2> compile.log || exit 0',
    'i=0',
    'while IFS= read -r line; do',
    '  printf "%s\\n" "$line" | timeout 5 ./prog > out.$i 2> err.$i; echo $? > code.$i',
    '  i=$((i+1))',
    'done < cmds.txt',
  ].join('\n') + '\n');
  const d = spawnSync('docker', ['run', '--rm', '--network', 'none', '-v', `${dir}:/w`, '-w', '/w', 'gcc:13', 'sh', 'run.sh'], { encoding: 'utf8' });
  if (d.status !== 0) return { compileError: 'docker failed: ' + (d.stderr || '').slice(0, 1000) };
  if (!fs.existsSync(path.join(dir, 'code.0'))) return { compileError: fs.readFileSync(path.join(dir, 'compile.log'), 'utf8').slice(0, 2000) };
  const rd = (f) => fs.readFileSync(path.join(dir, f), 'utf8').trim();
  return cmds.map((_, i) => ({ out: rd(`out.${i}`), err: rd(`err.${i}`), code: parseInt(rd(`code.${i}`), 10), timedOut: parseInt(rd(`code.${i}`), 10) === 124 }));
}

// what a cell shows
function cell(r) {
  if (r.timedOut) return 'TIMEOUT';
  if (r.code !== 0) return `CRASH(${r.code})`;
  return r.out;
}
const asRun = (r) => ({ status: r.timedOut ? 'time_limit' : r.code !== 0 ? 'runtime_error' : 'accepted', stdout: r.out });

// ---------- load ----------
const questions = JSON.parse(fs.readFileSync(path.join(ROOT, 'questions.json'), 'utf8'));
const readMeta = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const refDir = path.join(ROOT, 'reference');
const variantIds = fs.readdirSync(path.join(ROOT, 'variants')).filter((d) => /^v\d\d-/.test(d)).sort();
const variants = variantIds.map((id) => ({ id, short: id.slice(0, 3), dir: path.join(ROOT, 'variants', id), meta: readMeta(path.join(ROOT, 'variants', id)) }));
const submissions = [{ id: 'reference', short: 'ref', dir: refDir, meta: readMeta(refDir) }, ...variants];
const fnNames = Object.keys(questions.functions);
const allInputs = (fn) => [...questions.functions[fn].standardInputs, ...questions.functions[fn].targetInputs];

const problems = [];
for (const fn of fnNames) {
  for (const input of allInputs(fn)) {
    const bad = undefinedInput(fn, input);
    if (bad) problems.push(`${fn}: input "${input.cmd}" is ${bad}`);
  }
}

// every distinct plain command, in first-seen order
const cmds = [];
for (const fn of fnNames) for (const i of allInputs(fn)) if (!cmds.includes(i.cmd)) cmds.push(i.cmd);

const tc = detectToolchain();
console.log(`toolchain: ${tc.kind === 'native' ? tc.gxx : 'docker gcc:13 --network none'} (-O2 -std=c++17)`);

function runBuild(name, source, list) {
  const res = compileAndRun(tc, name, source, list);
  if (res.compileError) { console.error(`COMPILE ERROR in ${name}:\n${res.compileError}`); process.exit(1); }
  return res;
}

const plain = {}; // id -> Map(cmd -> result)
const toMap = (list, res) => new Map(list.map((c, i) => [c, res[i]]));
for (const s of submissions) plain[s.id] = toMap(cmds, runBuild(s.id, build(s.dir), cmds));
const ref = (cmd) => plain.reference.get(cmd);
const differs = (id, cmd) => cell(plain[id].get(cmd)) !== cell(ref(cmd));

// ---------- computed fields of questions.json ----------
for (const fn of fnNames) for (const i of allInputs(fn)) i.spec = cell(ref(i.cmd));

// The reference's own trace on every input of a function (the pause line and variables are in reference/meta.json).
const refHeader = fs.readFileSync(path.join(refDir, 'functions.h'), 'utf8');
const refCode = fs.readFileSync(path.join(refDir, 'functions.cpp'), 'utf8');
const driver = fs.readFileSync(path.join(ROOT, 'driver', 'main.cpp'), 'utf8');
for (const fn of fnNames) {
  const t = submissions[0].meta.interview[fn].tracing;
  const built = harness.buildTraceProgram({ header: refHeader, studentSource: refCode, driver, pauseLine: t.pauseLine, variables: t.variables });
  if (!built.ok) { problems.push(`reference trace for ${fn} could not be built: ${built.reason}`); continue; }
  const list = allInputs(fn).map((i) => i.cmd);
  const res = runBuild(`reference-trace-${fn}`, built.source, list);
  allInputs(fn).forEach((input, k) => {
    input.refStops = harness.parseAllStops(res[k].err).map((s) => s.text);
  });
}
fs.writeFileSync(path.join(ROOT, 'questions.json'), JSON.stringify(questions, null, 2) + '\n');

// ---------- checks ----------
for (const v of variants) {
  if (v.meta.bugs.length === 0) {
    for (const c of cmds) if (differs(v.id, c)) problems.push(`${v.id} is meant to be correct but differs on "${c}"`);
  }
}
for (const fn of fnNames) {
  for (const i of questions.functions[fn].targetInputs) {
    const v = variants.find((x) => x.short === i.bug);
    if (!v || !differs(v.id, i.cmd)) problems.push(`${fn}: target for ${i.bug} "${i.cmd}" does not make that variant differ from the reference`);
  }
}

// ---------- targeting ----------
const pickFor = (v, fn) => {
  const f = questions.functions[fn];
  return selectInput({ fn, standardInputs: f.standardInputs, targetInputs: f.targetInputs, runs: new Map(allInputs(fn).map((i) => [i.cmd, asRun(plain[v.id].get(i.cmd))])) });
};
const label = (p) => (p.input ? `${p.targeted ? 'target' : 'standard'}: ${p.input.cmd}` : 'none');

// ---------- matrix.md ----------
const esc = (s) => String(s).replace(/\|/g, '\\|');
const columns = submissions.map((s) => s.id);
const head = (c) => (c === 'reference' ? 'reference' : c.slice(0, 3));
let md = '# Assignment 02 eval matrix\n\n';
md += `Generated by run-all.js with ${tc.kind === 'native' ? tc.gxx : 'docker gcc:13'} (-O2 -std=c++17, like the runner image). Cells that differ from the reference are marked **✗**. CRASH(n) = non-zero exit code. The M1 matrix (-O0) is kept as results/matrix-m1.md.\n\n`;
md += variants.map((v) => `- **${v.short}** ${v.id}: ${v.meta.summary}`).join('\n') + '\n\n';
md += '## 1. Plain commands (what the student code returns)\n\n';
md += `| input | ${columns.map(head).join(' | ')} |\n|---|${columns.map(() => '---').join('|')}|\n`;
for (const c of cmds) {
  const cells = columns.map((id) => {
    const text = esc(cell(plain[id].get(c)));
    return id === 'reference' ? `\`${text}\`` : differs(id, c) ? `**✗ \`${text}\`**` : `\`${text}\``;
  });
  md += `| \`${esc(c)}\` | ${cells.join(' | ')} |\n`;
}

md += '\n## 2. Predict answers (spec) and the reference\'s trace stops\n\nThe spec answer is what the reference prints. Tracing has no spec answer: a tracing answer is the student\'s own trace. The reference\'s stops are used only to pick a K for targeted tracing questions.\n\n';
md += '| function | input | spec answer | reference stops (tracing) | note |\n|---|---|---|---|---|\n';
for (const fn of fnNames) {
  for (const i of allInputs(fn)) {
    const bad = i.unclearSpec ? `unclear spec, not used: ${i.reason}` : '';
    md += `| ${fn} | \`${esc(i.cmd)}\` | \`${esc(i.spec)}\` | ${i.refStops.length ? i.refStops.map((s) => `\`${esc(s)}\``).join(' → ') : 'no stop'} | ${bad} |\n`;
  }
}

md += '\n## 3. Input the targeting rules pick (main questions: predict and tracing use the same input)\n\n';
md += 'Rules: the first target input where the code differs from the spec; never an input where the code crashes, errors or hits the limit; never an unclear-spec input; otherwise the first standard input (targeted = no).\n\n';
md += '| submission | function | input | targeted | why |\n|---|---|---|---|---|\n';
for (const s of submissions) {
  for (const fn of fnNames) {
    const p = pickFor(s, fn);
    md += `| ${s.short} | ${fn} | ${p.input ? `\`${esc(p.input.cmd)}\`` : 'none'} | ${p.targeted ? 'yes' : 'no'} | ${esc(p.reason)} |\n`;
  }
}

md += '\n## 4. Can a usable input catch each variant\'s bug?\n\n';
md += 'Counts inputs in questions.json whose plain output differs from the reference, that the rules allow (no crash, no unclear spec). Whether a tracing question exposes the bug depends on the student\'s own trace and is checked in harness.md.\n\n';
md += '| variant | declared bug | usable inputs that catch it |\n|---|---|---|\n';
const uncaught = [];
for (const v of variants) {
  if (v.meta.bugs.length === 0) { md += `| ${v.short} | none (correct) | n/a |\n`; continue; }
  for (const b of v.meta.bugs) {
    const usable = [];
    const rejected = [];
    for (const i of allInputs(b.function)) {
      if (!differs(v.id, i.cmd)) continue;
      const r = asRun(plain[v.id].get(i.cmd));
      if (i.unclearSpec) rejected.push(`${i.cmd} (unclear spec)`);
      else if (r.status !== 'accepted') rejected.push(`${i.cmd} (${plain[v.id].get(i.cmd).code === null ? 'time limit' : 'crash'})`);
      else usable.push(i.cmd);
    }
    if (!usable.length) uncaught.push(`${v.id} (${b.function})`);
    md += `| ${v.short} | ${b.function}: ${b.kind} | ${usable.length ? usable.map((c) => `\`${esc(c)}\``).join(', ') : '**none**'}${rejected.length ? `; not usable: ${rejected.map(esc).join(', ')}` : ''} |\n`;
  }
}
if (problems.length) md += '\n## Problems\n\n' + problems.map((p) => `- ${p}`).join('\n') + '\n';
fs.mkdirSync(RESULTS, { recursive: true });
fs.writeFileSync(path.join(RESULTS, 'matrix.md'), md);
fs.writeFileSync(path.join(RESULTS, '.gitignore'), '.build/\n');

// ---------- console ----------
console.log(`\n${cmds.length} distinct commands x ${columns.length} columns. Wrote results/matrix.md and the spec / refStops fields in questions.json.\n`);
console.log('Targeting picks:');
for (const s of submissions) {
  console.log('  ' + s.short.padEnd(4) + fnNames.map((fn) => `${fn}=[${label(pickFor(s, fn))}]`).join(' '));
}
console.log('\nBugs no usable input catches: ' + (uncaught.length ? uncaught.join(', ') : 'none'));
if (problems.length) { console.log('\nPROBLEMS:\n' + problems.map((p) => '  - ' + p).join('\n')); process.exitCode = 1; }
