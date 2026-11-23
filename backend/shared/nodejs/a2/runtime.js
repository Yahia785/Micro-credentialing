/**
 * Running the plan's programs once when an A2 interview is prepared, and reading what they printed. The runtime result is the truth the
 * student's CODE answers are checked against; the plan's own answer (computed when the plan was built) is only compared with it. When the two
 * differ the item gets a mismatch flag and the interview goes on with the runtime result. When nothing could be run the plan's answer is used
 * and the flag says so.
 *
 * Only what can be asked is run: for a student whose code is right (cases 1 and 3) the follow-ups of those two cases, for a student whose code
 * is wrong or unknown (cases 2 and 4) the debug input. An item is one of:
 *   case1.followUp1, case1.followUp2   predict (plain run), tracing (plain and trace run) or what-if (the changed copy)
 *   case2.followUp1                    the debug input, plain run: their output
 *   case3.followUp1                    their answer on the main input (plain run; for reverseList the swap count of the material)
 *   material                           the trace of their function on the main input, every stop (the smaller code steps of cases 3 and 4)
 * Each function is built from its own parts (the same rules as the plan), so the program that runs is the one the plan was built from.
 */
const fs = require('fs');
const path = require('path');
const { programFactory } = require('./program');
const { runAllQuestions } = require('../services/interview-runs');
const { askable } = require('./plan-config');

const ASSETS = path.join(__dirname, 'assets');
let assetsCache;
/** The assignment's official header and the test driver, shipped with the code (assets/ is checked against scripts/eval/a2 by a test). */
function loadAssets() {
  if (!assetsCache) {
    assetsCache = {
      officialHeader: fs.readFileSync(path.join(ASSETS, 'functions.h'), 'utf8'),
      driver: fs.readFileSync(path.join(ASSETS, 'main.cpp'), 'utf8'),
    };
  }
  return assetsCache;
}

const trimmed = (text) => String(text === null || text === undefined ? '' : text).replace(/\r\n/g, '\n').trim();

/** The items of one question that can be asked, as [{ id, f, mode }]; mode: plain | tracing | whatIf | swaps | material. */
function itemsOf(q) {
  if (q.kind !== 'logic' || !q.cases) return [];
  const items = [];
  const reachable = q.codeRight === true ? ['case1', 'case3'] : ['case2', 'case4'];
  for (const name of reachable) {
    const c = q.cases[name];
    if (!c || !c.available) continue;
    for (const key of ['followUp1', 'followUp2']) {
      const f = c[key];
      if (!f || f.unavailable) continue;
      const id = `${name}.${key}`;
      if (f.type === 'smallStep') { if (f.material && f.material.available && !items.some((i) => i.id === 'material')) items.push({ id: 'material', f: f.material, mode: 'material' }); continue; }
      if (f.type === 'predict') items.push({ id, f, mode: name === 'case3' && q.function === 'reverseList' ? 'swaps' : 'plain' });
      else if (f.type === 'debug') items.push({ id, f, mode: 'plain' });
      else if (f.type === 'tracing') items.push({ id, f, mode: 'tracing' });
      else if (f.type === 'whatIf') items.push({ id, f, mode: 'whatIf' });
    }
  }
  return items;
}

/**
 * One list of runs per asked question (what runAllQuestions takes), the items each list serves, and per question why nothing is run when the
 * function cannot be built.
 */
function buildRunQuestions({ plan, record, code, studentHeader, assets = loadAssets() }) {
  const factory = programFactory({ record, code, studentHeader, officialHeader: assets.officialHeader });
  const questions = [];
  const items = [];
  const notes = [];
  askable(plan).forEach((q) => {
    const list = itemsOf(q);
    items.push(list);
    if (list.length === 0) { questions.push([]); notes.push(null); return; }
    const parts = factory(q.function);
    if (parts.error) { questions.push([]); notes.push(parts.error); return; }
    const own = { header: parts.header, studentSource: parts.studentSource };
    const runs = [];
    for (const { id, f, mode } of list) {
      if (mode === 'plain') runs.push({ label: id, stdin: `${f.input.cmd}\n`, program: { kind: 'plain', ...own } });
      else if (mode === 'tracing') {
        runs.push({ label: `${id}:plain`, stdin: `${f.input.cmd}\n`, program: { kind: 'plain', ...own } });
        runs.push({ label: `${id}:trace`, stdin: `${f.input.cmd}\n`, program: { kind: 'trace', pauseLine: f.line, variables: f.variables.map((v) => ({ name: v.name, expr: v.expr })), ...own } });
      } else if (mode === 'whatIf') runs.push({ label: id, stdin: `${f.input.cmd}\n`, program: { kind: 'whatIf', line: f.line, find: f.find, replace: f.replace, ...own } });
      else if (mode === 'material') {
        runs.push({ label: 'material:plain', stdin: `${f.input.cmd}\n`, program: { kind: 'plain', ...own } });
        runs.push({ label: 'material:trace', stdin: `${f.input.cmd}\n`, program: { kind: 'trace', pauseLine: f.line, variables: f.variables.map((v) => ({ name: v.name, expr: v.expr })), ...own } });
      }
    }
    questions.push(runs);
    notes.push(null);
  });
  return { questions, items, notes };
}

const unavailable = (plan, why, extra = {}) => ({ source: 'plan', mismatch: { kind: 'runtime_unavailable', plan, runtime: null }, note: why, ...extra });

/** The truth of one item from the run results of its question (runAllQuestions' entry). */
function truthOfItem({ item, entry, materialTruth, buildNote }) {
  const { id, f, mode } = item;
  const runs = (entry && entry.runs) || [];
  const errorOf = (label) => ((entry && entry.errors) || []).find((e) => e.label === label);
  const run = (label) => runs.find((r) => r.label === label);
  const why = (label) => { const e = errorOf(label); return buildNote || (e ? `${e.kind} ${e.stage}: ${e.reason}` : (entry && entry.note) || 'the program could not be run'); };
  const planAnswer = f.type === 'debug' ? f.theirOutput : f.answer;
  const compare = (answer, plan) => ({ answer, source: 'runtime', mismatch: plan !== null && plan !== undefined && trimmed(plan) !== trimmed(answer) ? { kind: 'runtime_differs_from_plan', plan: trimmed(plan), runtime: trimmed(answer) } : null });

  if (mode === 'swaps') {
    if (materialTruth && materialTruth.source === 'runtime' && Array.isArray(materialTruth.stops)) return compare(String(materialTruth.stops.length), f.answer);
    return unavailable(f.answer, 'the swap line could not be traced', { answer: f.answer });
  }
  if (mode === 'plain') {
    const r = run(id);
    if (!r || r.status !== 'accepted') return unavailable(planAnswer, r ? `the program ended with status ${r.status}` : why(id), { answer: planAnswer });
    return compare(trimmed(r.stdout), planAnswer);
  }
  if (mode === 'whatIf') {
    const r = run(id);
    if (!r || r.status !== 'accepted') return unavailable(planAnswer, r ? `the changed copy ended with status ${r.status}` : why(id), { answer: planAnswer });
    return compare(trimmed(r.stdout), planAnswer);
  }
  if (mode === 'tracing') {
    const plain = run(`${id}:plain`);
    const trace = run(`${id}:trace`);
    if (!plain || plain.status !== 'accepted' || !trace || !trace.trace) return unavailable(planAnswer, why(`${id}:trace`), { answer: planAnswer });
    if (trimmed(trace.stdout) !== trimmed(plain.stdout)) return unavailable(planAnswer, 'instrumentation changed behavior', { answer: planAnswer });
    const stop = trace.trace.stops[f.k - 1];
    if (!stop) return unavailable(planAnswer, `the breakpoint stopped ${trace.trace.total} times, fewer than ${f.k}`, { answer: planAnswer });
    return compare(stop.text, planAnswer);
  }
  // material: every stop of the trace
  const plain = run('material:plain');
  const trace = run('material:trace');
  const planStops = f.stops;
  if (!plain || plain.status !== 'accepted' || !trace || !trace.trace) return unavailable(planStops, why('material:trace'), { stops: planStops });
  if (trimmed(trace.stdout) !== trimmed(plain.stdout)) return unavailable(planStops, 'instrumentation changed behavior', { stops: planStops });
  const stops = trace.trace.stops.map((s) => s.text);
  const same = JSON.stringify(stops) === JSON.stringify(planStops);
  return { stops, source: 'runtime', mismatch: same ? null : { kind: 'runtime_differs_from_plan', plan: planStops, runtime: stops } };
}

/**
 * Run the plan's programs once and work out the truth of every item that can be asked.
 * @returns {Promise<Array<{ truth: Object<string, { answer?: string, stops?: string[], source: 'runtime'|'plan', mismatch: object|null, note?: string }> }>>} one entry per asked question
 */
async function runPlan({ plan, record, code, studentHeader, userId, interviewId, limits, runBatch, countRun, deadlineAt }) {
  const { questions, items, notes } = buildRunQuestions({ plan, record, code, studentHeader });
  const assets = loadAssets();
  const observed = await runAllQuestions({
    code, questions, userId, interviewId, limits, runBatch, countRun, deadlineAt, harness: { header: assets.officialHeader, driver: assets.driver },
  });
  return items.map((list, i) => {
    const truth = {};
    const material = list.find((it) => it.mode === 'material');
    if (material) truth.material = truthOfItem({ item: material, entry: observed[i], buildNote: notes[i] });
    for (const item of list) {
      if (item.mode === 'material') continue;
      truth[item.id] = truthOfItem({ item, entry: observed[i], materialTruth: truth.material, buildNote: notes[i] });
    }
    return { truth };
  });
}

module.exports = { itemsOf, buildRunQuestions, truthOfItem, runPlan, loadAssets };
