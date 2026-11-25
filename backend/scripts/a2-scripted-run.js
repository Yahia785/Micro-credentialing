#!/usr/bin/env node
// Runs the scripted answers (D:/a2-pilot-test/scripted/scripted-answers.json, written by scripts/a2-import/scripted-answers.js) through the REAL
// interview-only engine, locally: an in-memory database (the same stand-in the tests use), the student's real code run by a local g++
// (GXX=...), the plans from D:/a2-pilot-test/plans and the records from D:/a2-pilot-test/out. No AWS database, no S3.
//
//   GXX=D:/raylib/w64devkit/bin/g++.exe node scripts/a2-scripted-run.js --fake-model
//   GXX=... node scripts/a2-scripted-run.js --real-model            prints how many model calls it will make and stops
//   GXX=... node scripts/a2-scripted-run.js --real-model --yes      runs them through Bedrock (your AWS credentials; costs money)
//
// Options: --user fakeuser03 (only this student)  --function reverseList (only this function)  --base D:/a2-pilot-test
//
// Each scripted path is one function of one student: a fresh interview is started for the student, positioned at that function (the earlier
// functions are not answered), and the typed answers are sent one by one. After each answer the engine's check result, case and next question
// are compared with what the script expects. Writes <base>/scripted/results.md: every mismatch first, then every path.
// --fake-model uses a deterministic stand-in for the checker, the judge of case 2 and the writer of the smaller step: it shows that the routing,
// the checks and the labels work, not how good a real model is. Nothing of a student is written inside the repo.
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const BASE = opt('--base', 'D:/a2-pilot-test');
const USER = opt('--user', null);
const FUNCTION = opt('--function', null);
const REAL = flag('--real-model');
if (REAL === flag('--fake-model')) { console.error('Choose exactly one of --fake-model and --real-model.'); process.exit(2); }

const SHARED = path.join(__dirname, '..', 'shared', 'nodejs');
const { makeMemoryInterviews } = require(path.join(SHARED, '__tests__', 'helpers', 'a2-memory'));
const { fakeModel } = require(path.join(SHARED, '__tests__', 'helpers', 'a2-fakes'));
const { findCompiler, makeLocalRunBatch } = require('./eval/a2/local-runner');
const git = require('./a2-import/lib/git');

function inject(relative, exportsValue) {
  const file = require.resolve(path.join(SHARED, relative));
  require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsValue };
}

const MILESTONE = { milestoneId: 'milestone_scripted', title: 'Code Interview', language: 'cpp', timeLimit: 5000, memoryLimit: 256000, interview: { enabled: true, interviewOnly: true, source: 'a2-pilot', timeLimitMinutes: 20, maxFollowUpsPerMainQuestion: 2, promptVersion: 'host.a2', themes: [] } };
const WORD = { correct: 'right', wrong: 'wrong', unclear: 'unclear', partly: 'partly' };

/** The value of a stop as a student would type it: without the quotes of a string, "" for the empty string. */
const typedValue = (value) => { const inner = String(value).replace(/^"|"$/g, ''); return inner === '' ? '""' : inner; };
/** A plausible wrong value: a number one more, a string with a letter added. */
function wrongValue(value) {
  const v = String(value);
  if (/^-?\d+$/.test(v.trim())) return String(Number(v) + 1);
  const inner = v.replace(/^"|"$/g, '');
  return inner === '' ? '"x"' : `"${inner}x"`;
}
/** What the smaller code step's intent types: the right value of the variable at the stop that was asked, or a plausible wrong one. */
const fillIntent = (intent, asked) => (intent === 'right' ? typedValue(asked.expected) : typedValue(wrongValue(asked.expected)));

function loadInputs() {
  // The plans decide who is run: a plan carries the importId and the student of the CURRENT import to dev. The repo facts (commit, inputs, header)
  // come from the dry-run records in out/, matched by student, because the same repos give the same facts on every import; only the importId is new.
  const records = fs.readdirSync(`${BASE}/out`).filter((f) => f.endsWith('.json')).map((f) => { const p = JSON.parse(fs.readFileSync(`${BASE}/out/${f}`, 'utf8')); return p.record || p; });
  const recordOf = new Map(records.map((r) => [r.githubUsername, r]));
  const byUser = new Map();
  for (const f of fs.readdirSync(`${BASE}/plans`).filter((name) => name.endsWith('.json') && name !== 'reference.json')) {
    const plan = JSON.parse(fs.readFileSync(`${BASE}/plans/${f}`, 'utf8'));
    if (plan.noPlan || !plan.githubUsername || !recordOf.has(plan.githubUsername)) continue;
    const record = { ...recordOf.get(plan.githubUsername), importId: plan.importId };
    const gitDir = path.join(`${BASE}/repos`, `assignment-02-${record.githubUsername}`);
    byUser.set(record.githubUsername, { record: { ...record, plan }, code: git.showFile(gitDir, record.commitHash, 'functions.cpp'), header: git.showFile(gitDir, record.commitHash, 'functions.h') });
  }
  return byUser;
}

/** Run one scripted path; returns { id, label, rows, mismatches, finalLabel, caseSeen }. */
async function runPath({ student, fn, path: scripted, inputs, memory, service, a2, runBatch, converseFn }) {
  memory.reset();
  const NOW = Date.parse('2026-02-01T10:00:00Z');
  const importedStore = require(path.join(SHARED, 'a2', 'imported-store'));
  importedStore.__current = inputs;
  const started = await service.startPracticeInterview({ userId: 'admin-1', importId: inputs.record.importId, milestoneId: MILESTONE.milestoneId, now: NOW, invokePrepare: async () => {} });
  const prepared = await service.prepareInterview({ interviewId: started.interviewId, runBatch, countRun: async () => {}, now: NOW });
  const stored = memory.store.get(started.interviewId);
  const asked = stored.meta.a2Plan.questions.filter((q) => q.kind !== 'unaskable');
  const index = asked.findIndex((q) => q.function === fn.function && (fn.replaces ? q.replaces === fn.replaces : true));
  if (index < 0) throw new Error(`no question for ${fn.function}`);
  const firstText = a2.positionAt(stored.meta, index);
  stored.turns[0].text = firstText;

  const rows = [];
  const mismatches = [];
  let at = NOW;
  let currentText = firstText;
  let ended = false;
  const steps = scripted.steps;
  for (let i = 0; i < steps.length && !ended; i += 1) {
    const st = steps[i];
    let typed = st.answer;
    let intentNote = '';
    if (st.intent) {
      // a smaller code step: the question was built from what the agent picked, so the value is filled in now, from the question really asked
      const open = memory.store.get(started.interviewId).meta.a2Log[index].path.slice(-1)[0];
      if (!open || open.type !== 'smallStep' || open.studentAnswer !== null || open.skipped) { mismatches.push(`step ${i + 1}: expected a smaller code step to answer (intent ${st.intent}), but none is open`); break; }
      if (st.expectValue && typedValue(open.expected) !== st.expectValue) mismatches.push(`step ${i + 1}: the smaller step asked about ${open.variable} (${open.expression}) at stop ${open.stop} whose true value is ${open.expected}, not "${st.expectValue}"`);
      typed = st.intent === 'named-wrong' ? `${open.expression} is ${typedValue(open.expected)}x` : fillIntent(st.intent, open);
      intentNote = ` [intent ${st.intent}: ${open.variable} (${open.expression}) at stop ${open.stop}, true value ${open.expected}]`;
    }
    const row = { n: i + 1, asked: currentText, typed: `${typed}${intentNote}`, expected: WORD[st.expected] || st.expected, expectedCase: st.case || null };
    if (currentText.trim() !== String(st.asks).trim() && !String(st.asks).startsWith('(a smaller code step')) {
      mismatches.push(`step ${i + 1}: expected the engine to ask "${st.asks}" but it asked "${currentText}"`);
    }
    at += 1000;
    const result = await service.submitAnswer({ userId: 'admin-1', interviewId: started.interviewId, answer: typed, now: at, converseFn, clock: () => 0 });
    const entry = memory.store.get(started.interviewId).meta.a2Log[index];
    const answered = entry.path.filter((p) => p.studentAnswer !== null)[i];
    row.actual = answered ? answered.result : '(not recorded)';
    row.method = answered ? `${answered.method}${answered.decidedBy ? ` (${answered.decidedBy})` : ''}` : '';
    if (st.expectMethod && (!answered || answered.method !== st.expectMethod || answered.modelUsed)) mismatches.push(`step ${i + 1}: expected the answer to be decided by ${st.expectMethod} without the model, got ${answered ? `${answered.method}${answered.modelUsed ? ' with a model call' : ''}` : 'nothing recorded'}`);
    row.quote = answered && answered.quote ? answered.quote : '';
    row.actualCase = entry.case;
    if (row.actual !== row.expected) mismatches.push(`step ${i + 1} ("${String(typed).slice(0, 60)}"): expected check ${row.expected}, got ${row.actual}`);
    if (st.case && entry.case !== st.case) mismatches.push(`step ${i + 1}: expected case ${st.case}, got ${entry.case === null ? 'none yet' : entry.case}`);
    if (result.ended) { ended = true; row.next = '(interview ended)'; } else row.next = result.question;
    const nextExpected = steps[i + 1] ? steps[i + 1].asks : null;
    if (nextExpected && !String(nextExpected).startsWith('(a smaller code step') && !ended && result.question && result.question.trim() !== String(nextExpected).trim()) {
      row.nextNote = `expected: ${nextExpected}`;
    }
    if (nextExpected && String(nextExpected).startsWith('(a smaller code step')) {
      const nextStep = entry.path[entry.path.length - 1];
      if (!(nextStep && nextStep.type === 'smallStep' && nextStep.studentAnswer === null && !nextStep.skipped)) mismatches.push(`step ${i + 1}: expected a smaller code step to be asked next, got "${result.question || '(nothing)'}"`);
    }
    currentText = result.question || '';
    rows.push(row);
  }
  const entry = memory.store.get(started.interviewId).meta.a2Log[index];
  // the path is over when the function is done: the engine moved on (or ended) after the last scripted answer
  if (!entry.done) mismatches.push(`after the last scripted answer the engine was still asking (the function is not finished): "${currentText}"`);
  return { id: scripted.id, label: scripted.label, rows, mismatches, finalLabel: entry.label, caseSeen: entry.case, prepare: prepared.prepareStatus, truthMismatches: Object.entries(entry.truth || {}).filter(([, t]) => t.mismatch).map(([k]) => k), steps: entry.path };
}

const cell = (text) => String(text === undefined || text === null ? '' : text).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function render(results, meta) {
  const all = results.flatMap((r) => r.mismatches.map((m) => `${r.id}: ${m}`));
  const md = ['# A2 scripted run results', '', `Model: ${meta.model}. ${results.length} paths, ${results.filter((r) => r.mismatches.length === 0).length} match, ${results.filter((r) => r.mismatches.length > 0).length} do not. Model calls: ${meta.calls}.`, ''];
  md.push('## Mismatches', '', ...(all.length ? all.map((m) => `- ${m}`) : ['None: every scripted answer took the expected path and got the expected label.']), '');
  md.push('## Labels', '', '| path | case | final label | runtime mismatch flags |', '|---|---|---|---|', ...results.map((r) => `| ${r.id} | ${r.caseSeen === null ? '-' : r.caseSeen} | ${cell(r.finalLabel)} | ${cell(r.truthMismatches.join(', ') || 'none')} |`), '');
  md.push('## Every path', '');
  for (const r of results) {
    md.push(`### ${r.id}: ${r.label}${r.mismatches.length ? ' (MISMATCH)' : ''}`, '', '| # | asked | typed | expected | actual | how | case | engine asks next |', '|---|---|---|---|---|---|---|---|');
    r.rows.forEach((row) => md.push(`| ${row.n} | ${cell(row.asked)} | ${cell(row.typed)} | ${row.expected}${row.expectedCase ? ` (case ${row.expectedCase})` : ''} | ${row.actual}${row.quote ? ` ("${cell(row.quote)}")` : ''} | ${row.method} | ${row.actualCase === null ? '' : row.actualCase} | ${cell(row.next)}${row.nextNote ? ` (${cell(row.nextNote)})` : ''} |`));
    md.push('', `Final label: **${r.finalLabel}**`, '');
  }
  return `${md.join('\n')}\n`;
}

async function main() {
  const compiler = findCompiler();
  if (!compiler) throw new Error('no g++ found: set GXX');
  const scripted = JSON.parse(fs.readFileSync(`${BASE}/scripted/scripted-answers.json`, 'utf8'));
  const byUser = loadInputs();
  const memory = makeMemoryInterviews();
  inject('db/interviews.js', memory);
  inject('db/milestones.js', { getMilestone: async () => MILESTONE });
  inject('utils/logger.js', { info() {}, warn() {}, error() {}, debug() {} });
  const store = { __current: null };
  inject('a2/imported-store.js', { getRecord: async () => store.__current.record, getCode: async () => ({ code: store.__current.code, header: store.__current.header }), listRecords: async () => [] });
  const importedStore = require(path.join(SHARED, 'a2', 'imported-store'));
  Object.defineProperty(importedStore, '__current', { get: () => store.__current, set: (v) => { store.__current = v; }, enumerable: false });
  const service = require(path.join(SHARED, 'services', 'interview-service'));
  const a2 = require(path.join(SHARED, 'services', 'a2-interview'));
  const { runBatch } = makeLocalRunBatch({ gxx: compiler.gxx });

  const jobs = [];
  for (const s of scripted.students) {
    if (USER && s.student !== USER) continue;
    for (const fn of s.functions) {
      if (FUNCTION && fn.function !== FUNCTION) continue;
      for (const p of fn.paths) jobs.push({ student: s.student, fn, path: p });
    }
  }

  const run = async (converseFn) => {
    const results = [];
    for (const job of jobs) {
      const inputs = byUser.get(job.student);
      if (!inputs) { results.push({ id: job.path.id, label: job.path.label, rows: [], mismatches: [`no plan or record for ${job.student}`], finalLabel: '-', caseSeen: null, truthMismatches: [] }); continue; }
      results.push(await runPath({ ...job, inputs, memory, service, a2, runBatch, converseFn }));
    }
    return results;
  };

  // the fake writer follows the real writer's rule: the first variable, at the first stop whose value is not the same as at stop 1
  const writeAtChange = ({ message }) => {
    const first = /^- (.*?): (.*)$/m.exec(message);
    const stops = [...message.matchAll(/^Stop (\d+): (.*)$/gm)].map((m) => ({ n: Number(m[1]), text: m[2] }));
    const changed = stops.find((st) => st.text !== (stops[0] || {}).text);
    return { variable: first[1], stop: changed ? changed.n : 1 };
  };
  const fake = fakeModel({ write: writeAtChange });
  const dry = await run(fake);
  const calls = fake.kinds;
  const total = calls.check + calls.judge + calls.write;
  if (REAL) {
    console.log(`The scripted run needs about ${total} model calls (checker ${calls.check}, judge of case 2 ${calls.judge}, writer of the smaller step ${calls.write}), plus a retry now and then. They go to Bedrock with your AWS credentials.`);
    if (!flag('--yes')) { console.log('Not run. Add --yes to run them.'); return; }
  }
  let results = dry;
  let meta = { model: 'fake (deterministic stand-in)', calls: `${total} (fake)` };
  if (REAL) {
    const bedrock = require(path.join(SHARED, 'agent', 'bedrock-client'));
    let n = 0;
    const counting = async (request) => { n += 1; return bedrock.converse(request); };
    results = await run(counting);
    meta = { model: 'real (Bedrock)', calls: n };
  }
  const out = `${BASE}/scripted/results.md`;
  fs.writeFileSync(out, render(results, meta));
  const bad = results.filter((r) => r.mismatches.length > 0);
  console.log(`${results.length} paths: ${results.length - bad.length} match, ${bad.length} do not. Written to ${out}`);
  bad.slice(0, 40).forEach((r) => r.mismatches.forEach((m) => console.log(`  ${r.id}: ${m}`)));
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
