/**
 * Harness builder for the Assignment 02 interview pilot (ECE 2514).
 *
 * The student's functions.cpp is not a program. The runner takes ONE source file, so this module builds one: the assignment's header,
 * then the student's code, then our driver (a main() that reads one command from stdin and prints the result). From the same student
 * code it can also build
 *   - a TRACE copy: one line is written to stderr every time execution reaches a chosen line (a "breakpoint" that never stops), and
 *   - a WHAT-IF copy: one piece of text on one line is replaced.
 *
 * Line numbers always refer to the student's functions.cpp as shown on screen. Every edit keeps the line count (the include of
 * functions.h is blanked, never deleted; the trace statement goes on the same physical line), and `#line 1 "functions.cpp"` is put
 * before the student's code so that compiler messages use the same numbers. `#line 1 "driver.cpp"` is put before the driver.
 *
 * Nothing here throws. Every function returns { ok: true, ... } or { ok: false, reason }. Student code is never logged here.
 */

const crypto = require('crypto');

/**
 * Every trace line starts with a marker, then a tab, the stop number, and one tab-separated name=value per variable. The marker is a new
 * random string for every trace build (returned with the program), so student code cannot forge a stop by printing it.
 */
const newMarker = () => `@@TRACE-${crypto.randomBytes(12).toString('hex')}@@`;
const MAX_VARIABLES = 6;
const MAX_EXPRESSION_CHARS = 80;
const MAX_STOPS = 500;

/**
 * Printing helpers for the trace statement, in their own namespace so they cannot clash with anything a student wrote. Supported types:
 * int, long, unsigned, size_t (any integer type), double (any floating point type), bool, char, std::string and std::vector of int,
 * double, std::string or char. Strings and chars are quoted so that an empty string is visible. Anything else does not compile
 * (there is deliberately no generic overload), and the caller reports that as "unsupported variable type".
 */
const tracePrelude = (marker) => `#include <iostream>
#include <sstream>
#include <string>
#include <vector>
#include <type_traits>
namespace harness_trace {
inline int& counter() { static int n = 0; return n; }
inline void quote(std::ostream& o, const std::string& v) {
  o << '"';
  for (char c : v) {
    if (c == '"') o << "\\\\\\"";
    else if (c == '\\\\') o << "\\\\\\\\";
    else if (c == '\\n') o << "\\\\n";
    else if (c == '\\t') o << "\\\\t";
    else if (c == '\\r') o << "\\\\r";
    else o << c;
  }
  o << '"';
}
template <class T> typename std::enable_if<std::is_same<T, bool>::value>::type put(std::ostream& o, const T& v) { o << (v ? "true" : "false"); }
template <class T> typename std::enable_if<std::is_same<T, char>::value>::type put(std::ostream& o, const T& v) { quote(o, std::string(1, v)); }
template <class T> typename std::enable_if<std::is_integral<T>::value && !std::is_same<T, bool>::value && !std::is_same<T, char>::value>::type put(std::ostream& o, const T& v) { o << +v; }
template <class T> typename std::enable_if<std::is_floating_point<T>::value>::type put(std::ostream& o, const T& v) { o << v; }
inline void put(std::ostream& o, const std::string& v) { quote(o, v); }
template <class T> void putSeq(std::ostream& o, const std::vector<T>& v) {
  o << '[';
  for (size_t i = 0; i < v.size(); i++) { if (i > 0) o << ", "; put(o, v[i]); }
  o << ']';
}
inline void put(std::ostream& o, const std::vector<int>& v) { putSeq(o, v); }
inline void put(std::ostream& o, const std::vector<double>& v) { putSeq(o, v); }
inline void put(std::ostream& o, const std::vector<std::string>& v) { putSeq(o, v); }
inline void put(std::ostream& o, const std::vector<char>& v) { putSeq(o, v); }
inline void fields(std::ostream&) {}
template <class T, class... R> void fields(std::ostream& o, const char* name, const T& v, const R&... rest) {
  o << '\\t' << name << '=';
  put(o, v);
  fields(o, rest...);
}
template <class... A> void emit(const A&... a) {
  std::ostringstream o;
  o << "${marker}" << '\\t' << ++counter();
  fields(o, a...);
  o << '\\n';
  std::cerr << o.str() << std::flush;
}
}
`;

const toText = (value) => String(value === undefined || value === null ? '' : value).replace(/\r\n?/g, '\n');

/** The same text with comments and the inside of string and character literals replaced by spaces (newlines kept, same length). */
function maskSource(text) {
  const out = text.split('');
  const n = text.length;
  const blank = (from, to) => { for (let j = from; j < to; j += 1) if (out[j] !== '\n') out[j] = ' '; };
  let i = 0;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && text[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
    } else if (c === '/' && d === '*') {
      const close = text.indexOf('*/', i + 2);
      const j = close < 0 ? n : close + 2;
      blank(i, j);
      i = j;
    } else if (c === '"') {
      const raw = i > 0 && text[i - 1] === 'R' ? /^"([^()\\\s]{0,16})\(/.exec(text.slice(i, i + 20)) : null;
      if (raw) {
        const end = `)${raw[1]}"`;
        const close = text.indexOf(end, i + raw[0].length);
        const j = close < 0 ? n : close + end.length;
        blank(i + 1, Math.max(i + 1, j - 1));
        i = j;
      } else {
        let j = i + 1;
        while (j < n && text[j] !== '"' && text[j] !== '\n') { if (text[j] === '\\') j += 1; j += 1; }
        blank(i + 1, Math.min(j, n));
        i = j + 1;
      }
    } else if (c === "'") {
      if (i > 0 && /[0-9A-Za-z_]/.test(text[i - 1])) { // a digit separator such as 1'000
        i += 1;
      } else {
        let j = i + 1;
        while (j < n && text[j] !== "'" && text[j] !== '\n') { if (text[j] === '\\') j += 1; j += 1; }
        blank(i + 1, Math.min(j, n));
        i = j + 1;
      }
    } else {
      i += 1;
    }
  }
  return out.join('');
}

const FUNCTIONS_H_INCLUDE = /^([ \t]*#[ \t]*include[ \t]*)(?:"[ \t]*(?:\.\/)?functions\.h[ \t]*"|<[ \t]*(?:\.\/)?functions\.h[ \t]*>)/;

/** Blank the include of functions.h (any spacing, quotes or angle brackets), never deleting the line, so line numbers stay put. */
function removeHeaderInclude(text) {
  const masked = maskSource(text).split('\n');
  return text.split('\n').map((line, i) => (FUNCTIONS_H_INCLUDE.test(line) && masked[i].trim().startsWith('#') ? line.replace(FUNCTIONS_H_INCLUDE, '') : line)).join('\n');
}

const endWithNewline = (text) => (text.endsWith('\n') ? text : `${text}\n`);

function assemble({ header, prelude, student, driver }) {
  return [
    endWithNewline(toText(header)),
    prelude || '',
    '#line 1 "functions.cpp"\n',
    endWithNewline(student),
    '#line 1 "driver.cpp"\n',
    endWithNewline(removeHeaderInclude(toText(driver))),
  ].join('');
}

function checkInputs({ header, studentSource, driver }) {
  if (typeof header !== 'string' || !header.trim()) return 'header is missing';
  if (typeof studentSource !== 'string' || !studentSource.trim()) return 'the student code is empty';
  if (typeof driver !== 'string' || !driver.trim()) return 'driver is missing';
  return null;
}

/** One source file: header, the student's code (functions.h include removed), driver. */
function buildProgram({ header, studentSource, driver } = {}) {
  try {
    const problem = checkInputs({ header, studentSource, driver });
    if (problem) return { ok: false, reason: problem };
    return { ok: true, source: assemble({ header, student: removeHeaderInclude(toText(studentSource)), driver }) };
  } catch (error) {
    return { ok: false, reason: `build failed: ${error.message}` };
  }
}

/** Index in `text` of the character that starts each line. */
const lineStarts = (text) => {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return starts;
};

const CONTROL_START = /^(else|case|default|do|switch|try|catch)\b/;
const LOOP_START = /^(for|while)\b/;
const BRACELESS_HEADERS = new Set(['if', 'for', 'while']);

/**
 * Can a trace statement go before this line, and does the line need braces around it (it is the unbraced body of if/else/for/while)?
 * Refuses, with a reason, rather than guess: blank lines, comments, preprocessor lines, lines with only braces, lines that start with a
 * closing brace, `else`, `case`, `do`, `switch` or a loop header (a breakpoint there stops a different number of times than a print
 * before the line), lines outside a function body and lines inside a statement that spans several lines.
 */
function checkPauseLine(studentSource, pauseLine) {
  const text = removeHeaderInclude(toText(studentSource));
  const lines = text.split('\n');
  if (!Number.isInteger(pauseLine) || pauseLine < 1 || pauseLine > lines.length) return { ok: false, reason: `line ${pauseLine} does not exist (the file has ${lines.length} lines)` };
  const masked = maskSource(text);
  const maskedLines = masked.split('\n');
  const raw = lines[pauseLine - 1];
  const m = maskedLines[pauseLine - 1].trim();

  if (raw.trim() === '') return { ok: false, reason: `line ${pauseLine} is blank` };
  if (m === '') return { ok: false, reason: `line ${pauseLine} is a comment` };
  if (m.startsWith('#')) return { ok: false, reason: `line ${pauseLine} is a preprocessor line` };
  if (/^[{}]+;?$/.test(m)) return { ok: false, reason: `line ${pauseLine} has only braces` };
  if (m.startsWith('}')) return { ok: false, reason: `line ${pauseLine} starts with a closing brace (such as "} else {")` };
  if (m.startsWith('{')) return { ok: false, reason: `line ${pauseLine} starts with an opening brace` };
  if (CONTROL_START.test(m)) return { ok: false, reason: `line ${pauseLine} starts with "${CONTROL_START.exec(m)[1]}": a statement cannot be inserted before it` };
  if (LOOP_START.test(m)) return { ok: false, reason: `line ${pauseLine} is a ${LOOP_START.exec(m)[1]} loop header: a breakpoint there stops a different number of times than a print before the line` };

  // Walk the masked text up to the start of the line.
  const starts = lineStarts(masked);
  const before = masked.slice(0, starts[pauseLine - 1]);
  let paren = 0;
  let brace = 0;
  let lastSig = null;
  let lastSigIndex = -1;
  const openParens = [];
  for (let i = 0; i < before.length; i += 1) {
    const c = before[i];
    if (c === '(' || c === '[') { paren += 1; if (c === '(') openParens.push(i); } else if (c === ')' || c === ']') { paren -= 1; if (c === ')') openParens.pop(); } else if (c === '{') brace += 1; else if (c === '}') brace -= 1;
    if (!/\s/.test(c)) { lastSig = c; lastSigIndex = i; }
  }
  if (brace < 1) return { ok: false, reason: `line ${pauseLine} is not inside a function body` };
  if (paren > 0) return { ok: false, reason: `line ${pauseLine} is inside a statement that spans several lines` };

  let wrap = false;
  if (lastSig === ';' || lastSig === '{' || lastSig === '}') {
    wrap = false;
  } else if (lastSig === ')') {
    // the end of "if (...)", "for (...)", "while (...)" means this line is an unbraced body; anything else is a continuation
    let depth = 0;
    let open = -1;
    for (let i = lastSigIndex; i >= 0; i -= 1) {
      if (before[i] === ')') depth += 1;
      else if (before[i] === '(') { depth -= 1; if (depth === 0) { open = i; break; } }
    }
    const word = open >= 0 ? /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(before.slice(0, open)) : null;
    if (word && BRACELESS_HEADERS.has(word[1])) wrap = true;
    else return { ok: false, reason: `line ${pauseLine} is inside a statement that spans several lines` };
  } else if (lastSig !== null && /[A-Za-z0-9_]/.test(lastSig)) {
    const word = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(before);
    if (word && (word[1] === 'else' || word[1] === 'do')) wrap = true;
    else return { ok: false, reason: `line ${pauseLine} is inside a statement that spans several lines` };
  } else {
    return { ok: false, reason: `line ${pauseLine} is inside a statement that spans several lines` };
  }

  const code = maskedLines[pauseLine - 1].replace(/\s+$/, '');
  if (wrap && !code.endsWith(';')) return { ok: false, reason: `line ${pauseLine} is an unbraced body that does not end on that line` };
  return { ok: true, wrap, codeEnd: code.length };
}

const EXPRESSION = /^[A-Za-z0-9_[\]().:,+\-*/%<> ]+$/; // a comma is fine: the expression is printed inside its own parentheses
const LABEL = /^[A-Za-z][A-Za-z0-9 _.[\]-]{0,30}$/;

/** variables: strings (the name is the expression) or { name, expr }. The expression is read-only: no assignment, no ++ or --, no quotes. */
function normalizeVariables(variables) {
  if (!Array.isArray(variables) || variables.length === 0) return { ok: false, reason: 'no variables to print' };
  if (variables.length > MAX_VARIABLES) return { ok: false, reason: `at most ${MAX_VARIABLES} variables` };
  const out = [];
  for (const entry of variables) {
    const name = typeof entry === 'string' ? entry : entry && entry.name;
    const expr = typeof entry === 'string' ? entry : entry && entry.expr;
    if (typeof name !== 'string' || typeof expr !== 'string') return { ok: false, reason: 'a variable must be a string or { name, expr }' };
    const e = expr.trim();
    if (!e || e.length > MAX_EXPRESSION_CHARS || !EXPRESSION.test(e) || /\+\+|--/.test(e)) return { ok: false, reason: `"${expr.slice(0, 40)}" is not a plain read-only expression` };
    let depth = 0;
    for (const c of e) { if (c === '(' || c === '[') depth += 1; if (c === ')' || c === ']') depth -= 1; if (depth < 0) break; }
    if (depth !== 0) return { ok: false, reason: `"${e}" has unbalanced brackets` };
    const label = name.trim();
    if (!LABEL.test(label)) return { ok: false, reason: `"${name.slice(0, 40)}" is not a usable name` };
    out.push({ name: label, expr: e });
  }
  return { ok: true, variables: out };
}

/**
 * The trace copy: before line `pauseLine` of the student's file, one statement writes `marker<TAB>stop<TAB>name=value...` to stderr.
 * An unbraced if/else/for/while body is wrapped in braces together with the print. The statement goes on the same physical line, so no
 * line number moves. A variable that is not in scope, or has an unsupported type, is a compile error (the caller reports it).
 */
function buildTraceProgram({ header, studentSource, driver, pauseLine, variables } = {}) {
  try {
    const problem = checkInputs({ header, studentSource, driver });
    if (problem) return { ok: false, reason: problem };
    const vars = normalizeVariables(variables);
    if (!vars.ok) return vars;
    const student = removeHeaderInclude(toText(studentSource));
    const check = checkPauseLine(student, pauseLine);
    if (!check.ok) return check;

    const marker = newMarker();
    const statement = `harness_trace::emit(${vars.variables.map(({ name, expr }) => `"${name}", (${expr})`).join(', ')});`;
    const lines = student.split('\n');
    const raw = lines[pauseLine - 1];
    const indent = /^[ \t]*/.exec(raw)[0];
    const body = raw.slice(indent.length);
    const codeEnd = check.codeEnd - indent.length;
    lines[pauseLine - 1] = check.wrap
      ? `${indent}{ ${statement} ${body.slice(0, codeEnd)} }${body.slice(codeEnd)}`
      : `${indent}${statement} ${body}`;
    return { ok: true, source: assemble({ header, prelude: tracePrelude(marker), student: lines.join('\n'), driver }), wrapped: check.wrap, marker };
  } catch (error) {
    return { ok: false, reason: `build failed: ${error.message}` };
  }
}

/** The what-if copy: the exact text `find` on line `line` is replaced by `replace`. `find` must be on that line exactly once. */
function buildWhatIfProgram({ header, studentSource, driver, line, find, replace } = {}) {
  try {
    const problem = checkInputs({ header, studentSource, driver });
    if (problem) return { ok: false, reason: problem };
    if (typeof find !== 'string' || find === '') return { ok: false, reason: 'the text to find is empty' };
    if (typeof replace !== 'string') return { ok: false, reason: 'the replacement text is missing' };
    if (/[\r\n]/.test(find) || /[\r\n]/.test(replace)) return { ok: false, reason: 'find and replace must each fit on one line' };
    if (find === replace) return { ok: false, reason: 'the change would not change anything' };
    const lines = removeHeaderInclude(toText(studentSource)).split('\n');
    if (!Number.isInteger(line) || line < 1 || line > lines.length) return { ok: false, reason: `line ${line} does not exist (the file has ${lines.length} lines)` };
    const text = lines[line - 1];
    let count = 0;
    for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + 1)) count += 1; // overlapping matches count too
    if (count === 0) return { ok: false, reason: `the text to change is not on line ${line}` };
    if (count > 1) return { ok: false, reason: `the text to change is on line ${line} ${count} times` };
    lines[line - 1] = text.replace(find, () => replace);
    return { ok: true, source: assemble({ header, student: lines.join('\n'), driver }) };
  } catch (error) {
    return { ok: false, reason: `build failed: ${error.message}` };
  }
}

/**
 * Every stop found in stderr, in order: [{ stop, values: { name: text }, names: [...], text: 'name=value, name=value' }]. `marker` is the
 * one buildTraceProgram returned; lines with any other marker (for example one the student's code printed) are ignored.
 */
function parseAllStops(stderr, marker) {
  const stops = [];
  if (typeof marker !== 'string' || marker.length < 8) return stops;
  const lines = toText(stderr).split('\n');
  for (const line of lines) {
    const at = line.indexOf(`${marker}\t`);
    if (at < 0) continue;
    const parts = line.slice(at + marker.length + 1).split('\t');
    const stop = Number(parts[0]);
    if (!Number.isInteger(stop) || stop < 1) continue;
    const values = {};
    const names = [];
    for (const part of parts.slice(1)) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      names.push(part.slice(0, eq));
      values[part.slice(0, eq)] = part.slice(eq + 1);
    }
    stops.push({ stop, values, names, text: names.map((name) => `${name}=${values[name]}`).join(', ') });
    if (stops.length >= MAX_STOPS) break;
  }
  return stops;
}

/** The variables at the k-th stop ({ stop, values, names, text }), or { noStop: true, stops: how many there were }. */
function parseTrace(stderr, k, marker) {
  const stops = parseAllStops(stderr, marker);
  const found = Number.isInteger(k) ? stops.find((s) => s.stop === k) : null;
  return found || { noStop: true, stops: stops.length };
}

module.exports = {
  newMarker,
  tracePrelude,
  maskSource,
  removeHeaderInclude,
  checkPauseLine,
  buildProgram,
  buildTraceProgram,
  buildWhatIfProgram,
  parseTrace,
  parseAllStops,
};
