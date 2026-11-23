// Finding a what-if change for one student's function (case 1, follow-up 2): a small edit to one line of THEIR code that changes what the
// function does, so the student can be asked "with this change, what would it return for X?". The question shows the whole old and new line.
//
// An edit is accepted only when (all run in Docker, gcc:13, no network):
//   - the changed copy compiles and, on the input, runs without any sanitizer report (-fsanitize=address,undefined), crash or time limit
//   - its output differs from the student's own output on that input
//   - it is never the fix: when the student's output is not the spec answer, the edit must not make it the spec answer
// Lines of the loop header (for / while) are tried last. The edits are simple, one change on one line: a comparison made stricter or looser
// (< <=, > >=, == !=), a number one bigger (+ 1 -> + 2, - 1 -> - 2) and a step of one made a step of two (i++ -> i += 2).
const harness = require('../../../shared/nodejs/services/harness-builder');
const { contextOf } = require('./lines');
const { classifySanitizerRun, classifyPlainRun } = require('./analyze');
const { checkWhatIf } = require('../../eval/a2/selection');

const MAX_EDITS = 10;
const LOOP_HEADER = /^\s*(for|while)\b/;

/** [regex on the masked line, how to turn the matched text into the replacement] */
const OPERATORS = [
  [/ <= /g, () => ' < '],
  [/ < /g, () => ' <= '],
  [/ >= /g, () => ' > '],
  [/ > /g, () => ' >= '],
  [/ == /g, () => ' != '],
  [/ != /g, () => ' == '],
  [/\+ 1(?![\d.])/g, () => '+ 2'],
  [/- 1(?![\d.])/g, () => '- 2'],
  [/\b\w+\+\+/g, (m) => `${m.slice(0, -2)} += 2`],
];

const countOf = (text, find) => { let n = 0; for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + 1)) n += 1; return n; };

/**
 * The edits to try for one function, in the order they are tried: lines of the body first (in file order), loop header lines last.
 * @returns {Array<{ line: number, find: string, replace: string, oldLine: string, newLine: string, loopHeader: boolean }>}
 */
function candidateEdits(code, fnName) {
  const ctx = contextOf(code, fnName);
  if (ctx.error) return [];
  const edits = [];
  for (const n of ctx.body) {
    const masked = ctx.masked[n - 1];
    const original = ctx.lines[n - 1];
    if (masked.trim() === '') continue;
    const loopHeader = LOOP_HEADER.test(masked);
    for (const [re, make] of OPERATORS) {
      re.lastIndex = 0;
      for (const m of masked.matchAll(re)) {
        const find = original.slice(m.index, m.index + m[0].length);
        const replace = make(find);
        // the text must be on the line exactly once (buildWhatIfProgram's rule), and the edit must change something
        if (find === replace || countOf(original, find) !== 1) continue;
        edits.push({ line: n, find, replace, oldLine: original.trim(), newLine: original.replace(find, () => replace).trim(), loopHeader });
      }
    }
  }
  return [...edits.filter((e) => !e.loopHeader), ...edits.filter((e) => e.loopHeader)];
}

/**
 * Find the first edit that passes every rule on one of the inputs.
 * @param {{ docker: object, parts: {header:string, studentSource:string}, driver: string, code: string, fn: string,
 *           inputs: Array<{cmd:string, display:string, spec:string, output:string}>, maxEdits?: number }} args
 *   inputs: the inputs the question may use, in preference order, each with the student's own output (output) and the spec answer.
 * @returns {Promise<{ ok: true, edit: object, input: object, output: string, tried: number } | { ok: false, reason: string, tried: number }>}
 */
async function findWhatIf({ docker, parts, driver, code, fn, inputs, maxEdits = MAX_EDITS }) {
  if (inputs.length === 0) return { ok: false, reason: 'no safe input to ask it on', tried: 0 };
  const edits = candidateEdits(code, fn);
  if (edits.length === 0) return { ok: false, reason: 'no line of the function has a simple change to try', tried: 0 };
  let tried = 0;
  const why = [];
  for (const edit of edits.slice(0, maxEdits)) {
    const built = harness.buildWhatIfProgram({ header: parts.header, studentSource: parts.studentSource, driver, line: edit.line, find: edit.find, replace: edit.replace });
    if (!built.ok) { why.push(`line ${edit.line}: ${built.reason}`); continue; }
    tried += 1;
    const ran = await docker.runInputs({ source: built.source, cmds: inputs.map((i) => i.cmd) });
    if (!ran.sanCompile.ok || !ran.plainCompile.ok) { why.push(`line ${edit.line} \`${edit.find}\` -> \`${edit.replace}\`: the changed copy does not compile`); continue; }
    for (let i = 0; i < inputs.length; i += 1) {
      const san = classifySanitizerRun(ran.runs[i].san);
      const plain = classifyPlainRun(ran.runs[i].plain);
      if (san.status !== 'ok' || plain.status !== 'ok') { why.push(`line ${edit.line} \`${edit.find}\` -> \`${edit.replace}\` on ${inputs[i].cmd}: ${san.status !== 'ok' ? `sanitizer ${san.status}` : `plain run ${plain.status}`}`); continue; }
      const verdict = checkWhatIf({ plain: { stdout: inputs[i].output }, whatIf: { status: 'accepted', stdout: plain.output }, spec: inputs[i].spec });
      if (!verdict.ok) { why.push(`line ${edit.line} \`${edit.find}\` -> \`${edit.replace}\` on ${inputs[i].cmd}: ${verdict.reason}`); continue; }
      return { ok: true, edit, input: inputs[i], output: plain.output, tried };
    }
  }
  return { ok: false, reason: `no edit passed (${why.slice(0, 4).join('; ') || 'none could be built'}${why.length > 4 ? '; ...' : ''})`, tried };
}

module.exports = { candidateEdits, findWhatIf };
