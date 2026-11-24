// Scripted answers that are really RIGHT (or really wrong) for a student's own code, for the case 2 "why" and "which line", and for the
// compile-error question. They are made from the bug description of the fake variant (scripts/eval/a2/variants/*/meta.json) and from the
// student's code: the line number is found in the student's file, so the answer names the real line and the real change.
//
// The scripted answers are for a person to read and for the scripted run only; they are written OUTSIDE the repo.

const FUNCTION_DEF = /^[A-Za-z_][\w:<>&*\s]*\b(\w+)\s*\([^;]*\)\s*(const\s*)?\{?\s*$/;

/** The 1-based lines of one function: { from, to, lines } (from = its signature line). null when it is not found. */
function regionOf(code, fn) {
  const lines = String(code || '').replace(/\r\n?/g, '\n').split('\n');
  const from = lines.findIndex((text) => { const m = FUNCTION_DEF.exec(text); return m && m[1] === fn; });
  if (from < 0) return null;
  let to = lines.length - 1;
  for (let i = from + 1; i < lines.length; i += 1) if (FUNCTION_DEF.test(lines[i])) { to = i - 1; break; }
  return { from: from + 1, to: to + 1, lines };
}

/** The first (or last) line of the function that matches the pattern: { number, text } or null. */
function findLine(region, pattern, last = false) {
  if (!region) return null;
  const hits = [];
  for (let n = region.from; n <= region.to; n += 1) if (pattern.test(region.lines[n - 1])) hits.push(n);
  if (!hits.length) return null;
  const number = last ? hits[hits.length - 1] : hits[0];
  return { number, text: region.lines[number - 1].trim() };
}

/** Per fake variant: what is wrong, which line holds it, what to change. */
const BUGS = {
  v03: { why: 'my loop goes all the way to vec.size() instead of stopping at the middle, so every pair is swapped twice and the vector ends up unchanged', line: /for\s*\(.*<\s*vec\.size\(\)\s*;/, fix: 'change the loop condition to `i < vec.size() / 2` so that each pair is swapped only once' },
  v04: { why: 'vec.size() - 1 is a size_t, so on an empty vector it wraps around to a huge number, the loop runs and reads vec[0] of an empty vector', line: /size_t\s+right\s*=\s*vec\.size\(\)\s*-\s*1/, fix: 'use `int right = static_cast<int>(vec.size()) - 1;` so an empty vector does not wrap around' },
  v05: { why: 'the text after the last delimiter is never added: my loop only pushes a piece when it sees the delimiter, so the last piece is lost', line: /return\s+parts\s*;/, last: true, fix: 'add `parts.push_back(current);` right before the return so the last piece is added' },
  v06: { why: 'I skip the empty pieces: I only add a piece when it is not empty, so the empty string between two delimiters is lost', line: /(!\s*current\.empty\(\)|current\.(size|length)\(\)\s*(>|!=)\s*0|current\s*!=\s*"")/, fix: 'remove that condition and always add the piece, even when it is empty' },
  v07: { why: 'only rolls[0] and rolls[1] are checked for 1 to 6, so a bad value in a later roll is not reported as -1', line: /rolls\.size\(\)\s*>=\s*2|rolls\[1\]\s*<\s*1/, fix: 'loop over every roll and return -1 if any one is not between 1 and 6, instead of checking only the first two' },
  v08: { why: 'the final return is 0 where it should be 2, so a game that is not finished is reported as a player win', line: /return\s+0\s*;/, last: true, fix: 'change the final `return 0;` to `return 2;`' },
  v09: { why: 'I use >= when comparing the counts, so on a tie the later, larger value replaces the earlier one', line: /count\s*>=\s*bestCount|>=\s*best/, fix: 'change `>=` to `>` so a tie keeps the smaller value' },
  v10: { why: 'my splitString is only a stub: the body is `return {};` and I never wrote the loop that splits the string, so it always returns an empty list', line: /return\s*\{\s*\}\s*;/, fix: 'replace `return {};` with a loop that adds each piece between the delimiters to the vector and returns it' },
};

/**
 * The scripted answers of a case 2 function.
 * @param {{ bug: string|null, code: string|null, fn: string, description?: string|null }} input
 * @returns {{ why: string, line: string, wrongLine: string }}
 */
function caseTwoAnswers({ bug, code, fn, description = null }) {
  const region = code ? regionOf(code, fn) : null;
  // the plan names the bug only when the code matches a known variant; a stub body (return {};) is recognised here from the code itself
  const known = BUGS[bug] ? bug : (region && findLine(region, BUGS.v10.line) ? 'v10' : null);
  const info = known ? BUGS[known] : null;
  const where = info ? findLine(region, info.line, info.last === true) : null;
  const lcFirst = (text) => (text ? text.charAt(0).toLowerCase() + text.slice(1) : text);
  const why = info ? `Because ${info.why}.` : (description ? `Because ${lcFirst(description)}` : 'Because of a mistake in my code that I can see once I read it again');
  const line = info && where ? `Line ${where.number}, \`${where.text}\`: ${info.fix}.` : (info ? `I would fix it: ${info.fix}.` : 'I would fix it: the line that causes the wrong result');
  // a line that is NOT where the bug is: the function's own first line (its signature), with a change that does not help
  const wrongLine = region ? `Line ${region.from}, the function header: I would change the parameter types there.` : 'The function header, I would change the parameter types there';
  return { why, line, wrongLine, lineNumber: where ? where.number : null };
}

/**
 * The scripted answer to a compile-error question: what is wrong on the line (what is missing) and the fix, from the compiler's message and
 * the line of the student's code.
 * @param {{ message: string, line: number, code: string|null }} input
 */
function compileAnswer({ message, line, code }) {
  const text = code ? String(code).replace(/\r\n?/g, '\n').split('\n')[line - 1] : null;
  const shown = text === undefined || text === null ? null : text.trim();
  const where = shown ? `On line ${line}, \`${shown}\`` : `On line ${line}`;
  if (/expected primary-expression before ';'/.test(message)) {
    const fixed = shown && /=\s*;/.test(shown) ? shown.replace(/=\s*;/, '= 0;') : null;
    return `${where}: the = has nothing after it, a value is missing before the ;. I would give it a value${fixed ? `, for example \`${fixed}\`,` : ''} or delete the line.`;
  }
  const semicolon = /expected ';' before/.exec(message);
  if (semicolon) return `${where}: the ; is missing at the end of the statement, so the compiler says "${message}". I would add a ; at the end of that line.`;
  return `${where}: the compiler says "${message}". I would correct that line so it follows what the message describes.`;
}

module.exports = { regionOf, findLine, caseTwoAnswers, compileAnswer, BUGS };
