// The rules that decide WHICH question each student gets (pure functions; no runs). The confirmed design:
//   - main types are predict and tracing; form A = reverseList predict, splitString tracing, playCraps predict;
//     form B = reverseList tracing, splitString predict, playCraps tracing
//   - mode replaces a function ONLY when that function is completely missing (no definition), and takes its type
//   - a function that exists but does not compile gets a compile-error question (answer key: the compiler message)
//   - an error outside the functions gets the compile-error question "Your code doesn't compile..." in place of one function's question
//   - when nothing compiles, the first function in the form gets a compile-error question (its own first compiler error) and the other
//     two get logic questions ("Walk me through ...", no run, answer key = the spec answer)
//   - compile-error and logic questions have no fixed follow-up; predict and tracing questions have one (asked after a correct answer, M4b)
const { PRIMARY } = require('./common');

const PLANNABLE = new Set(['ok', 'file_does_not_compile', 'nothing_compiles']);

/** Sort by importId and alternate A, B, A, B so the forms are split evenly. Returns Map importId -> 'A'|'B' (only records that can have a plan). */
function assignForms(records) {
  const forms = new Map();
  records.filter((r) => PLANNABLE.has(r.status)).sort((a, b) => (a.importId < b.importId ? -1 : a.importId > b.importId ? 1 : 0)).forEach((r, i) => forms.set(r.importId, i % 2 === 0 ? 'A' : 'B'));
  return forms;
}

/** What state one function is in: 'missing' (no definition), 'compiles' or 'compileError'. */
function functionState(record, fn) {
  const f = record.functions && record.functions[fn];
  if (!f || f.present === false) return 'missing';
  if (record.status === 'ok') return 'compiles';
  return f.compilesAlone ? 'compiles' : 'compileError';
}

/**
 * @param {{ form: 'A'|'B', record: object, formTypes: {reverseList:string, splitString:string, playCraps:string} }} args
 * @returns {{ noPlan?: string, slots: Array<{ slot: string, function: string, type: 'predict'|'tracing', kind: string, replaces?: string, replacedFunction?: string, line?: number, message?: string, reason?: string }>, notes: string[] }}
 *   kind: predict | tracing | compileError | compileErrorOutside | logic | unaskable
 */
function decideSlots({ record, formTypes }) {
  if (!PLANNABLE.has(record.status)) return { noPlan: `status ${record.status}: there is no code to ask about`, slots: [], notes: [] };
  const notes = [];
  const slots = [];
  for (const fn of PRIMARY) {
    const type = formTypes[fn];
    if (record.status === 'nothing_compiles') {
      const first = fn === PRIMARY[0];
      const e = record.functions && record.functions[fn] && record.functions[fn].firstError;
      if (first && e && e.line) slots.push({ slot: fn, function: fn, type, kind: 'compileError', line: e.line, message: e.message });
      else if (first && record.outsideFunctionsError && record.outsideFunctionsError.line) slots.push({ slot: fn, function: fn, type, kind: 'compileErrorOutside', replacedFunction: fn, line: record.outsideFunctionsError.line, message: record.outsideFunctionsError.message });
      else slots.push({ slot: fn, function: fn, type, kind: 'logic', reason: first ? 'no interview function compiles and there is no error line to point to' : 'no interview function compiles' });
      continue;
    }
    let target = fn;
    let replaces;
    if (functionState(record, fn) === 'missing') {
      // mode replaces a completely missing function and takes its type
      target = 'mode';
      replaces = fn;
      notes.push(`${fn} is missing: mode replaces it (${type})`);
    }
    const state = functionState(record, target);
    if (state === 'missing') slots.push({ slot: fn, function: target, type, kind: 'unaskable', replaces, reason: `${fn} is missing and so is mode: no question for this slot` });
    else if (state === 'compileError') {
      const f = record.functions[target];
      const e = f.firstError;
      if (e && e.line) slots.push({ slot: fn, function: target, type, kind: 'compileError', replaces, line: e.line, message: e.message });
      else slots.push({ slot: fn, function: target, type, kind: 'logic', replaces, reason: `${target} does not compile but the compiler gave no line to point to${e ? ` (${e.message})` : ''}` });
    } else slots.push({ slot: fn, function: target, type, kind: type, replaces });
  }
  // an error outside the functions: the compile-error question replaces one function's question
  const outside = record.outsideFunctionsError;
  if (outside && outside.line && record.status === 'file_does_not_compile') {
    const first = slots.find((s) => s.kind === 'predict' || s.kind === 'tracing');
    if (first) {
      notes.push(`an error outside the functions (line ${outside.line}) replaces the ${first.function} question`);
      Object.assign(first, { kind: 'compileErrorOutside', replacedFunction: first.function, line: outside.line, message: outside.message });
    } else notes.push('an error outside the functions, but every slot already has a compile-error or no question: not added');
  }
  return { slots, notes };
}

const ordinal = (k) => `${k}${k % 100 >= 11 && k % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[k % 10] || 'th'}`;
const fill = (text, values) => Object.entries(values).reduce((t, [k, v]) => t.split(`{${k}}`).join(String(v)), text);

/** The question text exactly as the student sees it. */
function renderQuestion(questions, kind, v) {
  const f = v.function ? questions.functions[v.function] : null;
  switch (kind) {
    case 'predict': return fill(f.predict.question, { input: v.display });
    case 'tracing': return fill(questions.tracingQuestion, { line: v.line, function: v.function, input: v.display, kth: ordinal(v.k), what: f.tracing.what });
    case 'compileError': return fill(questions.compileErrorQuestion, { function: v.function, line: v.line });
    case 'compileErrorOutside': return fill(questions.compileErrorOutsideQuestion, { line: v.line });
    case 'logic': return fill(questions.logicQuestion, { function: v.function, input: v.display });
    default: throw new Error(`unknown question kind ${kind}`);
  }
}

module.exports = { PLANNABLE, assignForms, functionState, decideSlots, renderQuestion, ordinal };
