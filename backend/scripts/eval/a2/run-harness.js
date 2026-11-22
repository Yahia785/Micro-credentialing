#!/usr/bin/env node
// Builds plain, trace and what-if copies of the reference and of every fake submission (v01 to v10) with the real harness builder, runs
// them through the real runAllQuestions (services/interview-runs.js) and checks:
//   - plain outputs match the M1 matrix (results/matrix-m1.md)
//   - the trace copy's stdout equals the plain stdout, and the chosen K-th stop exists
//   - each what-if passes both rules (alters the output; is not the fix) or is skipped with a reason
// and writes results/harness.md and results/harness.json.
//
//   GXX=D:/raylib/w64devkit/bin/g++.exe node run-harness.js              local g++ (the runner image's flags: -O2 -std=c++17)
//   node run-harness.js --runner dev [--yes]                              the same runs through the dev runner Lambda
//
// --runner dev prints how many runner calls it will make and waits for "yes" (or --yes) before calling AWS. It needs AWS credentials and
// CODE_RUNNER_FUNCTION (default micro-credentialing-runner-dev-recycle). Output of the two runners is compared; every difference is
// written to results/harness-dev.md.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { runAllQuestions } = require('../../../shared/nodejs/services/interview-runs');
const { selectInput, alignStops, chooseK, checkWhatIf, unusable, ordinal } = require('./selection');
const { findCompiler, makeLocalRunBatch } = require('./local-runner');

// the shared logger prints JSON lines for every run; they would bury this script's own output
for (const name of ['log', 'error']) {
  const original = console[name].bind(console);
  console[name] = (...a) => { if (!(typeof a[0] === 'string' && a[0].startsWith('{"level"'))) original(...a); };
}

const ROOT = __dirname;
const RESULTS = path.join(ROOT, 'results');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const RUNNER = option('--runner') || 'local';
const LIMIT_PER_INTERVIEW = 30; // run-limiter: RUN_LIMIT_AGENT_PER_INTERVIEW

const questions = JSON.parse(fs.readFileSync(path.join(ROOT, 'questions.json'), 'utf8'));
const fnNames = Object.keys(questions.functions);
const primaryFns = fnNames.filter((f) => questions.functions[f].primary);
const readMeta = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const variantIds = fs.readdirSync(path.join(ROOT, 'variants')).filter((d) => /^v\d\d-/.test(d)).sort();
const submissions = [
  { id: 'reference', short: 'ref', dir: path.join(ROOT, 'reference') },
  ...variantIds.map((id) => ({ id, short: id.slice(0, 3), dir: path.join(ROOT, 'variants', id) })),
].map((s) => ({ ...s, meta: readMeta(s.dir), code: fs.readFileSync(path.join(s.dir, 'functions.cpp'), 'utf8') }));
const harness = {
  header: fs.readFileSync(path.join(ROOT, 'reference', 'functions.h'), 'utf8'), // every student gets the assignment's header
  driver: fs.readFileSync(path.join(ROOT, 'driver', 'main.cpp'), 'utf8'),
};
const inputsOf = (fn) => [...questions.functions[fn].standardInputs, ...questions.functions[fn].targetInputs];

// ---------- M1 matrix ----------
function readM1() {
  const rows = new Map();
  const text = fs.readFileSync(path.join(RESULTS, 'matrix-m1.md'), 'utf8').split('\n');
  const split = (line) => line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
  const clean = (c) => c.replace(/^\*\*✗ /, '').replace(/\*\*$/, '').replace(/^`|`$/g, '').replace(/\\\|/g, '|');
  let ids = null;
  for (const line of text) {
    if (line.startsWith('## 2')) break;
    if (line.startsWith('| input |')) { ids = split(line).slice(1); continue; }
    if (ids && line.startsWith('| `')) {
      const cells = split(line);
      rows.set(clean(cells[0]), Object.fromEntries(ids.map((id, i) => [id, clean(cells[i + 1])])));
    }
  }
  return rows;
}
const sameAsM1 = (m1, mine) => (/^CRASH/.test(m1) && /^CRASH/.test(mine)) || m1 === mine; // crash exit codes differ by compiler and flags

// ---------- running ----------
const trimOut = (s) => String(s || '').trim();

/** One interview's runs for one submission, in the order the platform would make them. `runBatch` is the local or the dev runner. */
async function evaluate(sub, runBatch, counters) {
  const common = { code: sub.code, userId: 'harness', interviewId: `harness-${sub.short}`, runBatch, harness, countRun: async () => { counters.agentRuns += 1; } };
  const result = { id: sub.id, short: sub.short, functions: {}, systemErrors: [], plainAll: {}, runs: { phase1: 0, phase2: 0 }, runnerGroups: [] };

  // phase 0 (not part of an interview): every input in questions.json, plain, to compare with the M1 matrix
  const all = [];
  fnNames.forEach((fn) => inputsOf(fn).forEach((i) => { if (!all.some((a) => a.stdin === i.cmd)) all.push({ label: i.cmd, stdin: i.cmd, program: { kind: 'plain' } }); }));
  const before0 = counters.agentRuns;
  const phase0 = await runAllQuestions({ ...common, questions: [all] });
  counters.agentRuns = before0; // not an interview run
  for (const r of phase0[0].runs) result.plainAll[r.stdin] = { status: r.status, stdout: trimOut(r.stdout) };
  if (phase0[0].errors) result.systemErrors.push(...phase0[0].errors.map((e) => ({ function: '(all inputs)', ...e })));
  if (phase0[0].note) result.systemErrors.push({ function: '(all inputs)', stage: 'run', reason: phase0[0].note });

  // phase 1: candidate inputs for the main question of every function: usable target inputs and the first usable standard input
  const candidates = {};
  for (const fn of fnNames) {
    const f = questions.functions[fn];
    const targets = f.targetInputs.filter((i) => !unusable(fn, i));
    const firstStd = f.standardInputs.find((i) => !unusable(fn, i));
    candidates[fn] = [...targets, ...(firstStd ? [firstStd] : [])];
  }
  const p1 = await runAllQuestions({ ...common, questions: fnNames.map((fn) => candidates[fn].map((i) => ({ label: i.cmd, stdin: i.cmd, program: { kind: 'plain' } }))) });
  const selection = {};
  fnNames.forEach((fn, q) => {
    const runs = new Map(p1[q].runs.map((r) => [r.stdin, { status: r.status, stdout: r.stdout }]));
    const f = questions.functions[fn];
    let sel = selectInput({ fn, standardInputs: f.standardInputs.filter((i) => candidates[fn].includes(i)), targetInputs: f.targetInputs.filter((i) => candidates[fn].includes(i)), runs });
    if (!sel.input) {
      // the first standard input crashed: the next standard inputs are tried (extra runs, counted below)
      sel = { ...sel, retry: true };
    }
    selection[fn] = { sel, plain: sel.input ? runs.get(sel.input.cmd) : null, runs: candidates[fn].length };
    if (p1[q].errors) result.systemErrors.push(...p1[q].errors.map((e) => ({ function: fn, ...e })));
  });
  result.runs.phase1 = fnNames.reduce((n, fn) => n + selection[fn].runs, 0);

  // phase 2: for the chosen input of every function: the trace copy and the what-if copy
  const meta = (fn) => sub.meta.interview[fn];
  const p2questions = fnNames.map((fn) => {
    const { sel, plain } = selection[fn];
    if (!sel.input) return [];
    const list = [];
    const t = meta(fn).tracing;
    if (t && !t.unavailable) list.push({ label: 'trace', stdin: sel.input.cmd, program: { kind: 'trace', pauseLine: t.pauseLine, variables: t.variables, expectStdout: plain.stdout } });
    const w = meta(fn).whatIf;
    if (w) list.push({ label: 'whatIf', stdin: sel.input.cmd, program: { kind: 'whatIf', line: w.line, find: w.find, replace: w.replace } });
    return list;
  });
  const p2 = await runAllQuestions({ ...common, questions: p2questions });
  fnNames.forEach((fn, q) => {
    const { sel, plain } = selection[fn];
    const f = questions.functions[fn];
    const out = { input: sel.input ? sel.input.cmd : null, display: sel.input ? sel.input.display : null, targeted: sel.targeted, bug: sel.bug || null, reason: sel.reason, skippedInputs: sel.skipped, spec: sel.input ? sel.input.spec : null, plainOutput: plain ? trimOut(plain.stdout) : null, plainStatus: plain ? plain.status : null, candidateRuns: selection[fn].runs, traceRuns: 0, whatIfRuns: 0 };
    const errors = p2[q].errors || [];
    out.errors = errors;
    result.systemErrors.push(...errors.map((e) => ({ function: fn, ...e })));
    const t = meta(fn).tracing;
    // trace
    const traceRun = p2[q].runs.find((r) => r.kind === 'trace');
    const traceError = errors.find((e) => e.kind === 'trace');
    out.traceRuns = p2questions[q].some((r) => r.label === 'trace') && !errors.some((e) => e.kind === 'trace' && e.stage === 'build') ? 1 : 0;
    out.whatIfRuns = p2questions[q].some((r) => r.label === 'whatIf') && !errors.some((e) => e.kind === 'whatIf' && e.stage === 'build') ? 1 : 0;
    if (!sel.input) out.trace = { available: false, reason: 'no input runs cleanly' };
    else if (t && t.unavailable) out.trace = { available: false, reason: t.unavailable, expected: true };
    else if (traceError) out.trace = { available: false, reason: `${traceError.stage}: ${traceError.reason}`, failure: true };
    else if (!traceRun || traceRun.trace.total === 0) out.trace = { available: false, reason: 'the breakpoint line is never reached on the chosen input', failure: true };
    else {
      const input = sel.input;
      const stops = traceRun.trace.stops.map((s) => s.text);
      const k = chooseK({ stops, refStops: input.refStops, preferredK: f.tracing.preferredK, targeted: sel.targeted });
      out.trace = {
        available: true, pauseLine: t.pauseLine, variables: t.variables.map((v) => v.name), total: traceRun.trace.total, k, kth: ordinal(k), answer: stops[k - 1], allStops: stops,
        differsFromReference: !alignStops(stops, input.refStops || []).contiguous,
        stdoutEqualsPlain: trimOut(traceRun.stdout) === trimOut(plain.stdout),
      };
    }
    // what-if
    const whatRun = p2[q].runs.find((r) => r.kind === 'whatIf');
    const whatError = errors.find((e) => e.kind === 'whatIf');
    const w = meta(fn).whatIf;
    if (!sel.input) out.whatIf = { prepared: false, reason: 'no input runs cleanly' };
    else if (whatError) out.whatIf = { prepared: false, reason: `${whatError.stage}: ${whatError.reason}`, line: w.line, find: w.find, replace: w.replace };
    else {
      const verdict = checkWhatIf({ plain, whatIf: whatRun, spec: sel.input.spec });
      out.whatIf = { prepared: verdict.ok, reason: verdict.ok ? null : verdict.reason, line: w.line, find: w.find, replace: w.replace, output: whatRun ? trimOut(whatRun.stdout) : null };
    }
    result.functions[fn] = out;
  });
  result.runs.phase2 = fnNames.reduce((n, fn) => n + result.functions[fn].traceRuns + result.functions[fn].whatIfRuns, 0);
  return result;
}

/** Agent runs one interview of this submission uses in form A or B (mode only when a function cannot be asked). */
function interviewRuns(result, form) {
  const types = questions.forms[form];
  let runs = 0;
  let modeNeeded = false;
  for (const fn of primaryFns) {
    const r = result.functions[fn];
    runs += r.candidateRuns + r.whatIfRuns;
    if (types[fn] === 'tracing') { runs += r.traceRuns; if (!r.trace.available) modeNeeded = true; }
    if (types[fn] === 'predict' && !r.input) modeNeeded = true;
  }
  if (modeNeeded) {
    const m = result.functions.mode;
    // mode takes the type of the function it replaces; it is counted with a trace run when that type is tracing
    const replaced = primaryFns.filter((fn) => (types[fn] === 'tracing' && !result.functions[fn].trace.available) || (types[fn] === 'predict' && !result.functions[fn].input));
    runs += m.candidateRuns + m.whatIfRuns + (replaced.some((fn) => types[fn] === 'tracing') ? m.traceRuns : 0);
  }
  return { runs, modeNeeded };
}

/** A runBatch wrapper that records how many distinct sources (= runner calls) each batch has. */
function recording(inner) {
  const recorder = { batches: [], groups: 0, runs: 0 };
  const fn = async (runs, options) => {
    const keys = new Set(runs.map((r) => JSON.stringify([r.source, r.timeLimitMs, r.memoryLimitKb])));
    recorder.batches.push({ runs: runs.length, groups: keys.size });
    recorder.groups += keys.size;
    recorder.runs += runs.length;
    return inner(runs, options);
  };
  return { fn, recorder };
}

async function runAll(runBatch) {
  const results = [];
  const rec = recording(runBatch);
  for (const sub of submissions) {
    const counters = { agentRuns: 0 };
    const before = rec.recorder.groups;
    const r = await evaluate(sub, rec.fn, counters);
    r.runnerCalls = rec.recorder.groups - before;
    results.push(r);
    process.stdout.write(`  ${sub.short} done (${r.runnerCalls} runner calls)\n`);
  }
  return { results, recorder: rec.recorder };
}

// ---------- report ----------
const cellOf = (r) => (r.status === 'accepted' ? r.stdout : r.status === 'time_limit' ? 'TIMEOUT' : 'CRASH');

function report(results, env) {
  const m1 = readM1();
  const lines = [];
  let plainTotal = 0; let plainOk = 0; const plainBad = [];
  for (const r of results) {
    for (const [cmd, row] of m1) {
      const mine = r.plainAll[cmd];
      if (!mine) continue;
      plainTotal += 1;
      const m1cell = row[r.id === 'reference' ? 'reference' : r.short];
      if (sameAsM1(m1cell, cellOf(mine))) plainOk += 1; else plainBad.push(`${r.short} \`${cmd}\`: M1 \`${m1cell}\`, now \`${cellOf(mine)}\``);
    }
  }
  const allFns = (r) => fnNames.map((fn) => ({ fn, ...r.functions[fn] }));
  const traceRows = results.flatMap((r) => allFns(r).map((x) => ({ sub: r.short, ...x })));
  const traceOk = traceRows.filter((x) => x.trace.available && x.trace.stdoutEqualsPlain && x.trace.k && x.trace.allStops.length >= x.trace.k);
  const traceExpected = traceRows.filter((x) => !x.trace.available && x.trace.expected);
  const traceFail = traceRows.filter((x) => !traceOk.includes(x) && !traceExpected.includes(x));
  const whatOk = traceRows.filter((x) => x.whatIf.prepared);
  const whatSkipped = traceRows.filter((x) => !x.whatIf.prepared);
  const sysErrors = results.flatMap((r) => r.systemErrors.map((e) => ({ sub: r.short, ...e })));

  const formRuns = results.map((r) => ({ sub: r.short, A: interviewRuns(r, 'A'), B: interviewRuns(r, 'B') }));
  const maxRuns = Math.max(...formRuns.flatMap((x) => [x.A.runs, x.B.runs]));

  lines.push('# Harness check (M2)', '');
  lines.push(`Runner: ${env.runner}. Flags: -O2 -std=c++17 (the runner image's). Built with services/harness-builder.js, run through services/interview-runs.js (runAllQuestions). ${submissions.length} submissions x ${fnNames.length} functions.`, '');
  lines.push('## Summary', '');
  lines.push('| check | result |', '|---|---|');
  lines.push(`| plain outputs match the M1 matrix | ${plainOk} of ${plainTotal} cells${plainBad.length ? ` (${plainBad.length} differ)` : ''} |`);
  lines.push(`| trace copy built, compiled, stdout equals plain stdout, chosen K-th stop exists | ${traceOk.length} of ${traceRows.length - traceExpected.length} (${traceExpected.length} not applicable: no line to put a breakpoint on) |`);
  lines.push(`| tracing stops are not a contiguous part of the reference's stops | ${traceOk.filter((x) => x.trace.differsFromReference).length} of ${traceOk.length} (targeted inputs: ${traceOk.filter((x) => x.targeted && x.trace.differsFromReference).length} of ${traceOk.filter((x) => x.targeted).length}) |`);
  lines.push(`| what-if passes both rules | ${whatOk.length} of ${traceRows.length}; ${whatSkipped.length} skipped with a reason |`);
  lines.push(`| system errors | ${sysErrors.length} |`);
  lines.push(`| agent runs in one A2 interview (limit ${LIMIT_PER_INTERVIEW}) | most: ${maxRuns} (form A: ${Math.max(...formRuns.map((x) => x.A.runs))}, form B: ${Math.max(...formRuns.map((x) => x.B.runs))}) |`, '');
  if (plainBad.length) lines.push('### Plain outputs that differ from M1', '', ...plainBad.map((x) => `- ${x}`), '');
  if (traceFail.length) lines.push('### Trace failures', '', ...traceFail.map((x) => `- ${x.sub} ${x.fn}: ${x.trace.reason || 'check failed'}`), '');

  lines.push('## What-if follow-ups that are skipped', '');
  if (whatSkipped.length === 0) lines.push('None.', '');
  else lines.push('| submission | function | change | reason |', '|---|---|---|---|', ...whatSkipped.map((x) => `| ${x.sub} | ${x.fn} | line ${x.whatIf.line}: \`${x.whatIf.find}\` → \`${x.whatIf.replace}\` | ${x.whatIf.reason} |`), '');

  lines.push('## System errors', '');
  if (sysErrors.length === 0) lines.push('None.', '');
  else lines.push('| submission | function | kind | stage | reason |', '|---|---|---|---|---|', ...sysErrors.map((e) => `| ${e.sub} | ${e.function} | ${e.kind || ''} | ${e.stage} | ${e.reason} |`), '');

  lines.push('## Agent runs per interview', '');
  lines.push('Counted the way run-limiter counts them: one per input sent to the runner. Candidate inputs of the three main functions (usable target inputs + the first standard input), one trace run per tracing question, one run per prepared what-if. mode is counted only when it replaces a function that cannot be asked.', '');
  lines.push('| submission | form A | form B | mode used (A / B) |', '|---|---|---|---|', ...formRuns.map((x) => `| ${x.sub} | ${x.A.runs} | ${x.B.runs} | ${x.A.modeNeeded ? 'yes' : 'no'} / ${x.B.modeNeeded ? 'yes' : 'no'} |`), '');

  lines.push('## Per submission and function', '');
  lines.push('| submission | function | input (targeted?) | breakpoint line → K-th stop | what-if (line: change) → output |', '|---|---|---|---|---|');
  for (const x of traceRows) {
    const t = x.trace.available ? `line ${x.trace.pauseLine}, ${x.trace.kth} of ${x.trace.total}: ${x.trace.answer} (differs from reference: ${x.trace.differsFromReference ? 'yes' : 'no'})` : `not available: ${x.trace.reason}`;
    const w = x.whatIf.prepared ? `${x.whatIf.line}: \`${x.whatIf.find}\` → \`${x.whatIf.replace}\` → \`${x.whatIf.output}\`` : `skipped: ${x.whatIf.reason}`;
    lines.push(`| ${x.sub} | ${x.fn} | ${x.input ? `\`${x.input}\` (${x.targeted ? 'targeted' : 'standard'})` : 'none'} | ${String(t).replace(/\|/g, '\\|')} | ${w.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  return { md: lines.join('\n') + '\n', stats: { plainTotal, plainOk, plainBad, traceOk: traceOk.length, traceTotal: traceRows.length, traceExpected: traceExpected.length, traceFail: traceFail.length, whatOk: whatOk.length, whatSkipped: whatSkipped.length, sysErrors: sysErrors.length, maxRuns, formRuns } };
}

// ---------- main ----------
async function confirm(text) {
  if (flag('--yes')) return true;
  if (!process.stdin.isTTY) { console.log('(no terminal to ask on: pass --yes after you have read the numbers above)'); return false; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(text, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

(async () => {
  const compiler = findCompiler();
  if (!compiler) { console.error('No g++ found. Put it on PATH or set GXX=/path/to/g++ (the local run is always needed: it is the baseline).'); process.exit(1); }
  const local = makeLocalRunBatch({ gxx: compiler.gxx });
  console.log(`local runner: ${compiler.version}`);
  console.log('running locally ...');
  const localRun = await runAll(local.runBatch);
  const rep = report(localRun.results, { runner: `local ${compiler.version}` });
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(path.join(RESULTS, 'harness.md'), rep.md);
  fs.writeFileSync(path.join(RESULTS, 'harness.json'), JSON.stringify({ runner: compiler.version, results: localRun.results }, null, 2) + '\n');
  console.log(`local: plain ${rep.stats.plainOk}/${rep.stats.plainTotal}, trace ${rep.stats.traceOk}/${rep.stats.traceTotal - rep.stats.traceExpected} (+${rep.stats.traceExpected} n/a), what-if ${rep.stats.whatOk}/${rep.stats.whatOk + rep.stats.whatSkipped}, system errors ${rep.stats.sysErrors}, most agent runs in one interview ${rep.stats.maxRuns}/${LIMIT_PER_INTERVIEW}`);

  if (RUNNER !== 'dev') return;
  const groups = localRun.recorder.groups;
  console.log(`\nThe dev runner run will make ${groups} runner calls (Lambda invocations of ${process.env.CODE_RUNNER_FUNCTION || 'micro-credentialing-runner-dev-recycle'}) for ${localRun.recorder.runs} program runs, one call per distinct source.`);
  if (!(await confirm('Call the dev runner? (yes/no) '))) { console.log('Not calling the dev runner.'); return; }
  process.env.CODE_RUNNER = 'own';
  process.env.CODE_RUNNER_FUNCTION = process.env.CODE_RUNNER_FUNCTION || 'micro-credentialing-runner-dev-recycle';
  process.env.CODE_RUNNER_TENANT_ISOLATION = 'off';
  process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
  const { runCppBatch } = require('../../../shared/nodejs/utils/codeRunner');
  const devRun = await runAll(runCppBatch);
  const devRep = report(devRun.results, { runner: `dev runner ${process.env.CODE_RUNNER_FUNCTION}` });
  fs.writeFileSync(path.join(RESULTS, 'harness-dev.md'), `${devRep.md}\n${diffReport(localRun.results, devRun.results)}`);
  fs.writeFileSync(path.join(RESULTS, 'harness-dev.json'), JSON.stringify({ runner: process.env.CODE_RUNNER_FUNCTION, results: devRun.results }, null, 2) + '\n');
  console.log(`dev: plain ${devRep.stats.plainOk}/${devRep.stats.plainTotal}, trace ${devRep.stats.traceOk}/${devRep.stats.traceTotal - devRep.stats.traceExpected}, what-if ${devRep.stats.whatOk}/${devRep.stats.whatOk + devRep.stats.whatSkipped}, system errors ${devRep.stats.sysErrors}`);
})().catch((error) => { console.error(error); process.exit(1); });

/** Every difference between two runs of the same plan (local vs dev). */
function diffReport(a, b) {
  const out = ['## Differences, local vs dev runner', ''];
  const diffs = [];
  a.forEach((ra, i) => {
    const rb = b[i];
    for (const cmd of Object.keys(ra.plainAll)) {
      const x = ra.plainAll[cmd]; const y = rb.plainAll[cmd];
      if (!y) diffs.push(`${ra.short} plain \`${cmd}\`: missing from the dev run`);
      else if (cellOf(x) !== cellOf(y)) diffs.push(`${ra.short} plain \`${cmd}\`: local \`${cellOf(x)}\`, dev \`${cellOf(y)}\``);
    }
    for (const fn of fnNames) {
      const x = ra.functions[fn]; const y = rb.functions[fn];
      if (x.input !== y.input) diffs.push(`${ra.short} ${fn}: chosen input differs (local \`${x.input}\`, dev \`${y.input}\`)`);
      if (JSON.stringify(x.trace) !== JSON.stringify(y.trace)) diffs.push(`${ra.short} ${fn}: trace differs (local ${JSON.stringify(x.trace && x.trace.answer)}, dev ${JSON.stringify(y.trace && y.trace.answer)}; ${x.trace.reason || ''} / ${y.trace.reason || ''})`);
      if (JSON.stringify(x.whatIf) !== JSON.stringify(y.whatIf)) diffs.push(`${ra.short} ${fn}: what-if differs (local ${JSON.stringify(x.whatIf.output)}, dev ${JSON.stringify(y.whatIf.output)})`);
    }
  });
  out.push(diffs.length ? diffs.map((d) => `- ${d}`).join('\n') : 'None: every output, trace and what-if result is the same.', '');
  return out.join('\n');
}
