/**
 * Is the submitted code finished? Decided once, when the interview starts, with no model.
 *
 *   compiles   false when the grader or a run saw a compile error, true when tests ran, null when unknown (not graded)
 *   passed / total   tests passed out of total, from the submission (null when it was never graded)
 *   stubs      functions whose body is empty or a placeholder (TODO, "not implemented", one trivial return)
 *   unfinished compiles === false, or at least one stub
 *
 * Tests failing does not make code unfinished: a complete program with a bug is still a finished program.
 * The stub check is a text scan, not a parser: it is meant to catch the obvious cases (empty body, TODO, `return 0;`).
 */
const NOT_FINISHED_SENTENCE = 'Your code is not finished, so answer based on how you intended it to work.';

const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'else', 'do', 'return', 'sizeof']);
const PLACEHOLDER = /\b(todo|fixme|not implemented|your code here|implement me|write your)\b/i;
const TRIVIAL_RETURN = /^return\s*(?:[-+]?\d+(?:\.\d+)?|true|false|nullptr|NULL|""|''|\{\s*\}|[A-Za-z_]\w*::[A-Za-z_]\w*)?\s*;?$/;

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

/** The text between the brace at `open` and its partner, or null when it never closes. */
function bodyAt(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return { body: code.slice(open + 1, i), end: i };
    }
  }
  return null;
}

/** Names of the functions with an empty or placeholder body, in the order they appear. */
function findStubs(code) {
  const text = String(code || '');
  const found = [];
  // name ( params ) [const] {   -- a definition; calls and control statements are filtered out below
  const header = /([A-Za-z_]\w*(?:::~?[A-Za-z_]\w*)*)\s*\(([^;(){}]*)\)\s*(?:const\s*)?(?:noexcept\s*)?\{/g;
  let match;
  while ((match = header.exec(text)) !== null) {
    const name = match[1];
    const bare = name.split('::').pop();
    if (CONTROL_WORDS.has(bare)) continue;
    // a definition has a return type (or is a constructor) before the name: skip `x = foo(...) {` style noise
    const before = text.slice(Math.max(0, match.index - 80), match.index);
    if (/[=,(]\s*$/.test(before)) continue;
    const open = match.index + match[0].length - 1;
    const parsed = bodyAt(text, open);
    if (!parsed) continue;
    const raw = parsed.body;
    const code = stripComments(raw).replace(/\s+/g, ' ').trim();
    const hasParams = match[2].trim() !== '' && match[2].trim() !== 'void';
    const empty = code === '';
    const placeholder = PLACEHOLDER.test(raw);
    // `return 0;` is a stub only for a function that takes input; main and other no-input functions can really do that
    const trivial = hasParams && bare !== 'main' && TRIVIAL_RETURN.test(code);
    if (empty || placeholder || trivial) found.push(bare);
    header.lastIndex = Math.max(header.lastIndex, open + 1); // keep scanning inside: nested definitions are rare, cheap to allow
  }
  return [...new Set(found)];
}

/** Compile and test facts from the stored submission (what the grader saw). */
function factsFromSubmission(submission) {
  const results = Array.isArray(submission && submission.testResults) ? submission.testResults : [];
  const compileError = (r) => /compil/i.test(String(r.status || '')) || /compil/i.test(String(r.error || '').slice(0, 200));
  let compiles = null;
  if (results.length > 0) compiles = !results.every(compileError);
  const total = Number.isInteger(submission && submission.totalTests) ? submission.totalTests : null;
  const passed = Number.isInteger(submission && submission.passedTests) ? submission.passedTests : null;
  return { compiles, passed: submission && submission.status === 'grading_failed' ? null : passed, total: submission && submission.status === 'grading_failed' ? null : total };
}

/**
 * @param {{ code: string, submission?: object, runs?: Array<{status:string}> }} input  runs: results of the first question's runs, when any
 * @returns {{ compiles: boolean|null, passed: number|null, total: number|null, stubs: string[], unfinished: boolean }}
 */
function classifyCode({ code, submission, runs = [] }) {
  const facts = factsFromSubmission(submission);
  if (runs.some((run) => run.status === 'compile_error')) facts.compiles = false;
  const stubs = findStubs(code);
  return { ...facts, stubs, unfinished: facts.compiles === false || stubs.length > 0 };
}

/** One line for the model calls and the instructor. */
function describeCodeStatus(status) {
  if (!status) return 'finished';
  const parts = [];
  if (status.compiles === false) parts.push('does not compile');
  if (status.stubs && status.stubs.length) parts.push(`these functions are empty or placeholders: ${status.stubs.join(', ')}`);
  if (parts.length === 0) {
    return Number.isInteger(status.passed) && Number.isInteger(status.total)
      ? `finished (${status.passed} of ${status.total} tests passed)`
      : 'finished';
  }
  const tests = Number.isInteger(status.passed) && Number.isInteger(status.total) ? ` (${status.passed} of ${status.total} tests passed)` : '';
  return `unfinished: ${parts.join('; ')}${tests}`;
}

module.exports = { classifyCode, findStubs, describeCodeStatus, NOT_FINISHED_SENTENCE };
