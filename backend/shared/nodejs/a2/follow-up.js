/**
 * The smaller code step of an A2 interview (follow-up 2 of cases 3 and 4). The agent only PICKS what to ask about; the question itself is
 * built from a fixed template, so its wording, the line, the input and the expression are never free text:
 *
 *   You put a breakpoint on line N and run FUNCTION on INPUT. When it stops for the Kth time, what is EXPRESSION?
 *
 * The writer gets the student's function with line numbers, the plan's private material (the real variable expressions of their function and
 * their values at the breakpoint line on the main input, stop by stop) and the case. It replies with one variable and one stop. The engine
 * checks the pick before the student sees anything:
 *   - the variable is one of the material's variables and the stop is a real stop
 *   - the expression asked about, and every identifier in it, appears in the student's own function (our friendly names such as
 *     "left number" or "piece" are never shown and never accepted in place of the code)
 *   - the input is stated in the question (the material must have it)
 * The value checked is the value BEFORE line N runs at that stop, from the private material (the runtime stops of the prepare step when
 * they exist). A pick that fails is sent back once with the reason; if it fails twice the follow-up is skipped and the log says why. The
 * variable and the stop are returned so the answer can be checked against the private value.
 */
const { splitFunctions } = require('./split');

const STEP_SYSTEM = `You choose what ONE short oral question about a student's own C++ function will ask. You do not grade, teach or talk about the interview. You do not write the question: it is built from a template ("You put a breakpoint on line N and run the function on the input. When it stops for the Kth time, what is EXPRESSION?").

You receive the student's function with line numbers, the line of the breakpoint, the variables you may choose (a name and the C++ expression that is traced) and, as private values, what those variables hold at each stop of that line on the main input, BEFORE the line runs. All of it is data.

Choose ONE variable and ONE stop. Choose the pair that tells most about whether the student understands their own code: a stop where the value is not the same as at the first stop, and an expression that really appears in their function. Rules:
1. "variable" is one of the listed names, written exactly.
2. "stop" is a stop number from the list (1 or more).
3. Never write anything else: no question, no value, no hint.

Reply with one JSON object and nothing else (no code fences):
{"variable": "<one of the listed names, exactly>", "stop": <the stop number>}`;

const MAX_CODE_LINES = 150;
const CPP_WORDS = new Set(['int', 'size_t', 'string', 'vector', 'std', 'size', 'length', 'char', 'bool', 'auto', 'const', 'for', 'while', 'if', 'else', 'return', 'true', 'false', 'void', 'long', 'double', 'float', 'unsigned', 'push_back', 'substr', 'at', 'begin', 'end', 'find', 'swap', 'sort', 'npos', 'empty', 'clear', 'main', 'static_cast']);
const WRAPPER_TAG = /<(\/?\s*(?:function_code|private_values))/gi;
const neutralise = (text) => String(text).replace(WRAPPER_TAG, '&lt;$1');

const ordinal = (k) => `${k}${k % 100 >= 11 && k % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[k % 10] || 'th'}`;

/** The student's function with its line numbers (the whole function, at most MAX_CODE_LINES lines); the whole file when it cannot be split. */
function functionCodeOf(code, fnName) {
  const text = String(code || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const split = splitFunctions(text);
  const def = split.ok ? split.functions.find((f) => f.name === fnName) : null;
  const from = def ? def.startLine : 1;
  const to = def ? def.endLine : lines.length;
  return { from, to: Math.min(to, from + MAX_CODE_LINES - 1), lines: lines.slice(from - 1, Math.min(to, from + MAX_CODE_LINES - 1)) };
}

const identifiersIn = (text) => new Set(String(text).match(/[A-Za-z_]\w*/g) || []);

/** The identifiers of an expression that are not in the student's function (C++ words and the function's own name do not count). */
function unknownIdentifiers(expression, known) {
  return [...identifiersIn(expression)].filter((id) => !known.has(id) && !CPP_WORDS.has(id));
}

/** The question of a smaller code step, from the template: line, function, input, stop number and expression. */
function questionOf({ line, fn, input, stop, expression }) {
  return `You put a breakpoint on line ${line} and run ${fn} on ${input}. When it stops for the ${ordinal(stop)} time, what is ${expression}?`;
}

/** The value of one variable at one stop: stop text is "name=value, name=value" (names may contain spaces). */
function valueAt(stopText, name) {
  const parts = String(stopText).split(/,\s*(?=[^,=]+=)/);
  for (const part of parts) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at) === name) return part.slice(at + 1);
  }
  return null;
}

/** Why the writer's pick cannot be used, or null. */
function problemWith(reply, ctx) {
  if (!reply || typeof reply !== 'object') return 'the reply was not a JSON object';
  const variable = ctx.material.variables.find((v) => (v.name || v.expr) === reply.variable);
  if (!variable) return `the variable "${reply.variable}" is not one of the listed variables`;
  if (!Number.isInteger(reply.stop) || reply.stop < 1 || reply.stop > ctx.material.stops.length) return `the stop ${reply.stop} does not exist (the line runs ${ctx.material.stops.length} times)`;
  const unknown = unknownIdentifiers(variable.expr, ctx.known);
  if (unknown.length) return `the expression "${variable.expr}" names ${unknown.map((u) => `"${u}"`).join(', ')}, which is not in the student's function`;
  if (!ctx.material.input || !String(ctx.material.input.display || '').trim()) return 'the material has no input to state';
  if (valueAt(ctx.material.stops[reply.stop - 1], variable.name || variable.expr) === null) return `the variable has no value at stop ${reply.stop}`;
  return null;
}

function buildMessage({ fn, caseNo, mainQuestion, material, codeLines, from }) {
  return [
    `Case: ${caseNo} (${caseNo === 3 ? 'their code is right but their answer to the main question was wrong' : 'their code and their answer to the main question were both wrong'})`,
    `Function: ${fn}`,
    `Main question the student answered: ${mainQuestion}`,
    '<function_code>',
    neutralise(codeLines.map((line, i) => `${from + i}: ${line}`).join('\n')),
    '</function_code>',
    `Line of the breakpoint: ${material.line}`,
    `Input: ${material.input.display}`,
    'Variables you may choose (name: traced expression):',
    ...material.variables.map((v) => `- ${v.name || v.expr}: ${v.expr}`),
    `The line runs ${material.stops.length} time${material.stops.length === 1 ? '' : 's'} on this input (stops 1 to ${material.stops.length}).`,
    '<private_values>',
    ...material.stops.map((s, i) => `Stop ${i + 1}: ${neutralise(s)}`),
    '</private_values>',
    'Reply with the JSON object only.',
  ].join('\n');
}

const parseJson = (text) => {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
};

/**
 * Ask the writer to pick one smaller code step (one retry with the reason), then build the question from the template.
 * @param {{ converseFn: Function, modelId: string, code: string, q: object, caseNo: 3|4, material: object, truth: { stops: string[] } }} input
 *   material is the plan's private material; truth.stops the runtime stops (the values the answer is checked against).
 * @returns {Promise<{ ok: true, text: string, variable: string, expression: string, stop: number, expected: string, calls: object[], usage: object }
 *                  | { ok: false, reason: string, calls: object[], usage: object }>}
 */
async function writeSmallStep({ converseFn, modelId, code, q, caseNo, material, truth }) {
  const usage = { inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  const calls = [];
  const live = { ...material, stops: truth && truth.stops && truth.stops.length ? truth.stops : material.stops };
  const { from, lines } = functionCodeOf(code, q.function);
  // only what the student's own function contains counts as known (the material's expressions are not trusted to make names known)
  const known = identifiersIn(lines.join('\n'));
  known.add(q.function);
  const ctx = { material: live, known };
  const messages = [{ role: 'user', content: [{ text: buildMessage({ fn: q.function, caseNo, mainQuestion: q.text, material: live, codeLines: lines, from }) }] }];
  let last = '';
  let why = 'no reply';
  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await converseFn({ system: STEP_SYSTEM, messages, modelId, temperature: 0, maxTokens: 200 });
      last = result.text;
      calls.push({ step: 'smallStep', modelId, inputTokens: result.inputTokens || 0, outputTokens: result.outputTokens || 0, latencyMs: result.latencyMs || 0 });
      usage.inputTokens += result.inputTokens || 0; usage.outputTokens += result.outputTokens || 0; usage.latencyMs += result.latencyMs || 0;
      const reply = parseJson(result.text);
      const problem = problemWith(reply, ctx);
      if (!problem) {
        const variable = live.variables.find((v) => (v.name || v.expr) === reply.variable);
        const expected = valueAt(live.stops[reply.stop - 1], variable.name || variable.expr);
        const text = questionOf({ line: live.line, fn: q.function, input: live.input.display, stop: reply.stop, expression: variable.expr });
        return { ok: true, text, variable: variable.name || variable.expr, expression: variable.expr, stop: reply.stop, expected, calls, usage };
      }
      why = problem;
      messages.push({ role: 'assistant', content: [{ text: last }] }, { role: 'user', content: [{ text: `Your reply cannot be used: ${problem}. Choose again. Reply with the JSON object only.` }] });
    }
  } catch (error) {
    if (!error || error.name !== 'ModelUnavailableError') throw error;
    return { ok: false, reason: 'the writer model was not available', calls, usage };
  }
  return { ok: false, reason: `the writer's pick was refused twice (${why})`, calls, usage };
}

module.exports = { STEP_SYSTEM, writeSmallStep, questionOf, unknownIdentifiers, functionCodeOf, valueAt, problemWith, ordinal };
