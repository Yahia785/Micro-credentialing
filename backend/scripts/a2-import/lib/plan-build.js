// Building one student's interview plan, version 3 (the case design). Per function the plan holds:
//   - the MAIN question (logic, the same for every student) with its key
//   - codeRight: the student's code gives the spec answer on every safe candidate input of the import record
//   - every case branch, prepared and ready to be shown:
//       case 1 (logic right, code right): follow-up 1 = predict or tracing on their code (rotated), follow-up 2 = a sanitizer-safe what-if,
//                                         otherwise the other type
//       case 2 (logic right, code wrong): follow-up 1 = debug (their output and the spec answer), follow-up 2 = "which line would you change"
//       case 3 (logic wrong, code right): follow-up 1 = what their code gives on the main input, follow-up 2 = a smaller code step (private material)
//       case 4 (logic wrong, code wrong): follow-up 1 = the smaller logic question, follow-up 2 = a smaller code step (private material)
//   - the unclear-answer line
// Everything about their code is worked out here, by running it in Docker (the sanitizer results come from the import record). Overrides
// from a file outside the repo (keyed by GitHub username) can set pauseLine, variables or k per function.
const harness = require('../../../shared/nodejs/services/harness-builder');
const { selectInput, unusable, chooseK, alignStops } = require('../../eval/a2/selection');
const { suggestLine } = require('./lines');
const { decideSlots, renderQuestion } = require('./plan-rules');
const { programFactory } = require('./program');
const { findWhatIf } = require('./what-if');

const MAX_TRACE_INPUTS = 3;
const MAX_WHATIF_INPUTS = 4;

/**
 * @param {object} args
 * @param {object} args.record     the import record
 * @param {string} args.code       the student's functions.cpp (as stored)
 * @param {string|null} args.studentHeader
 * @param {'A'|'B'} args.form      the rotation of follow-up 1 in case 1
 * @param {{ officialHeader: string, driver: string, questions: object }} args.assets
 * @param {{ inputs: object }} args.reference   result of computeReference (spec answers and reference stops per input)
 * @param {{ runPlain: Function, runInputs: Function }} args.docker
 * @param {object} [args.overrides]  this student's overrides: { [function]: { pauseLine, variables, k } }
 */
async function buildPlan({ record, code, studentHeader, form, assets, reference, docker, overrides = {} }) {
  const { questions, driver, officialHeader } = assets;
  const decided = decideSlots({ record, rotation: questions.rotation[form] });
  const plan = { version: 3, importId: record.importId, githubUsername: record.githubUsername, form, status: record.status, notes: [...decided.notes], log: [], questions: [], referenceAnswers: {}, ...(questions.valueHint ? { valueHint: questions.valueHint } : {}) };
  if (decided.noPlan) { plan.noPlan = decided.noPlan; return plan; }
  const lines = String(code).split('\n');
  const lineText = (n) => (n && lines[n - 1] !== undefined ? lines[n - 1].trim() : null);
  const factory = programFactory({ record, code, studentHeader, officialHeader });
  const log = (text) => plan.log.push(text);

  // ---- the inputs and what the import found out about them -------------------------------------------------------------------------
  const refInputs = (fn) => Object.entries(reference.inputs).filter(([, v]) => v.function === fn).map(([cmd, v]) => ({ cmd, ...v }));
  const entryOf = (fn, cmd) => (record.inputs || []).find((i) => i.function === fn && i.cmd === cmd) || null;
  const outputOf = (fn, cmd) => { const e = entryOf(fn, cmd); return e && e.output !== null && e.output !== undefined ? String(e.output).trim() : null; };
  /** Safe = the import ran it under the sanitizers and the plain build without a problem, and the spec defines it. */
  const safe = (fn, input) => { const e = entryOf(fn, input.cmd); return Boolean(e) && !e.excludeFromQuestions && !e.unclearSpec && !unusable(fn, input) && outputOf(fn, input.cmd) !== null; };
  const remember = (input) => { plan.referenceAnswers[input.cmd] = { function: input.function, display: input.display, spec: input.spec, refStops: input.refStops }; };

  /** codeRight: the spec answer on every safe candidate input. null when no input is safe. */
  function codeRightOf(fn) {
    const inputs = refInputs(fn).filter((i) => safe(fn, i));
    if (inputs.length === 0) return { value: null, checked: 0, failing: [] };
    const failing = inputs.filter((i) => !entryOf(fn, i.cmd).matchesSpec).map((i) => i.cmd);
    return { value: failing.length === 0, checked: inputs.length, failing };
  }
  /** The inputs a follow-up may use: standard and edge (target) inputs that are safe. Never the main or the smaller logic input. */
  const poolOf = (fn) => refInputs(fn).filter((i) => (i.group === 'standard' || i.group === 'target') && safe(fn, i));

  // ---- tracing ---------------------------------------------------------------------------------------------------------------------
  const lineCache = new Map();
  /** The breakpoint line and the traced variables of a function: the override, else the suggestion when it is confident. */
  function lineFor(fn) {
    if (lineCache.has(fn)) return lineCache.get(fn);
    const ov = overrides[fn] || {};
    let result;
    if (ov.pauseLine && ov.variables) result = { ok: true, line: ov.pauseLine, variables: ov.variables, overridden: true };
    else {
      const s = suggestLine(code, fn);
      if (s.status !== 'confident') result = { ok: false, reason: ov.pauseLine ? `the override sets line ${ov.pauseLine} but no variables, and the line suggester cannot suggest any (${s.reason})` : `needs manual: ${s.reason}` };
      else result = { ok: true, line: ov.pauseLine || s.line, variables: ov.variables || s.variables, overridden: Boolean(ov.pauseLine || ov.variables) };
    }
    lineCache.set(fn, result);
    return result;
  }

  /** Run the trace copy on several inputs: Map cmd -> { ok, stops } or { ok: false, reason }. */
  async function traceMany(fn, cmds, line, variables) {
    const out = new Map();
    const prog = factory(fn);
    if (prog.error) { cmds.forEach((c) => out.set(c, { ok: false, reason: prog.error })); return out; }
    const built = harness.buildTraceProgram({ header: prog.header, studentSource: prog.studentSource, driver, pauseLine: line, variables });
    if (!built.ok) { cmds.forEach((c) => out.set(c, { ok: false, reason: `the breakpoint line was refused: ${built.reason}` })); return out; }
    const res = await docker.runPlain({ source: built.source, cmds });
    if (!res.compile.ok) { cmds.forEach((c) => out.set(c, { ok: false, reason: 'the trace copy did not compile (system error)' })); return out; }
    cmds.forEach((cmd, i) => {
      const run = res.runs[i] || {};
      if (run.code !== 0) { out.set(cmd, { ok: false, reason: `the trace copy did not run to the end on ${cmd} (system error)` }); return; }
      const plainOutput = outputOf(fn, cmd);
      if (plainOutput !== null && run.stdout.trim() !== plainOutput) { out.set(cmd, { ok: false, reason: 'instrumentation changed behavior (system error)' }); return; }
      out.set(cmd, { ok: true, stops: harness.parseAllStops(run.stderr, built.marker).map((s) => s.text) });
    });
    return out;
  }

  /** The tracing follow-up on the first input of `candidates` (at most MAX_TRACE_INPUTS tried) where the breakpoint line is reached. */
  async function buildTracing(fn, candidates) {
    const lv = lineFor(fn);
    if (!lv.ok) return { ok: false, reason: lv.reason };
    const ov = overrides[fn] || {};
    const list = candidates.slice(0, MAX_TRACE_INPUTS);
    if (list.length === 0) return { ok: false, reason: 'no safe standard or edge input to ask it on' };
    const traces = await traceMany(fn, list.map((i) => i.cmd), lv.line, lv.variables);
    let lastReason = `the breakpoint line (${lv.line}) is never reached on the inputs tried`;
    for (const input of list) {
      const t = traces.get(input.cmd);
      if (!t.ok) { lastReason = t.reason; continue; }
      if (t.stops.length === 0) { lastReason = `the breakpoint line (${lv.line}) is never reached on ${input.cmd}`; continue; }
      let k = ov.k;
      if (k && k > t.stops.length) { lastReason = `the override K=${k} but the trace only stops ${t.stops.length} times`; continue; }
      if (!k) k = chooseK({ stops: t.stops, refStops: input.refStops, preferredK: questions.functions[fn].tracing.preferredK, targeted: false });
      remember(input);
      return {
        ok: true,
        type: 'tracing',
        input: { cmd: input.cmd, display: input.display },
        text: renderQuestion(questions, 'tracing', { function: fn, line: lv.line, display: input.display, k }),
        line: lv.line, lineText: lineText(lv.line), variables: lv.variables.map((v) => ({ name: v.name || v.expr, expr: v.expr })), k, totalStops: t.stops.length,
        answer: t.stops[k - 1], answerType: 'code', traceDiffersFromReference: !alignStops(t.stops, input.refStops || []).contiguous, ...(lv.overridden ? { overridden: true } : {}),
      };
    }
    return { ok: false, reason: lastReason };
  }

  function buildPredict(fn, candidates) {
    const input = candidates[0];
    if (!input) return { ok: false, reason: 'no safe standard or edge input to ask it on' };
    remember(input);
    return { ok: true, type: 'predict', input: { cmd: input.cmd, display: input.display }, text: renderQuestion(questions, 'predict', { function: fn, display: input.display }), answer: outputOf(fn, input.cmd), answerType: 'code', specAnswer: input.spec };
  }

  /** Move `input` (when it is in the list) to the back: follow-up 2 prefers another input than follow-up 1. */
  const preferOther = (list, input) => (input ? [...list.filter((i) => i.cmd !== input.cmd), ...list.filter((i) => i.cmd === input.cmd)] : list);

  // ---- the smaller code step (cases 3 and 4): private material for the agent --------------------------------------------------------
  /** The real variable names of their function and their values at the breakpoint line on the main input, stop by stop. Never shown to the student. */
  async function smallStepMaterial(fn) {
    const main = questions.functions[fn].main.input;
    const mainRef = refInputs(fn).find((i) => i.cmd === main.cmd);
    const base = { private: true, forAgentOnly: 'The student never sees this. It is the material for ONE smaller code step in the interview (M5b).' };
    if (!mainRef || !safe(fn, mainRef)) return { ...base, available: false, reason: 'the main input did not run cleanly under the sanitizers (or the spec does not define it): there is nothing safe to trace' };
    const lv = lineFor(fn);
    if (!lv.ok) return { ...base, available: false, reason: lv.reason };
    const trace = (await traceMany(fn, [main.cmd], lv.line, lv.variables)).get(main.cmd);
    if (!trace.ok) return { ...base, available: false, reason: trace.reason };
    if (trace.stops.length === 0) return { ...base, available: false, reason: `the breakpoint line (${lv.line}) is never reached on the main input` };
    return { ...base, available: true, input: { cmd: main.cmd, display: main.display }, line: lv.line, lineText: lineText(lv.line), variables: lv.variables.map((v) => ({ name: v.name || v.expr, expr: v.expr })), stops: trace.stops, ...(lv.overridden ? { overridden: true } : {}) };
  }

  // ---- one function ----------------------------------------------------------------------------------------------------------------
  async function buildCases(fn, slot, right) {
    const f = questions.functions[fn];
    const pool = poolOf(fn);
    const mainRef = refInputs(fn).find((i) => i.cmd === f.main.input.cmd);
    if (mainRef) remember(mainRef);
    const material = await smallStepMaterial(fn);
    const cases = {};

    // case 1: logic right, code right
    if (right.value === true) {
      let type1 = slot.type;
      let first = null;
      let typeChanged = null;
      if (type1 === 'tracing') {
        first = await buildTracing(fn, pool);
        if (!first.ok) { typeChanged = { from: 'tracing', to: 'predict', reason: first.reason }; log(`${fn}: follow-up 1 changed from tracing to predict: ${first.reason}`); type1 = 'predict'; }
      }
      if (type1 === 'predict') first = buildPredict(fn, pool);
      const c1 = { available: true, followUp1: first.ok ? { ...first, ...(typeChanged ? { typeChanged } : {}) } : { type: type1, unavailable: first.reason } };
      // follow-up 2: a what-if when one passes every rule, otherwise the other type
      const firstInput = first.ok ? pool.find((i) => i.cmd === first.input.cmd) : null;
      const whatIfInputs = preferOther([...pool], null).slice(0, MAX_WHATIF_INPUTS);
      if (firstInput) whatIfInputs.sort((a, b) => (a.cmd === firstInput.cmd ? -1 : b.cmd === firstInput.cmd ? 1 : 0));
      const prog = factory(fn);
      const wi = prog.error ? { ok: false, reason: prog.error, tried: 0 } : await findWhatIf({
        docker, parts: prog, driver, code, fn,
        inputs: whatIfInputs.map((i) => ({ cmd: i.cmd, display: i.display, spec: i.spec, output: outputOf(fn, i.cmd) })),
      });
      if (wi.ok) {
        const shown = pool.find((i) => i.cmd === wi.input.cmd);
        remember(shown);
        c1.followUp2 = {
          ok: true, type: 'whatIf', input: { cmd: shown.cmd, display: shown.display },
          line: wi.edit.line, oldLine: wi.edit.oldLine, newLine: wi.edit.newLine, find: wi.edit.find, replace: wi.edit.replace,
          text: renderQuestion(questions, 'whatIf', { function: fn, line: wi.edit.line, oldLine: wi.edit.oldLine, newLine: wi.edit.newLine, display: shown.display }),
          answer: wi.output, answerType: 'code', theirOutputBeforeTheChange: outputOf(fn, shown.cmd),
        };
      } else {
        const other = type1 === 'predict' ? 'tracing' : 'predict';
        const second = other === 'tracing' ? await buildTracing(fn, preferOther(pool, firstInput)) : buildPredict(fn, preferOther(pool, firstInput));
        c1.followUp2 = second.ok ? { ...second, whatIfSkipped: wi.reason } : { type: other, unavailable: second.reason, whatIfSkipped: wi.reason };
        log(`${fn}: no what-if (${wi.reason}); follow-up 2 is ${second.ok ? other : `unavailable (${second.reason})`}`);
      }
      cases.case1 = c1;
    } else cases.case1 = { available: false, reason: right.value === false ? 'their code is wrong for this function (cases 2 and 4 apply)' : 'no safe input was run: nothing is known about their code' };

    // case 2: logic right, code wrong. The targeting rules of selection.js first (a target input where the output differs), then any safe input that differs.
    if (right.value !== true) {
      const all = refInputs(fn).filter((i) => safe(fn, i));
      const runs = new Map(all.map((i) => [i.cmd, { status: 'accepted', stdout: outputOf(fn, i.cmd) }]));
      const sel = selectInput({ fn, standardInputs: all.filter((i) => i.group === 'standard'), targetInputs: all.filter((i) => i.group === 'target'), runs });
      const differs = (i) => outputOf(fn, i.cmd) !== String(i.spec).trim();
      const input = sel.targeted ? sel.input : [...all.filter((i) => i.group === 'standard'), ...all.filter((i) => i.group === 'main'), ...all.filter((i) => i.group === 'small')].find(differs);
      if (input) {
        remember(input);
        const output = outputOf(fn, input.cmd);
        cases.case2 = {
          available: true,
          followUp1: { type: 'debug', input: { cmd: input.cmd, display: input.display }, theirOutput: output, specAnswer: input.spec, answerType: 'code', text: renderQuestion(questions, 'debug', { function: fn, output, display: input.display, spec: input.spec }), targeted: Boolean(sel.targeted), ...(sel.bug ? { bug: sel.bug } : {}) },
          followUp2: { type: 'change', text: renderQuestion(questions, 'change', {}), answerType: 'code' },
        };
      } else cases.case2 = { available: false, reason: 'their code is wrong, but no safe input shows it (every input where it differs crashes or triggers a sanitizer)' };
    } else cases.case2 = { available: false, reason: 'their code is right for this function (cases 1 and 3 apply)' };

    // case 3: logic wrong, code right
    if (right.value === true) {
      const mainEntry = mainRef ? entryOf(fn, mainRef.cmd) : null;
      let answer = null;
      let basis = null;
      let reason = null;
      if (fn === 'reverseList') {
        // "How many swaps": the number of times their swap line runs on the main input
        if (material.available) { answer = String(material.stops.length); basis = `their swap line (${material.line}) runs ${material.stops.length} times on the main input`; } else reason = `their swaps could not be counted: ${material.reason}`;
      } else if (mainRef && safe(fn, mainRef)) { answer = outputOf(fn, mainRef.cmd); basis = 'their output on the main input'; } else reason = `the main input did not run cleanly${mainEntry && mainEntry.excludeReason ? ` (${mainEntry.excludeReason})` : ''}`;
      cases.case3 = {
        available: true,
        followUp1: answer === null ? { type: 'predict', unavailable: reason } : { type: 'predict', input: { cmd: f.main.input.cmd, display: f.main.input.display }, text: renderQuestion(questions, 'case3', { function: fn }), answer, answerBasis: basis, answerType: 'code' },
        followUp2: { type: 'smallStep', agentWritten: true, material },
      };
    } else cases.case3 = { available: false, reason: 'their code is wrong for this function (cases 2 and 4 apply)' };

    // case 4: logic wrong, code wrong
    if (right.value !== true) {
      cases.case4 = {
        available: true,
        followUp1: { type: 'smallLogic', input: { cmd: f.small.input.cmd, display: f.small.input.display }, text: renderQuestion(questions, 'small', { function: fn }), answerKey: f.small.key, answerType: 'logic' },
        followUp2: { type: 'smallStep', agentWritten: true, material },
      };
    } else cases.case4 = { available: false, reason: 'their code is right for this function (cases 1 and 3 apply)' };
    return cases;
  }

  const out = [];
  for (const slot of decided.slots) {
    const fn = slot.function;
    const base = { slot: slot.slot, function: fn, formType: slot.type, ...(slot.replaces ? { replaces: slot.replaces } : {}) };
    if (slot.kind === 'unaskable') { out.push({ ...base, kind: 'unaskable', reason: slot.reason }); log(slot.reason); continue; }
    if (slot.kind === 'compileError' || slot.kind === 'compileErrorOutside') {
      const outside = slot.kind === 'compileErrorOutside';
      out.push({
        ...base, kind: slot.kind, ...(outside ? { replacedFunction: slot.replacedFunction } : {}),
        text: renderQuestion(questions, slot.kind, { function: fn, line: slot.line }), line: slot.line, lineText: lineText(slot.line), answerKey: slot.message, answerType: 'compile', cases: null, followUps: false,
        note: 'no follow-ups for a compile-error question',
      });
      continue;
    }
    const f = questions.functions[fn];
    const right = slot.followUps ? codeRightOf(fn) : { value: null, checked: 0, failing: [] };
    const q = {
      ...base, kind: 'logic', text: renderQuestion(questions, 'main', { function: fn }), answerKey: f.main.key, answerType: 'logic',
      mainInput: { cmd: f.main.input.cmd, display: f.main.input.display }, clarify: questions.clarify,
      codeRight: right.value, codeRightChecked: right.checked, codeRightFailing: right.failing, followUps: slot.followUps,
    };
    if (slot.reason) q.reason = slot.reason;
    if (slot.followUps) q.cases = await buildCases(fn, slot, right);
    else { q.cases = null; q.note = slot.reason || 'no follow-ups: there is no code to ask about'; }
    out.push(q);
  }
  out.forEach((q, i) => { q.index = i + 1; });
  plan.questions = out;
  return plan;
}

module.exports = { buildPlan };
