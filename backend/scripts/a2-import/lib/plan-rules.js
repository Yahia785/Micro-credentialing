// The rules that decide WHICH question each student gets (pure functions; no runs). Plan version 3, the case design:
//   - the MAIN question of a function is a logic question, the same for every student (questions.json functions[fn].main)
//   - mode replaces a function ONLY when that function is completely missing (no definition) and takes its place and its rotation type
//   - a function that exists but does not compile gets a compile-error question instead of its logic question (no follow-ups)
//   - an error outside the functions replaces the question of the first function that has a logic question (no follow-ups)
//   - when nothing compiles, the first function gets a compile-error question (its own first compiler error, or the outside error);
//     the other two keep their logic main questions with no follow-ups (there is no code to ask about)
//   - the type of follow-up 1 of case 1 (predict or tracing) rotates: students sorted by importId alternate A, B, A, B
const { PRIMARY } = require('./common');

const PLANNABLE = new Set(['ok', 'file_does_not_compile', 'nothing_compiles']);

/** Sort by importId and alternate A, B, A, B so the rotation is split evenly. Returns Map importId -> 'A'|'B' (only records that can have a plan). */
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
 * @param {{ record: object, rotation: {reverseList:string, splitString:string, playCraps:string} }} args  rotation: the types of this student's form
 * @returns {{ noPlan?: string, slots: Array<{ slot: string, function: string, type: 'predict'|'tracing', kind: string, replaces?: string,
 *   replacedFunction?: string, line?: number, message?: string, followUps: boolean, reason?: string }>, notes: string[] }}
 *   kind: logic | compileError | compileErrorOutside | unaskable. `type` is the rotation type of the slot's function (follow-up 1 of case 1).
 *   followUps is false when no follow-up can be asked (compile errors, and no code to ask about).
 */
function decideSlots({ record, rotation }) {
  if (!PLANNABLE.has(record.status)) return { noPlan: `status ${record.status}: there is no code to ask about`, slots: [], notes: [] };
  const notes = [];
  const slots = [];
  for (const fn of PRIMARY) {
    const type = rotation[fn];
    if (record.status === 'nothing_compiles') {
      const first = fn === PRIMARY[0];
      const e = record.functions && record.functions[fn] && record.functions[fn].firstError;
      if (first && e && e.line) slots.push({ slot: fn, function: fn, type, kind: 'compileError', line: e.line, message: e.message, followUps: false });
      else if (first && record.outsideFunctionsError && record.outsideFunctionsError.line) slots.push({ slot: fn, function: fn, type, kind: 'compileErrorOutside', replacedFunction: fn, line: record.outsideFunctionsError.line, message: record.outsideFunctionsError.message, followUps: false });
      else slots.push({ slot: fn, function: fn, type, kind: 'logic', followUps: false, reason: first ? 'no interview function compiles and there is no error line to point to' : 'no interview function compiles: logic question only' });
      continue;
    }
    let target = fn;
    let replaces;
    if (functionState(record, fn) === 'missing') {
      // mode replaces a completely missing function, with the type of the function it replaces
      target = 'mode';
      replaces = fn;
      notes.push(`${fn} is missing: mode replaces it (${type})`);
    }
    const state = functionState(record, target);
    if (state === 'missing') slots.push({ slot: fn, function: target, type, kind: 'unaskable', replaces, followUps: false, reason: `${fn} is missing and so is mode: no question for this slot` });
    else if (state === 'compileError') {
      const e = record.functions[target].firstError;
      if (e && e.line) slots.push({ slot: fn, function: target, type, kind: 'compileError', replaces, line: e.line, message: e.message, followUps: false });
      else slots.push({ slot: fn, function: target, type, kind: 'logic', replaces, followUps: false, reason: `${target} does not compile but the compiler gave no line to point to${e ? ` (${e.message})` : ''}` });
    } else slots.push({ slot: fn, function: target, type, kind: 'logic', replaces, followUps: true });
  }
  // an error outside the functions: the compile-error question replaces the first logic question
  const outside = record.outsideFunctionsError;
  if (outside && outside.line && record.status === 'file_does_not_compile') {
    const first = slots.find((s) => s.kind === 'logic');
    if (first) {
      notes.push(`an error outside the functions (line ${outside.line}) replaces the ${first.function} question`);
      Object.assign(first, { kind: 'compileErrorOutside', replacedFunction: first.function, line: outside.line, message: outside.message, followUps: false });
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
    case 'main': return f.main.question;
    case 'small': return f.small.question;
    case 'predict': return fill(f.predict.question, { input: v.display });
    case 'tracing': return fill(questions.tracingQuestion, { line: v.line, function: v.function, input: v.display, kth: ordinal(v.k), what: f.tracing.what });
    case 'whatIf': return fill(questions.caseTemplates.whatIf, { line: v.line, function: v.function, oldLine: v.oldLine, newLine: v.newLine, tail: fill(f.whatIfTail, { input: v.display }) });
    case 'debug': return fill(questions.caseTemplates.debug, { function: v.function, output: v.output, input: v.display, spec: v.spec });
    case 'change': return questions.caseTemplates.change;
    case 'case3': return f.case3Question;
    case 'compileError': return fill(questions.compileErrorQuestion, { function: v.function, line: v.line });
    case 'compileErrorOutside': return fill(questions.compileErrorOutsideQuestion, { line: v.line });
    default: throw new Error(`unknown question kind ${kind}`);
  }
}

module.exports = { PLANNABLE, assignForms, functionState, decideSlots, renderQuestion, ordinal, fill };
