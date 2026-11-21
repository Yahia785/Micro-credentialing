#!/usr/bin/env node
// Compiles the reference, every variant, the what-if mutants and the trace copies (each with the
// driver, as ONE source file via build.js), runs every input in questions.json and writes
//   results/matrix.md   inputs x (reference + variants), differing cells marked; what-if / tracing answers;
//                       targeting picks; bugs that no input catches
// It also fills every "spec" field in questions.json (so spec answers always come from running code).
//
//   node run-all.js              (from anywhere)
//   GXX=/path/to/g++ node run-all.js     use a specific g++ that is not on PATH
//   RUNNER=docker node run-all.js        force docker (gcc:13, --network none)
//
// Compiler choice: $GXX, else g++ on PATH, else docker with the gcc:13 image. The docker path has
// not been exercised yet on this machine (the Docker daemon was off).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { build } = require('./build');

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

function limitHit(r) { return r.signal || r.status === null || r.status === 124; }

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
    const c = spawnSync(tc.gxx, ['-std=c++17', '-O0', '-o', exe, path.join(dir, 'main.cpp')], { encoding: 'utf8', env });
    if (c.status !== 0) return { compileError: (c.stderr || String(c.error)).slice(0, 2000) };
    return cmds.map((cmd) => {
      const r = spawnSync(exe, [], { input: cmd + '\n', encoding: 'utf8', timeout: TIMEOUT_MS });
      return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), code: r.status, timedOut: !!r.error && r.error.code === 'ETIMEDOUT' };
    });
  }
  // docker: one container per build, compiles and runs every command (no network)
  fs.writeFileSync(path.join(dir, 'cmds.txt'), cmds.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'run.sh'), [
    'g++ -std=c++17 -O0 -o prog main.cpp 2> compile.log || exit 0',
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

// ---------- load ----------
const questions = JSON.parse(fs.readFileSync(path.join(ROOT, 'questions.json'), 'utf8'));
const variantIds = fs.readdirSync(path.join(ROOT, 'variants')).filter((d) => /^v\d\d-/.test(d)).sort();
const variants = variantIds.map((id) => ({ id, short: id.slice(0, 3), dir: path.join(ROOT, 'variants', id), meta: JSON.parse(fs.readFileSync(path.join(ROOT, 'variants', id, 'meta.json'), 'utf8')) }));
const refDir = path.join(ROOT, 'reference');

const templates = [];
for (const [fn, f] of Object.entries(questions.functions)) for (const t of f.templates) templates.push({ fn, t });

// every distinct plain command, in first-seen order
const cmds = [];
const addCmd = (c) => { if (!cmds.includes(c)) cmds.push(c); };
for (const { t } of templates) for (const i of [...t.standardInputs, ...t.targetInputs]) addCmd(i.cmd);

const tc = detectToolchain();
console.log(`toolchain: ${tc.kind === 'native' ? tc.gxx : 'docker gcc:13 --network none'}`);

function runBuild(name, dir, cppPath, list) {
  const res = compileAndRun(tc, name, build(dir, cppPath), list);
  if (res.compileError) { console.error(`COMPILE ERROR in ${name}:\n${res.compileError}`); process.exit(1); }
  return res;
}

// reference + variants on every plain command
const plain = {}; // id -> Map(cmd -> result)
const toMap = (list, res) => new Map(list.map((c, i) => [c, res[i]]));
plain.reference = toMap(cmds, runBuild('reference', refDir, null, cmds));
for (const v of variants) plain[v.id] = toMap(cmds, runBuild(v.id, v.dir, null, cmds));
const ref = (cmd) => plain.reference.get(cmd);
const differs = (id, cmd) => cell(plain[id].get(cmd)) !== cell(ref(cmd));

// ---------- spec answers ----------
const mutantRuns = {}; // template id -> Map
const traceRuns = {};
const ordinal = (k) => `${k}th`;
for (const { t } of templates) {
  const inputs = [...t.standardInputs, ...t.targetInputs];
  if (t.type === 'predict') {
    for (const i of inputs) i.spec = cell(ref(i.cmd));
  } else if (t.type === 'whatIf') {
    const list = [...new Set(inputs.map((i) => i.cmd))];
    const m = toMap(list, runBuild(t.id.replace(/\W/g, '_'), refDir, path.join(ROOT, t.mutant), list));
    mutantRuns[t.id] = m;
    for (const i of inputs) {
      i.spec = cell(m.get(i.cmd));
      i.changesAnswer = i.spec !== cell(ref(i.cmd)); // does the described change alter the answer at all?
    }
  } else {
    const list = [...new Set(inputs.map((i) => i.cmd))];
    const m = toMap(list, runBuild(t.id.replace(/\W/g, '_'), refDir, path.join(ROOT, t.trace), list));
    traceRuns[t.id] = m;
    for (const i of inputs) {
      const r = m.get(i.cmd);
      const stops = r.err.split('\n').filter((l) => l.startsWith('TRACE ')).map((l) => l.slice(6));
      i.stops = stops.length;
      i.spec = stops.length >= i.k ? stops[i.k - 1] : `it never stops a ${i.kth} time (it stops ${stops.length} time${stops.length === 1 ? '' : 's'})`;
    }
  }
}
fs.writeFileSync(path.join(ROOT, 'questions.json'), JSON.stringify(questions, null, 2) + '\n');

// ---------- checks ----------
const problems = [];
for (const v of variants) {
  const isCorrect = v.meta.bugs.length === 0;
  for (const { fn, t } of templates) {
    if (isCorrect) for (const i of [...t.standardInputs, ...t.targetInputs]) if (differs(v.id, i.cmd)) problems.push(`${v.id} is meant to be correct but differs on "${i.cmd}"`);
  }
}
for (const { t } of templates) {
  for (const i of t.targetInputs) {
    const v = variants.find((x) => x.short === i.bug);
    if (!v || !differs(v.id, i.cmd)) problems.push(`${t.id}: target for ${i.bug} "${i.cmd}" does not make that variant differ from the reference`);
  }
}
const caught = {}; // variant id -> [{template, cmd, kind}]
for (const v of variants) {
  caught[v.id] = [];
  for (const { fn, t } of templates) {
    for (const [kind, list] of [['std', t.standardInputs], ['target', t.targetInputs]]) {
      for (const i of list) if (differs(v.id, i.cmd)) caught[v.id].push({ template: t.id, cmd: i.cmd, kind });
    }
  }
}

// ---------- targeting rule ----------
// first targetInput where the variant differs from the reference, else the first standardInput
function pick(v, t) {
  const hit = t.targetInputs.find((i) => differs(v.id, i.cmd));
  if (hit) return { kind: 'target', input: hit };
  return { kind: 'std', input: t.standardInputs[0] };
}
const label = (p) => `${p.kind === 'target' ? 'T' : 'S'}: ${p.input.cmd}${p.input.k ? ` (k=${p.input.k})` : ''}`;

// ---------- matrix.md ----------
const esc = (s) => String(s).replace(/\|/g, '\\|');
const columns = ['reference', ...variants.map((v) => v.id)];
const head = (c) => (c === 'reference' ? 'reference' : c.slice(0, 3));
let md = '# Assignment 02 eval matrix\n\n';
md += `Generated by run-all.js with ${tc.kind === 'native' ? tc.gxx : 'docker gcc:13'}. Cells that differ from the reference are marked **✗**. CRASH(n) = non-zero exit code.\n\n`;
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

md += '\n## 2. Spec answers for what-if and tracing questions\n\nWhat-if answers come from a one-line mutant of the reference, tracing answers from an instrumented copy of it. "changes answer" = the described change alters the answer compared with the unchanged reference.\n\n';
md += '| template | input | spec answer | note |\n|---|---|---|---|\n';
for (const { t } of templates) {
  if (t.type === 'predict') continue;
  for (const i of [...t.standardInputs, ...t.targetInputs.map((x) => ({ ...x, isTarget: true }))]) {
    const note = t.type === 'whatIf' ? (i.changesAnswer ? '' : 'change does not alter the answer') : '';
    md += `| ${t.id}${i.isTarget ? ` (target ${i.bug})` : ''} | \`${esc(i.cmd)}\`${i.k ? ` k=${i.k}` : ''} | \`${esc(i.spec)}\` | ${note} |\n`;
  }
}

md += '\n## 3. Targeting rule picks\n\nT = first targetInput where the variant differs from the reference, S = first standardInput (no target hit). For tracing templates "differs" is judged on the plain output of the same call (the variants are not instrumented).\n\n';
md += '| variant | function | predict | whatIf | tracing |\n|---|---|---|---|---|\n';
for (const v of variants) {
  for (const fn of Object.keys(questions.functions)) {
    const by = Object.fromEntries(questions.functions[fn].templates.map((t) => [t.type, t]));
    md += `| ${v.short} | ${fn} | ${['predict', 'whatIf', 'tracing'].map((k) => `\`${esc(label(pick(v, by[k])))}\``).join(' | ')} |\n`;
  }
}

md += '\n## 4. Does any input catch each variant\'s bug?\n\n';
md += 'Counts every standard and target input whose plain output differs from the reference. For tracing templates this is only a proxy (the variants are not instrumented): the real trace of v08 and v09 is identical to the reference, so tracing cannot expose them.\n\n';
md += '| variant | declared bug | caught by |\n|---|---|---|\n';
let uncaught = [];
for (const v of variants) {
  if (v.meta.bugs.length === 0) { md += `| ${v.short} | none (correct) | n/a |\n`; continue; }
  for (const b of v.meta.bugs) {
    const hits = caught[v.id].filter((h) => h.template.startsWith(b.function + '.'));
    const types = [...new Set(hits.map((h) => h.template.split('.')[1]))];
    const allTypes = ['predict', 'whatIf', 'tracing'];
    const missing = allTypes.filter((x) => !types.includes(x));
    if (!hits.length) uncaught.push(`${v.id} (${b.function})`);
    md += `| ${v.short} | ${b.function}: ${b.kind} | ${hits.length ? `${hits.length} input(s); templates: ${types.join(', ')}${missing.length ? `; none for: ${missing.join(', ')}` : ''}` : '**NOT CAUGHT**'} |\n`;
  }
}
if (problems.length) md += '\n## Problems\n\n' + problems.map((p) => `- ${p}`).join('\n') + '\n';
fs.mkdirSync(RESULTS, { recursive: true });
fs.writeFileSync(path.join(RESULTS, 'matrix.md'), md);
fs.writeFileSync(path.join(RESULTS, '.gitignore'), '.build/\n');

// ---------- console ----------
console.log(`\n${cmds.length} distinct commands x ${columns.length} columns. Wrote results/matrix.md and the spec fields in questions.json.\n`);
console.log('Targeting picks (T = target hit, S = standard fallback):');
for (const v of variants) {
  for (const fn of Object.keys(questions.functions)) {
    const by = Object.fromEntries(questions.functions[fn].templates.map((t) => [t.type, t]));
    console.log(`  ${v.short} ${fn.padEnd(12)} ` + ['predict', 'whatIf', 'tracing'].map((k) => `${k}=[${label(pick(v, by[k]))}]`).join(' '));
  }
}
console.log('\nBugs no input catches: ' + (uncaught.length ? uncaught.join(', ') : 'none'));
if (problems.length) { console.log('\nPROBLEMS:\n' + problems.map((p) => '  - ' + p).join('\n')); process.exitCode = 1; }
