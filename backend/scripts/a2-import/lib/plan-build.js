// Building one student's interview plan: which question for each function (plan-rules), the input, K, breakpoint line and traced variables
// (lines.js), the answers from the student's own code (run in Docker), the flags, and the fixed follow-up. Overrides from a
// file outside the repo (keyed by GitHub username) can set pauseLine, variables or k per function.
const harness = require('../../../shared/nodejs/services/harness-builder');
const { selectInput, unusable, chooseK, alignStops } = require('../../eval/a2/selection');
const { suggestLine } = require('./lines');
const { decideSlots, renderQuestion, ordinal } = require('./plan-rules');
const { programFactory } = require('./program');

const MAX_TRACE_INPUTS = 3;

/**
 * @param {object} args
 * @param {object} args.record     the import record
 * @param {string} args.code       the student's functions.cpp (as stored)
 * @param {string|null} args.studentHeader
 * @param {'A'|'B'} args.form
 * @param {{ officialHeader: string, driver: string, questions: object }} args.assets
 * @param {{ inputs: object }} args.reference   result of computeReference (spec answers and reference stops per input)
 * @param {{ runPlain: Function }} args.docker
 * @param {object} [args.overrides]  this student's overrides: { [function]: { pauseLine, variables, k } }
 */
async function buildPlan({ record, code, studentHeader, form, assets, reference, docker, overrides = {} }) {
  const { questions, driver, officialHeader } = assets;
  const decided = decideSlots({ form, record, formTypes: questions.forms[form] });
  const plan = { version: 1, importId: record.importId, githubUsername: record.githubUsername, form, status: record.status, notes: [...decided.notes], log: [], questions: [], referenceAnswers: {} };
  if (decided.noPlan) { plan.noPlan = decided.noPlan; return plan; }
  const lines = String(code).split('\n');
  const lineText = (n) => (n && lines[n - 1] !== undefined ? lines[n - 1].trim() : null);
  const factory = programFactory({ record, code, studentHeader, officialHeader });
  const log = (text) => plan.log.push(text);

  // inputs of a function: from the reference's answers; the student's own results come from the import record
  const refInputs = (fn) => Object.entries(reference.inputs).filter(([, v]) => v.function === fn).map(([cmd, v]) => ({ cmd, ...v }));
  const recorded = (fn) => (record.inputs || []).filter((i) => i.function === fn);
  const runsOf = (fn) => new Map(recorded(fn).map((i) => [i.cmd, { status: i.excludeFromQuestions ? (i.excludeReason || 'excluded') : 'accepted', stdout: i.output || '' }]));
  const outputOf = (fn, cmd) => { const r = recorded(fn).find((i) => i.cmd === cmd); return r && r.output !== null && r.output !== undefined ? r.output : null; };
  const remember = (input) => { plan.referenceAnswers[input.cmd] = { function: input.function, display: input.display, spec: input.spec, refStops: input.refStops }; };

  function chooseInput(fn) {
    const all = refInputs(fn);
    return selectInput({ fn, standardInputs: all.filter((i) => i.group === 'standard'), targetInputs: all.filter((i) => i.group === 'target'), runs: runsOf(fn) });
  }

  /** The tracing question of a function: line, variables, input and K from the student's own trace. Returns { ok: false, reason } to change the type. */
  async function traceFor(fn, sel) {
    const prog = factory(fn);
    if (prog.error) return { ok: false, reason: prog.error };
    const ov = overrides[fn] || {};
    let line = ov.pauseLine;
    let variables = ov.variables;
    if (!line || !variables) {
      const s = suggestLine(code, fn);
      if (s.status !== 'confident') {
        if (!line) return { ok: false, reason: `needs manual: ${s.reason}` };
        return { ok: false, reason: `the override sets line ${line} but no variables, and the line suggester cannot suggest any (${s.reason})` };
      }
      line = line || s.line;
      variables = variables || s.variables;
    }
    const others = refInputs(fn).filter((i) => i.group === 'standard' && i.cmd !== sel.input.cmd && !unusable(fn, i) && runsOf(fn).get(i.cmd) && runsOf(fn).get(i.cmd).status === 'accepted');
    const candidates = [{ input: sel.input, targeted: sel.targeted, bug: sel.bug || null, reason: sel.reason }, ...others.map((input) => ({ input, targeted: false, bug: null, reason: 'standard input: the breakpoint line is not reached on the first input' }))].slice(0, MAX_TRACE_INPUTS);
    let lastReason = 'the breakpoint line is never reached on the chosen input';
    for (const cand of candidates) {
      const plainOutput = outputOf(fn, cand.input.cmd);
      const built = harness.buildTraceProgram({ header: prog.header, studentSource: prog.studentSource, driver, pauseLine: line, variables });
      if (!built.ok) return { ok: false, reason: `the breakpoint line was refused: ${built.reason}` };
      const res = await docker.runPlain({ source: built.source, cmds: [cand.input.cmd] });
      if (!res.compile.ok) return { ok: false, reason: 'the trace copy did not compile (system error)' };
      const run = res.runs[0] || {};
      if (run.code !== 0) return { ok: false, reason: `the trace copy did not run to the end on ${cand.input.cmd} (system error)` };
      if (plainOutput !== null && run.stdout.trim() !== plainOutput) return { ok: false, reason: 'instrumentation changed behavior (system error)' };
      const stops = harness.parseAllStops(run.stderr, built.marker).map((s) => s.text);
      if (stops.length === 0) { lastReason = `the breakpoint line (${line}) is never reached on ${cand.input.cmd}`; continue; }
      let k = ov.k;
      if (k && k > stops.length) return { ok: false, reason: `the override K=${k} but the trace only stops ${stops.length} times` };
      if (!k) k = chooseK({ stops, refStops: cand.input.refStops, preferredK: questions.functions[fn].tracing.preferredK, targeted: cand.targeted });
      return { ok: true, input: cand.input, targeted: cand.targeted, bug: cand.bug, selectionReason: cand.reason, line, variables, k, stops, answer: stops[k - 1], differs: !alignStops(stops, cand.input.refStops || []).contiguous, overridden: Boolean(ov.pauseLine || ov.variables || ov.k), plainOutput };
    }
    return { ok: false, reason: lastReason };
  }

  const out = [];
  for (const slot of decided.slots) {
    const fn = slot.function;
    const base = { slot: slot.slot, function: fn, formType: slot.type, ...(slot.replaces ? { replaces: slot.replaces } : {}) };
    if (slot.kind === 'unaskable') { out.push({ ...base, kind: 'unaskable', reason: slot.reason }); log(slot.reason); continue; }

    if (slot.kind === 'compileError' || slot.kind === 'compileErrorOutside') {
      const outside = slot.kind === 'compileErrorOutside';
      out.push({
        ...base,
        kind: slot.kind,
        ...(outside ? { replacedFunction: slot.replacedFunction } : {}),
        text: renderQuestion(questions, slot.kind, { function: fn, line: slot.line }),
        line: slot.line,
        lineText: lineText(slot.line),
        answerKey: slot.message,
      });
      continue;
    }

    const logicInput = () => refInputs(fn).find((i) => i.group === 'standard' && !unusable(fn, i));
    if (slot.kind === 'logic') {
      const input = logicInput();
      remember(input);
      out.push({ ...base, kind: 'logic', reason: slot.reason, text: renderQuestion(questions, 'logic', { function: fn, display: input.display }), input: { cmd: input.cmd, display: input.display }, answerKey: input.spec });
      continue;
    }

    // predict or tracing: a function that compiles
    const sel = chooseInput(fn);
    if (!sel.input) {
      const input = logicInput();
      remember(input);
      log(`${fn}: no input runs cleanly (${sel.reason}): a logic question instead`);
      out.push({ ...base, kind: 'logic', reason: `no input runs cleanly: ${sel.reason}`, text: renderQuestion(questions, 'logic', { function: fn, display: input.display }), input: { cmd: input.cmd, display: input.display }, answerKey: input.spec });
      continue;
    }
    let kind = slot.kind;
    let typeChanged = null;
    let trace = null;
    if (kind === 'tracing') {
      trace = await traceFor(fn, sel);
      if (!trace.ok) {
        typeChanged = { from: 'tracing', to: 'predict', reason: trace.reason };
        log(`${fn}: tracing changed to predict: ${trace.reason}`);
        kind = 'predict';
      }
    }
    const input = trace && trace.ok ? trace.input : sel.input;
    const targeted = trace && trace.ok ? trace.targeted : sel.targeted;
    const bug = trace && trace.ok ? trace.bug : (sel.bug || null);
    const selectionReason = trace && trace.ok ? trace.selectionReason : sel.reason;
    const plainOutput = outputOf(fn, input.cmd);
    remember(input);
    const question = { ...base, kind, ...(typeChanged ? { typeChanged } : {}), input: { cmd: input.cmd, display: input.display }, targeted, ...(bug ? { bug } : {}), selectionReason, spec: kind === 'predict' ? input.spec : undefined, specForReference: input.spec };
    if (kind === 'tracing') {
      Object.assign(question, {
        text: renderQuestion(questions, 'tracing', { function: fn, line: trace.line, display: input.display, k: trace.k }),
        line: trace.line, lineText: lineText(trace.line), variables: trace.variables.map((v) => ({ name: v.name || v.expr, expr: v.expr })), k: trace.k, kth: ordinal(trace.k), totalStops: trace.stops.length,
        answer: trace.answer, traceDiffersFromReference: trace.differs, ...(trace.overridden ? { overridden: true } : {}),
      });
    } else {
      Object.assign(question, { text: renderQuestion(questions, 'predict', { function: fn, display: input.display }), answer: plainOutput, correct: plainOutput === input.spec });
    }
    // the fixed follow-up: the same question and answer key for every student, asked only after a correct main answer (engine rule: M4b)
    question.fixedFollowUp = questions.fixedFollowUps[fn];
    out.push(question);
  }
  out.forEach((q, i) => { q.index = i + 1; });
  plan.questions = out;
  return plan;
}

module.exports = { buildPlan };
