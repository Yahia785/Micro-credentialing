// Suggesting the breakpoint line (and the traced variables) of a tracing question from the student's own code, by pattern, inside the
// function body. A suggestion is "confident" only when exactly one good candidate is left; otherwise it is "manual" (a person sets the
// line in the overrides file). A line is good only if harness-builder's trace builder accepts it. Nothing here compiles or runs code.
//
//   reverseList  the line that swaps two elements (a swap( call, or the first line of a temp-variable swap)
//   splitString  the line that adds a piece to the result vector (push_back / emplace_back), preferring one inside the loop
//   playCraps    the first line after a roll's sum is worked out (two dice added), preferring the one inside the loop
//   mode         the line that compares a count with the best count so far
const harness = require('../../../shared/nodejs/services/harness-builder');
const { splitFunctions } = require('./split');

const COUNT_WORDS = /count|freq|times|occur|num/i;
const BEST_WORDS = /best|max|most|high|top|largest|biggest/i;
const LOOP_START = /^\s*(for|while)\b/;

/** Split "a, f(b, c), d" at the top-level commas. */
function splitArgs(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const c of text) {
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    if (c === ',' && depth === 0) { parts.push(current.trim()); current = ''; } else current += c;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** The text between the "(" that follows `name` in the line (found on the masked copy) and its closing ")": the call's arguments. */
function callArgs(line, maskedLine, name) {
  const re = new RegExp(`(?:\\b|::)${name}\\s*\\(`);
  const m = re.exec(maskedLine);
  if (!m) return null;
  const open = m.index + m[0].length;
  let depth = 1;
  for (let i = open; i < maskedLine.length; i += 1) {
    if (maskedLine[i] === '(') depth += 1;
    else if (maskedLine[i] === ')') { depth -= 1; if (depth === 0) return line.slice(open, i); }
  }
  return null;
}

/** Context of one function: its lines (original and masked), the body range, which lines are inside a loop, the first parameter's name. */
function contextOf(code, fnName) {
  const split = splitFunctions(code);
  if (!split.ok) return { error: `the file could not be split: ${split.reason}` };
  const def = split.functions.find((f) => f.name === fnName);
  if (!def) return { error: `no definition of ${fnName} found` };
  const lines = split.source.split('\n');
  const masked = split.masked.split('\n');
  const body = [];
  for (let n = def.startLine + 1; n < def.endLine; n += 1) body.push(n); // the lines between the header line and the closing brace line
  // inside a loop: a for/while block, or the unbraced body of a for/while
  const inLoop = new Set();
  const stack = [];
  let pending = ''; // the text of the current statement so far (since the last ; { or } outside parentheses)
  let paren = 0;
  let headerNoBrace = false; // the previous statement was a for/while header with no "{": the next statement is its body
  for (let n = def.startLine; n <= def.endLine; n += 1) {
    const m = masked[n - 1];
    if (stack.includes('loop') || headerNoBrace) inLoop.add(n);
    if (LOOP_START.test(m) && m.includes('{')) inLoop.add(n);
    if (m.trim() !== '' && headerNoBrace && !LOOP_START.test(m)) headerNoBrace = false;
    for (let i = 0; i < m.length; i += 1) {
      const c = m[i];
      if (c === '(') paren += 1;
      else if (c === ')') paren -= 1;
      else if (paren === 0 && c === '{') { stack.push(LOOP_START.test(pending) ? 'loop' : 'other'); pending = ''; } else if (paren === 0 && c === '}') { stack.pop(); pending = ''; } else if (paren === 0 && c === ';') pending = '';
      else pending += c;
    }
    pending += ' ';
    if (LOOP_START.test(pending) && paren === 0 && !m.includes('{') && /\)\s*$/.test(m.trim())) headerNoBrace = true;
  }
  const header = lines[def.startLine - 1];
  const param = (/\(\s*(?:const\s+)?[\w:<>]+\s*&?\s*(\w+)\s*(?:,|\))/.exec(header) || [])[1] || null; // the first parameter's name
  return { code, def, lines, masked, body, inLoop, param };
}

const at = (ctx, n) => ctx.lines[n - 1];
const maskedAt = (ctx, n) => ctx.masked[n - 1];
const norm = (text) => text.replace(/\s+/g, ' ').trim();

/** Why this line / these variables cannot be used by the trace builder, or null when they can. */
function acceptable(code, line, variables) {
  const check = harness.checkPauseLine(code, line);
  if (!check.ok) return check.reason;
  const vars = harness.normalizeVariables(variables);
  if (!vars.ok) return vars.reason;
  return null;
}

const LEFT = 'left number';
const RIGHT = 'right number';

function reverseListCandidates(ctx) {
  const found = [];
  for (const n of ctx.body) {
    const m = maskedAt(ctx, n);
    const orig = at(ctx, n);
    // a swap( or iter_swap( call
    const call = /(?:^|[^\w])(?:std::)?(swap|iter_swap)\s*\(/.exec(m);
    if (call) {
      const raw = callArgs(orig, m, call[1]);
      const args = raw === null ? [] : splitArgs(raw);
      if (args.length === 2) {
        const deref = (a) => (call[1] === 'iter_swap' ? `*(${a})` : a);
        found.push({ line: n, variables: [{ name: LEFT, expr: deref(args[0]) }, { name: RIGHT, expr: deref(args[1]) }], kind: `${call[1]}() call` });
        continue;
      }
    }
    // a temp-variable swap:  T x = A;  A = B;  B = x;
    const decl = /^\s*(?:[\w:<>]+\s+)+(\w+)\s*=\s*([^;=]+?)\s*;\s*$/.exec(m);
    if (!decl) continue;
    const tmp = decl[1];
    const first = norm(decl[2]);
    const next = [];
    for (let k = n + 1; k <= ctx.def.endLine && next.length < 2; k += 1) if (maskedAt(ctx, k).trim() !== '') next.push(k);
    if (next.length < 2) continue;
    const a = /^\s*([^;=]+?)\s*=\s*([^;=]+?)\s*;\s*$/.exec(maskedAt(ctx, next[0]));
    const b = /^\s*([^;=]+?)\s*=\s*(\w+)\s*;\s*$/.exec(maskedAt(ctx, next[1]));
    if (a && b && norm(a[1]) === first && b[2] === tmp && norm(b[1]) === norm(a[2])) {
      found.push({ line: n, variables: [{ name: LEFT, expr: first }, { name: RIGHT, expr: norm(a[2]) }], kind: 'temp-variable swap' });
    }
  }
  return found;
}

function splitStringCandidates(ctx) {
  const bodyText = ctx.body.map((n) => maskedAt(ctx, n)).join('\n');
  const result = (/vector\s*<\s*(?:std::)?string\s*>\s*(\w+)\s*(?:;|=|\{|\()/.exec(bodyText) || /\breturn\s+(\w+)\s*;/.exec(bodyText) || [])[1];
  if (!result) return [];
  const re = new RegExp(`\\b${result}\\s*\\.\\s*(push_back|emplace_back)\\s*\\(`);
  const found = [];
  for (const n of ctx.body) {
    const m = maskedAt(ctx, n);
    const hit = re.exec(m);
    if (!hit) continue;
    const arg = callArgs(at(ctx, n), m, hit[1]);
    if (arg === null) continue;
    found.push({ line: n, variables: [{ name: 'piece', expr: arg.trim() }], inLoop: ctx.inLoop.has(n), kind: `${result}.${hit[1]}(...)` });
  }
  return found;
}

function playCrapsCandidates(ctx) {
  const param = ctx.param;
  if (!param) return [];
  const diceVars = new Set();
  const found = [];
  const index = '(?:\\[[^\\]]*\\]|\\.at\\([^)]*\\))';
  for (const n of ctx.body) {
    const m = maskedAt(ctx, n);
    const assign = /^\s*(?:(?:const\s+)?(?:unsigned\s+)?(?:int|auto|long|size_t|short)\s+)?(\w+)\s*=\s*(.+?)\s*;\s*$/.exec(m);
    if (!assign) continue;
    const lhs = assign[1];
    const rhs = assign[2];
    if (new RegExp(`^${param}\\s*${index}$`).test(rhs)) { diceVars.add(lhs); continue; }
    const twoIndexed = new RegExp(`^${param}\\s*${index}\\s*\\+\\s*${param}\\s*${index}$`).test(rhs);
    const two = /^(\w+)\s*\+\s*(\w+)$/.exec(rhs);
    const twoVars = two && diceVars.has(two[1]) && diceVars.has(two[2]) && two[1] !== two[2];
    if (!twoIndexed && !twoVars) continue;
    // the breakpoint is the first line after the sum
    let next = null;
    for (let k = n + 1; k < ctx.def.endLine; k += 1) if (maskedAt(ctx, k).trim() !== '') { next = k; break; }
    found.push({ line: next, sumLine: n, variables: [{ name: 'sum', expr: lhs }], inLoop: ctx.inLoop.has(n), kind: `${lhs} = two dice added (line ${n})` });
  }
  return found;
}

function modeCandidates(ctx) {
  const found = [];
  for (const n of ctx.body) {
    const m = maskedAt(ctx, n);
    if (!/\b(if|while)\b|\?/.test(m)) continue;
    let count = null;
    for (const g of m.matchAll(/(\w+)\s*(?:>=|>)\s*(\w+)/g)) if (BEST_WORDS.test(g[2]) && !BEST_WORDS.test(g[1])) { count = g[1]; break; }
    if (!count) for (const g of m.matchAll(/(\w+)\s*(?:<=|<)\s*(\w+)/g)) if (BEST_WORDS.test(g[1]) && !BEST_WORDS.test(g[2])) { count = g[2]; break; }
    if (!count || /^\d+$/.test(count)) continue;
    // the value being checked: the assignment to the "best value" variable in the lines that follow
    let valueExpr = null;
    for (let k = n + 1; k <= Math.min(ctx.def.endLine - 1, n + 8) && !valueExpr; k += 1) {
      const a = /^\s*(\w+)\s*=\s*([^;=]+?)\s*;/.exec(maskedAt(ctx, k));
      if (a && !COUNT_WORDS.test(a[1]) && !/^\d+$/.test(a[2].trim())) valueExpr = a[2].trim();
    }
    found.push({ line: n, variables: valueExpr ? [{ name: 'value', expr: valueExpr }, { name: 'count', expr: count }] : null, inLoop: ctx.inLoop.has(n), kind: `${count} compared with the best count`, noValue: !valueExpr });
  }
  return found;
}

const DETECTORS = { reverseList: reverseListCandidates, splitString: splitStringCandidates, playCraps: playCrapsCandidates, mode: modeCandidates };

/**
 * @returns {{ status: 'confident'|'manual', line?: number, variables?: object[],
 *             candidates: Array<{line:number|null, text:string|null, kind:string, inLoop:boolean, rejected?:string, variables?:object[]}>, reason?: string }}
 */
function suggestLine(code, fnName) {
  const ctx = contextOf(code, fnName);
  if (ctx.error) return { status: 'manual', candidates: [], reason: ctx.error };
  const detector = DETECTORS[fnName];
  if (!detector) return { status: 'manual', candidates: [], reason: `no pattern for ${fnName}` };
  const candidates = detector(ctx).map((c) => {
    const base = { line: c.line, text: c.line ? at(ctx, c.line).trim() : null, kind: c.kind, inLoop: Boolean(c.inLoop) };
    if (!c.line) return { ...base, rejected: 'the sum is the last statement of the function: there is no line after it' };
    if (c.noValue) return { ...base, rejected: 'cannot tell which value is being counted' };
    const bad = acceptable(ctx.code, c.line, c.variables);
    return bad ? { ...base, rejected: bad } : { ...base, variables: c.variables };
  });
  let good = candidates.filter((c) => !c.rejected);
  if (good.length > 1) { // prefer the one inside the loop
    const inside = good.filter((c) => c.inLoop);
    if (inside.length === 1) good = inside;
  }
  if (good.length === 1) return { status: 'confident', line: good[0].line, variables: good[0].variables, candidates };
  const reason = good.length === 0
    ? (candidates.length === 0 ? 'no line matches the pattern' : `no usable line (${candidates.map((c) => `line ${c.line}: ${c.rejected}`).join('; ')})`)
    : `${good.length} lines could be the one (${good.map((c) => c.line).join(', ')})`;
  return { status: 'manual', candidates, reason };
}

module.exports = { suggestLine, contextOf, splitArgs, callArgs };
