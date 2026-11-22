// Analysis of one student submission: which header builds, which interview functions exist, and how the code behaves on every candidate
// input (sanitizers, then the plain runner build). The compiler and runner are injected (`docker`), so the logic is testable without Docker.
const harness = require('../../../shared/nodejs/services/harness-builder');
const { FUNCTIONS, PRIMARY, NO_MACRO } = require('./common');
const { STATUS } = require('./record');
const { splitFunctions, helpersOf, composeFile } = require('./split');

const MAX_REBUILDS = FUNCTIONS.length + 1;
const SANITIZER_PATTERN = /ERROR: AddressSanitizer|runtime error:|ERROR: UndefinedBehaviorSanitizer|SUMMARY: (Address|Undefined)Sanitizer/;

const definesFor = (missing) => missing.map((fn) => `#define ${NO_MACRO[fn]} 1\n`).join('');

/**
 * Read the compiler output: which files had errors (functions.cpp = the student's code, driver.cpp = our driver, anything else = the
 * header text), and which interview functions the driver could not use because the student did not define or declare them.
 */
function parseCompilerOutput(text) {
  const out = String(text || '');
  const files = new Set();
  const errorLines = [];
  for (const line of out.split('\n')) {
    const m = /^([^\s:]+):\d+(?::\d+)?: (?:fatal )?error: (.*)$/.exec(line);
    if (m) { files.add(m[1]); errorLines.push(`${m[1]}: ${m[2]}`.slice(0, 200)); }
  }
  const missing = new Set();
  for (const fn of FUNCTIONS) {
    if (new RegExp(`undefined reference to [\`'‘]${fn}\\(`).test(out)) missing.add(fn);
    if (new RegExp(`^driver\\.cpp:\\d+:\\d+: error: [‘']${fn}[’'] was not declared`, 'm').test(out)) missing.add(fn);
  }
  const linkError = /undefined reference to|ld returned/.test(out);
  return { files: [...files], errorLines: errorLines.slice(0, 3), missing: [...missing], linkError };
}

/** Build with one header, leaving out (via the driver's macros) every function the build shows is missing. */
async function buildWith({ header, code, driver, docker }) {
  const missing = [];
  let last = null;
  for (let attempt = 0; attempt < MAX_REBUILDS; attempt += 1) {
    const built = harness.buildProgram({ header: definesFor(missing) + header, studentSource: code, driver });
    if (!built.ok) return { ok: false, reason: built.reason, errorLines: [built.reason] };
    const result = await docker.compile(built.source);
    if (result.ok) return { ok: true, missing, source: built.source };
    last = parseCompilerOutput(result.errors);
    const fresh = last.missing.filter((fn) => !missing.includes(fn));
    if (fresh.length === 0) break;
    missing.push(...fresh);
  }
  return { ok: false, reason: 'does not compile', errorLines: last ? last.errorLines : [], files: last ? last.files : [] };
}

const firstLines = (text, n = 3) => String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, n).join(' | ').slice(0, 300);

/** How one run ended under the sanitizers: ok | sanitizer | crash | time_limit (with the first lines of the report). */
function classifySanitizerRun({ code, stderr }) {
  const report = SANITIZER_PATTERN.test(stderr || '')
    ? firstLines(String(stderr).split('\n').filter((l) => /ERROR:|runtime error:|SUMMARY:|^\s*#[0-3] /.test(l)).join('\n'), 3)
    : null;
  if (code === 124) return { status: 'time_limit', report: null };
  if (report) return { status: 'sanitizer', report };
  if (code !== 0) return { status: 'crash', report: `exit code ${code}` };
  return { status: 'ok', report: null };
}

function classifyPlainRun({ code, stdout }) {
  if (code === 124) return { status: 'time_limit', output: null };
  if (code === null || code === undefined) return { status: 'not_run', output: null };
  if (code !== 0) return { status: 'crash', output: null };
  return { status: 'ok', output: String(stdout || '').trim().slice(0, 400) };
}

/** Turn the raw results of docker.runInputs into the per-input records. */
function classifyInputs(toRun, ran) {
  return toRun.map((input, i) => {
    const run = ran.runs[i] || { san: {}, plain: {} };
    const san = ran.sanCompile.ok ? classifySanitizerRun(run.san) : { status: 'not_run', report: ran.sanCompile.errors ? firstLines(ran.sanCompile.errors, 1) : null };
    const plain = ran.plainCompile.ok ? classifyPlainRun(run.plain) : { status: 'not_run', output: null };
    const excluded = san.status !== 'ok' || plain.status !== 'ok';
    return {
      function: input.function,
      cmd: input.cmd,
      sanitizer: { status: san.status, report: san.report },
      plain: { status: plain.status, output: plain.output },
      output: plain.output,
      matchesSpec: plain.status === 'ok' ? plain.output === String(input.spec).trim() : false,
      unclearSpec: Boolean(input.unclearSpec),
      excludeFromQuestions: excluded,
      excludeReason: excluded ? (san.status !== 'ok' ? `sanitizer: ${san.status}` : `plain run: ${plain.status}`) : null,
    };
  });
}

/**
 * The first compiler error of a build, as { line, message }: line is the line in the student's functions.cpp (the #line directives make
 * the numbers match), message is the compiler's text without any source line. An error that is not in functions.cpp has line null.
 */
function firstError(compilerOutput) {
  let other = null;
  for (const line of String(compilerOutput || '').split('\n')) {
    const m = /^([^\s:]+):(\d+)(?::\d+)?: (?:fatal )?error: (.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === 'functions.cpp') return { line: Number(m[2]), message: m[3].slice(0, 200) };
    if (!other) other = { line: null, message: `${m[1]}: ${m[3]}`.slice(0, 200) };
  }
  return other || { line: null, message: 'did not compile' };
}

/**
 * functions.cpp does not compile as a whole: try each interview function on its own. For a function the file is kept as it is, except that
 * every other top-level function is blanked out (its lines become empty lines, so line numbers stay the student's), apart from the helper
 * functions it calls that compile on their own. The driver is built with only that function enabled.
 */
async function analyzeParts({ studentHeader, studentCode, officialHeader, driver, inputs, docker, failure, studentProblem }) {
  const headers = [];
  if (typeof studentHeader === 'string' && studentHeader.trim()) headers.push({ name: 'student', text: studentHeader });
  headers.push({ name: 'official', text: officialHeader });
  const base = { studentHeaderProblem: studentProblem, compileError: ((failure && failure.errorLines) || []).join(' | ').slice(0, 600), inputs: [] };
  const empty = (message) => Object.fromEntries(FUNCTIONS.map((fn) => [fn, { present: null, compiles: false, compilesAlone: false, firstError: { line: null, message } }]));

  const split = splitFunctions(studentCode);
  if (!split.ok) return { ...base, status: STATUS.NOTHING_COMPILES, headerUsed: null, functions: empty(`could not split the file: ${split.reason}`), modeNeeded: null, splitNote: split.reason };

  // Compile the top part plus the functions in `keep`, with the driver enabled only for `enabled` (null: for none). Student header first.
  async function tryCompile(keep, enabled, minimalTop = false) {
    const file = composeFile(split, keep, { minimalTop });
    const missing = FUNCTIONS.filter((fn) => fn !== enabled);
    let error = null;
    for (const header of headers) {
      const built = harness.buildProgram({ header: definesFor(missing) + header.text, studentSource: file, driver });
      if (!built.ok) { error = error || { line: null, message: built.reason }; continue; }
      const result = await docker.compile(built.source);
      if (result.ok) return { ok: true, headerUsed: header.name, source: built.source };
      const e = firstError(result.errors);
      if (!error || (error.line === null && e.line !== null)) error = e;
    }
    return { ok: false, error };
  }

  // A helper compiles on its own when it, with the helpers it calls, builds next to the top part.
  const helperResults = new Map();
  async function helperCompiles(helper, minimalTop) {
    const key = `${helper.start}:${minimalTop}`;
    if (!helperResults.has(key)) helperResults.set(key, await tryCompile([helper, ...helpersOf(helper, split.functions)], null, minimalTop));
    return helperResults.get(key);
  }

  // One function with the helpers it needs that compile on their own (the top part whole, or with only its #include and using lines).
  async function attempt(def, minimalTop) {
    const good = [];
    const broken = [];
    for (const helper of helpersOf(def, split.functions)) (await helperCompiles(helper, minimalTop)).ok ? good.push(helper) : broken.push(helper);
    const kept = [def, ...good];
    return { ...(await tryCompile(kept, def.name, minimalTop)), kept, broken };
  }
  const outsideKept = (error, kept) => error && error.line !== null && !kept.some((f) => error.line >= f.startLine && error.line <= f.endLine);
  let outsideFunctionsError = null;

  const functions = {};
  const sources = {};
  for (const fn of FUNCTIONS) {
    const def = split.functions.find((f) => f.name === fn);
    if (!def) { functions[fn] = { present: false, compiles: false, compilesAlone: false, firstError: { line: null, message: `no definition of ${fn} found in functions.cpp` } }; continue; }
    let result = await attempt(def, false);
    let blockedByOutside = false;
    if (!result.ok && outsideKept(result.error, result.kept)) {
      // The error is in the top part, not in a function: record it once, and try again with only the #include and using lines of the top part.
      outsideFunctionsError = outsideFunctionsError || result.error;
      result = await attempt(def, true);
      if (!result.ok && outsideKept(result.error, result.kept)) blockedByOutside = true; // an #include or using line itself is broken
    }
    functions[fn] = {
      present: true,
      compiles: result.ok,
      compilesAlone: result.ok,
      firstError: result.ok || blockedByOutside ? null : result.error,
      ...(blockedByOutside ? { blockedByOutsideError: true } : {}),
      ...(result.broken.length ? { brokenHelpers: result.broken.map((h) => h.name) } : {}),
      ...(result.ok ? { headerUsed: result.headerUsed } : {}),
    };
    if (result.ok) sources[fn] = result.source;
  }

  // Sanitizers and plain runs, only for the functions that compile alone, the same way as for a whole file.
  // mode is the backup only for a function that is completely missing; one that exists but does not compile gets a compile-error question (M4)
  const analysis = { ...base, functions, outsideFunctionsError, modeNeeded: PRIMARY.some((fn) => functions[fn].present === false) };
  for (const fn of Object.keys(sources)) {
    const toRun = inputs.filter((input) => input.function === fn);
    if (toRun.length === 0) continue;
    const ran = await docker.runInputs({ source: sources[fn], cmds: toRun.map((i) => i.cmd) });
    analysis.inputs.push(...classifyInputs(toRun, ran));
  }
  const used = [...new Set(Object.values(functions).filter((f) => f.headerUsed).map((f) => f.headerUsed))];
  analysis.headerUsed = used.length === 0 ? null : used.length === 1 ? used[0] : 'mixed';
  analysis.status = Object.keys(sources).length > 0 ? STATUS.FILE_DOES_NOT_COMPILE : STATUS.NOTHING_COMPILES;
  return analysis;
}

/**
 * @param {{ studentHeader: string|null, studentCode: string, officialHeader: string, driver: string,
 *           inputs: Array<{function:string, cmd:string, spec:string, unclearSpec?:boolean}>, docker: object }} args
 * @returns {Promise<object>} { status: 'ok'|'file_does_not_compile'|'nothing_compiles', headerUsed, studentHeaderProblem, functions, modeNeeded, compileError, inputs }
 */
async function analyzeSubmission({ studentHeader, studentCode, officialHeader, driver, inputs, docker }) {
  const attempts = [];
  if (typeof studentHeader === 'string' && studentHeader.trim()) attempts.push({ name: 'student', header: studentHeader });
  attempts.push({ name: 'official', header: officialHeader });

  let chosen = null;
  let studentProblem = studentHeader ? null : 'functions.h is missing from the repository';
  let failure = null;
  for (const attempt of attempts) {
    const result = await buildWith({ header: attempt.header, code: studentCode, driver, docker });
    if (result.ok) { chosen = { ...result, headerUsed: attempt.name }; break; }
    if (attempt.name === 'student') studentProblem = (result.errorLines || []).join(' | ').slice(0, 400) || result.reason;
    if (!failure || attempt.name === 'student') failure = result;
  }

  if (!chosen) return analyzeParts({ studentHeader, studentCode, officialHeader, driver, inputs, docker, failure, studentProblem });

  const functions = Object.fromEntries(FUNCTIONS.map((fn) => [fn, { present: !chosen.missing.includes(fn), compiles: !chosen.missing.includes(fn) }]));
  const modeNeeded = PRIMARY.some((fn) => !functions[fn].present);

  // Run every candidate input of the functions that exist: sanitizers first, then the plain (runner flags) build.
  const toRun = inputs.filter((input) => functions[input.function] && functions[input.function].present);
  const analysis = { status: 'ok', headerUsed: chosen.headerUsed, studentHeaderProblem: chosen.headerUsed === 'official' ? studentProblem : null, functions, modeNeeded, compileError: null, inputs: [] };
  if (toRun.length === 0) return analysis;
  const ran = await docker.runInputs({ source: chosen.source, cmds: toRun.map((i) => i.cmd) });
  analysis.inputs = classifyInputs(toRun, ran);
  return analysis;
}

module.exports = { analyzeSubmission, analyzeParts, firstError, classifyInputs, parseCompilerOutput, classifySanitizerRun, classifyPlainRun, buildWith, definesFor };
