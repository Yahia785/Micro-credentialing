// Splitting a student's functions.cpp into its top-level pieces, to compile the interview functions one by one when the whole file does
// not compile. Matching braces is done on a masked copy of the text (comments and the inside of string and character literals are blank), so
// braces inside them do not count. Nothing here compiles anything.
const { maskSource } = require('../services/harness-builder');

const NOT_FUNCTION_START = /^\s*(?:struct|class|union|enum|namespace)\b/;
// a function definition's header ends with ")" plus optional const / noexcept / override / final / a trailing return type
const FUNCTION_HEADER_END = /\)\s*(?:(?:const|noexcept|override|final|volatile|&&?)\s*)*(?:->[^{;]*)?$/;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'catch', 'else', 'do', 'new', 'delete', 'static_cast', 'dynamic_cast', 'const_cast', 'reinterpret_cast', 'decltype', 'alignof', 'throw']);

const lineOf = (starts, index) => {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= index) lo = mid; else hi = mid - 1; }
  return lo + 1;
};

/** The index of the "}" that closes the "{" at `open` (in masked text), or -1 when the braces never balance. */
function matchingBrace(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '{') depth += 1;
    else if (masked[i] === '}') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/** The name of a function from its header text: the identifier before the first "(" (a qualified name keeps its qualifier). */
function functionName(header) {
  const m = /([A-Za-z_~][\w:]*)\s*\(/.exec(header);
  return m ? m[1] : null;
}

/**
 * @param {string} source the student's functions.cpp
 * @returns {{ ok: true, source: string, functions: Array<{name, start, end, startLine, endLine, body}> }
 *          | { ok: false, reason: string }}
 *   functions: every top-level function definition (name, character range, first and last line, masked body text). Everything else
 *   (includes, using lines, globals, structs, declarations) is the "top part" and is not listed.
 */
function splitFunctions(source) {
  const text = String(source || '').replace(/\r\n?/g, '\n');
  const masked = maskSource(text);
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  const functions = [];
  let i = 0;
  const n = masked.length;
  while (i < n) {
    if (/\s/.test(masked[i])) { i += 1; continue; }
    // a preprocessor line (with backslash continuations) is part of the top part
    if (masked[i] === '#') {
      let j = i;
      while (j < n && !(masked[j] === '\n' && masked[j - 1] !== '\\')) j += 1;
      i = j;
      continue;
    }
    const segStart = i;
    // find the first ";" or "{" outside parentheses and brackets
    let j = i;
    let paren = 0;
    while (j < n && !((masked[j] === ';' || masked[j] === '{') && paren === 0)) {
      if (masked[j] === '(' || masked[j] === '[') paren += 1;
      else if (masked[j] === ')' || masked[j] === ']') paren -= 1;
      else if (masked[j] === '}' && paren === 0) return { ok: false, reason: `unbalanced braces: a "}" with no "{" on line ${lineOf(starts, j)}` };
      j += 1;
    }
    if (j >= n) break; // the rest is not a complete statement: part of the top part
    if (masked[j] === ';') { i = j + 1; continue; }
    const header = masked.slice(segStart, j);
    const close = matchingBrace(masked, j);
    if (close < 0) return { ok: false, reason: `unbalanced braces: the "{" on line ${lineOf(starts, j)} is never closed` };
    const isFunction = !NOT_FUNCTION_START.test(header) && FUNCTION_HEADER_END.test(header.trimEnd()) && header.includes('(');
    if (isFunction) {
      const name = functionName(header);
      if (name) functions.push({ name, start: segStart, end: close + 1, startLine: lineOf(starts, segStart), endLine: lineOf(starts, close), body: masked.slice(j, close + 1) });
    }
    i = close + 1;
    while (i < n && /[ \t]/.test(masked[i])) i += 1;
    if (masked[i] === ';') i += 1; // "struct A { ... };" and "int a[] = { ... };"
  }
  return { ok: true, source: text, masked, functions };
}

/** Names called in a function body (identifier followed by "("), minus keywords. */
function calledNames(body) {
  const names = new Set();
  const re = /\b([A-Za-z_]\w*)\s*\(/g;
  let m;
  while ((m = re.exec(body)) !== null) if (!KEYWORDS.has(m[1])) names.add(m[1]);
  return names;
}

/**
 * The functions `fn` needs: every other top-level function it calls, and those they call, and so on (matched by name; the first
 * definition of a name wins). Returns the definitions in file order.
 */
function helpersOf(fn, functions) {
  const byName = new Map();
  for (const f of functions) if (!byName.has(f.name)) byName.set(f.name, f);
  const seen = new Set([fn.name]);
  const queue = [fn];
  const found = [];
  while (queue.length) {
    const current = queue.shift();
    for (const name of calledNames(current.body)) {
      const target = byName.get(name);
      if (target && !seen.has(name)) { seen.add(name); found.push(target); queue.push(target); }
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/**
 * The file with every top-level function NOT in `keep` blanked out (each of its lines becomes an empty line), so the top part and the kept
 * functions stay on their original line numbers.
 */
function composeFile(split, keep, { minimalTop = false } = {}) {
  const kept = new Set(keep.map((f) => f.start));
  const chars = split.source.split('');
  for (const f of split.functions) {
    if (kept.has(f.start)) continue;
    for (let k = f.start; k < f.end; k += 1) if (chars[k] !== '\n') chars[k] = ' ';
  }
  if (minimalTop) {
    // The top part (everything outside the function definitions) keeps only its #include and using lines; the rest of it is blanked.
    // This is for the test build only: the student's stored code is never changed.
    const inFunction = new Array(chars.length).fill(false);
    for (const f of split.functions) for (let k = f.start; k < f.end; k += 1) inFunction[k] = true;
    let lineStart = 0;
    const maskedLines = split.masked.split('\n');
    maskedLines.forEach((line) => {
      const end = lineStart + line.length;
      let outside = true;
      for (let k = lineStart; k < end; k += 1) if (inFunction[k]) { outside = false; break; }
      const keepLine = /^\s*#\s*include\b/.test(line) || /^\s*using\b[^;{}]*;\s*$/.test(line);
      if (outside && !keepLine) for (let k = lineStart; k < end; k += 1) chars[k] = ' ';
      lineStart = end + 1;
    });
  }
  return chars.join('');
}

module.exports = { splitFunctions, helpersOf, calledNames, composeFile, functionName, matchingBrace };
