/**
 * host.v7: the analysis of the student's code, done once before the interview (inside the prepare step, never while the student waits on
 * an API call). Two model calls with the engine in between:
 *
 *   plan call      plan.v1.md     the problem statement, the code, the code status, the visible test results (hidden tests only as a
 *                                 pass/fail count), the instructor's run outputs and the main questions with their rubric
 *                                 -> up to 6 inputs to run, each with a reason
 *   the runs       (the engine)   all of them in one batch through the same runner and the same agent run limit as the instructor's
 *                                 runs (one run per input)
 *   analysis call  analyze.v1.md  everything above plus the outputs of all runs -> findings { id, kind, concept, lines, relatedQuestion, evidence }
 *
 * A finding that cites evidence must cite a run that really happened (same input, and the output text is in what the program printed);
 * a "bug" must have such evidence. The engine rejects the others, asks once for a corrected list, then drops what is still invalid.
 * Any failed call ends the analysis with what has been found so far (or nothing): it never stops the interview from starting.
 * Tokens and latency are stored per call. Nothing here logs code, outputs, findings or model replies.
 */
const fs = require('fs');
const path = require('path');
const { runAllQuestions } = require('./interview-runs');
const { describeCodeStatus } = require('../agent/code-status');
const { squash } = require('../agent/rubric-check');
const view = require('../utils/interview-view');
const log = require('../utils/logger');

const PLAN_SYSTEM = fs.readFileSync(path.join(__dirname, '..', 'agent', 'prompts', 'plan.v1.md'), 'utf8').trim();
const ANALYZE_SYSTEM = fs.readFileSync(path.join(__dirname, '..', 'agent', 'prompts', 'analyze.v1.md'), 'utf8').trim();
const PLAN_PROMPT_VERSION = 'plan.v1';
const ANALYZE_PROMPT_VERSION = 'analyze.v1';

const MAX_PLANNED_RUNS = 6;
const MAX_FINDINGS = 8;
const MAX_STDIN_CHARS = 2000;
const MAX_CODE_CHARS = 30000;
const MAX_VISIBLE_TESTS = 10;
const PLAN_MAX_TOKENS = 700;
const ANALYZE_MAX_TOKENS = 1500;
const KINDS = Object.freeze(['bug', 'risk', 'strength', 'unfinished']);

const WRAPPER_TAG = /<(\/?\s*(?:problem_statement|student_code|instructor_runs|runs|main_questions))/gi;
const neutralise = (text) => String(text).replace(WRAPPER_TAG, '&lt;$1');
const unavailable = (error) => error && error.name === 'ModelUnavailableError';
const oneLine = (text, max) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);

/** A model call that keeps its tokens and latency in `calls`. */
function recorder(modelId, calls, converseFn) {
  return async (step, request) => {
    const result = await converseFn({ modelId, temperature: 0, ...request });
    calls.push({ step, modelId, inputTokens: result.inputTokens || 0, outputTokens: result.outputTokens || 0, latencyMs: result.latencyMs || 0 });
    return result;
  };
}

// --- what the models are given ---------------------------------------------------------------------------------------------

function numbered(code) {
  const trimmed = code.length > MAX_CODE_CHARS ? `${code.slice(0, MAX_CODE_CHARS)}\n// [code truncated]` : code;
  return trimmed.split('\n').map((line, i) => `${i + 1}: ${line}`).join('\n');
}

/** The visible tests in full, and the hidden ones as a count only. */
function testLines(testResults) {
  const results = Array.isArray(testResults) ? testResults : [];
  if (results.length === 0) return ['Visible test results: none available', 'Hidden tests: none available'];
  const visible = results.filter((r) => !r.isHidden);
  const hidden = results.filter((r) => r.isHidden);
  const lines = ['Visible test results:'];
  visible.slice(0, MAX_VISIBLE_TESTS).forEach((r, i) => {
    lines.push(`Test ${i + 1} (${r.passed ? 'passed' : 'failed'}): input "${oneLine(r.input, 300)}"; expected "${oneLine(r.expectedOutput, 600)}"; the program printed "${oneLine(r.actualOutput, 600)}"`);
  });
  if (visible.length === 0) lines.push('(no visible tests)');
  lines.push(hidden.length ? `Hidden tests: ${hidden.filter((r) => r.passed).length} of ${hidden.length} passed` : 'Hidden tests: none');
  return lines;
}

/** Every run as text, for the plan call (the instructor's) and the analysis call (all). */
function runBlock(tag, runs) {
  if (runs.length === 0) return [`<${tag}>`, '(none)', `</${tag}>`];
  const lines = runs.flatMap((run) => {
    const head = `Run "${run.label}" (stdin: ${oneLine(run.stdin, 300) || 'empty'}):`;
    if (run.status === 'compile_error') return [`${head} the program did not compile.`];
    const how = run.status === 'accepted' ? 'finished' : String(run.status || 'unknown').replace(/_/g, ' ');
    return [`${head} ${how}; it printed:`, neutralise(String(run.stdout || '')) || '(nothing)'];
  });
  return [`<${tag}>`, ...lines, `</${tag}>`];
}

function questionLines(questions) {
  return ['<main_questions>', ...questions.flatMap((q, i) => [
    `${i + 1}. ${q.question}`,
    ...q.rubric.map((item) => `   - ${item.id}: ${item.text}`),
  ]), '</main_questions>'];
}

/**
 * @param {{ statement: string, code: string, codeStatus: object, testResults: object[], questions: Array<{question: string, rubric: object[]}> }} context
 */
function commonLines({ statement, code, codeStatus, testResults, questions }) {
  return [
    '<problem_statement>',
    neutralise(oneLine(statement, 6000) ? String(statement).slice(0, 6000) : '(not available)'),
    '</problem_statement>',
    '<student_code>',
    neutralise(numbered(code)),
    '</student_code>',
    `Code status: ${describeCodeStatus(codeStatus)}`,
    ...testLines(testResults),
    ...questionLines(questions),
  ];
}

function buildPlanMessage(context, instructorRuns) {
  return [...commonLines(context), ...runBlock('instructor_runs', instructorRuns), 'Reply with the JSON object only.'].join('\n');
}

function buildAnalysisMessage(context, runs) {
  return [...commonLines(context), ...runBlock('runs', runs), 'Reply with the JSON object only.'].join('\n');
}

// --- reading the replies -----------------------------------------------------------------------------------------------------

function parseObject(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const sameInput = (a, b) => String(a || '').replace(/\s+/g, ' ').trim() === String(b || '').replace(/\s+/g, ' ').trim();

/** The inputs the plan asked for: at most 6, none empty or too long, none the instructor's runs already use, none twice. */
function readPlan(text, knownStdins) {
  const parsed = parseObject(text);
  if (!parsed || !Array.isArray(parsed.runs)) return null;
  const seen = [...knownStdins];
  const plan = [];
  parsed.runs.forEach((entry) => {
    if (plan.length >= MAX_PLANNED_RUNS || !entry || typeof entry.stdin !== 'string') return;
    const stdin = entry.stdin;
    if (!stdin.trim() && stdin !== '') return;
    if (stdin.length > MAX_STDIN_CHARS || seen.some((known) => sameInput(known, stdin))) return;
    seen.push(stdin);
    plan.push({ label: `agent run ${plan.length + 1}`, stdin, reason: oneLine(entry.reason, 200) });
  });
  return plan;
}

/** "12", "12-15" or [12, 15] as "12" / "12-15" when inside the code, else null. */
function readLines(value, lineCount) {
  let from; let to;
  if (typeof value === 'number') { from = value; to = value; } else if (typeof value === 'string') {
    const m = /^\s*(\d+)\s*(?:-|–|to)?\s*(\d+)?\s*$/.exec(value);
    if (!m) return null;
    from = Number(m[1]); to = m[2] ? Number(m[2]) : from;
  } else if (Array.isArray(value) && value.length && value.every((n) => Number.isInteger(n))) {
    from = Math.min(...value); to = Math.max(...value);
  } else return null;
  if (!(from >= 1 && to >= from && to <= lineCount)) return null;
  return from === to ? String(from) : `${from}-${to}`;
}

/**
 * The findings of a reply, checked. A finding is invalid when its kind is unknown, it has no concept, a "bug" has no evidence, or its
 * evidence does not match a run that happened (the input is the input of a run and the output text is in what that run printed).
 * @returns {{ findings: object[], invalid: Array<{ index: number, error: string }> } | null}  null when the reply is not a findings list
 */
function readFindings(text, { runs, questionCount, lineCount }) {
  const parsed = parseObject(text);
  if (!parsed || !Array.isArray(parsed.findings)) return null;
  const findings = [];
  const invalid = [];
  parsed.findings.slice(0, MAX_FINDINGS * 2).forEach((entry, index) => {
    const fail = (error) => invalid.push({ index: index + 1, error });
    if (!entry || typeof entry !== 'object') return fail('not an object');
    if (!KINDS.includes(entry.kind)) return fail('unknown kind');
    const concept = oneLine(entry.concept, 400);
    if (!concept) return fail('no concept');
    const stdin = entry.evidence && typeof entry.evidence.stdin === 'string' ? entry.evidence.stdin : '';
    const output = entry.evidence && typeof entry.evidence.output === 'string' ? entry.evidence.output : '';
    const cites = !!(stdin.trim() || output.trim());
    if (entry.kind === 'bug' && !cites) return fail('a bug needs evidence from a run');
    let evidence = null;
    if (cites) {
      const run = runs.find((r) => sameInput(r.stdin, stdin));
      if (!run) return fail('the input is not the input of any run');
      if (!squash(output) || !squash(run.stdout).includes(squash(output))) return fail('the output is not what that run printed');
      evidence = { stdin: run.stdin, output: oneLine(output, 600) };
    }
    const related = Number.isInteger(entry.relatedQuestion) && entry.relatedQuestion >= 1 && entry.relatedQuestion <= questionCount ? entry.relatedQuestion : null;
    findings.push({ kind: entry.kind, concept, lines: readLines(entry.lines, lineCount), relatedQuestion: related, evidence });
  });
  return { findings: findings.slice(0, MAX_FINDINGS), invalid };
}

const withIds = (findings) => findings.map((finding, i) => ({ id: `f${i + 1}`, ...finding }));

// --- the whole analysis ------------------------------------------------------------------------------------------------------

/**
 * @param {object} p
 * @param {{ statement: string, code: string, codeStatus: object, testResults: object[], questions: Array<{question: string, rubric: object[]}> }} p.context
 * @param {Array<{label, stdin, stdout, status, timeMs}>} p.instructorRuns the runs of the instructor's inputs, all main questions
 * @param {{ checker: string }} p.models
 * @returns {Promise<{ status: 'ok'|'partial'|'failed'|'skipped', findings: object[], runs: object[], runsNote: string|null, plan: object[], calls: object[], latencyMs: number, rejected?: object[] }>}
 *   `runs` are the runs the agent chose (label, stdin, stdout, status, timeMs, reason, chosenBy: 'agent').
 */
async function analyzeCode({ converseFn, models, context, instructorRuns, userId, interviewId, limits, runBatch, countRun, deadlineAt = null, clock = () => performance.now() }) {
  const startedAt = clock();
  const calls = [];
  const ask = recorder(models.checker, calls, converseFn);
  const out = { status: 'ok', findings: [], runs: [], runsNote: null, plan: [], calls, latencyMs: 0 };
  const finish = (status, error) => {
    out.status = status;
    if (error) out.error = error;
    out.latencyMs = Math.max(0, Math.round(clock() - startedAt));
    return out;
  };
  const lineCount = context.code.split('\n').length;
  const knownStdins = instructorRuns.map((run) => run.stdin);
  const canRun = !(context.codeStatus && context.codeStatus.compiles === false);

  // 1. the plan (nothing to plan when the code does not compile)
  if (canRun) {
    try {
      const planned = await ask('plan', { system: PLAN_SYSTEM, messages: [{ role: 'user', content: [{ text: buildPlanMessage(context, instructorRuns) }] }], maxTokens: PLAN_MAX_TOKENS });
      const plan = readPlan(planned.text, knownStdins);
      if (plan === null) out.error = 'plan_invalid'; else out.plan = plan;
    } catch (error) {
      if (!unavailable(error)) throw error;
      out.error = 'plan_unavailable';
    }
  }

  // 2. the runs (one batch, the same limit as the instructor's runs)
  if (out.plan.length > 0) {
    const [batch] = await runAllQuestions({ code: context.code, questions: [out.plan.map(({ label, stdin }) => ({ label, stdin }))], userId, interviewId, limits, runBatch, countRun, deadlineAt });
    out.runs = batch.runs.map((run) => ({ ...run, reason: (out.plan.find((p) => p.label === run.label) || {}).reason || '', chosenBy: 'agent' }));
    out.runsNote = batch.note;
  }

  // 3. the analysis, from every run that happened
  const allRuns = [...instructorRuns, ...out.runs];
  const check = (text) => readFindings(text, { runs: allRuns, questionCount: context.questions.length, lineCount });
  const messages = [{ role: 'user', content: [{ text: buildAnalysisMessage(context, allRuns) }] }];
  let reply;
  try {
    reply = await ask('analysis', { system: ANALYZE_SYSTEM, messages, maxTokens: ANALYZE_MAX_TOKENS });
  } catch (error) {
    if (!unavailable(error)) throw error;
    return finish(out.error ? 'failed' : 'partial', out.error || 'analysis_unavailable');
  }
  let read = check(reply.text);
  if (!read) {
    out.error = 'analysis_invalid';
    return finish('partial', 'analysis_invalid');
  }
  if (read.invalid.length > 0) {
    // One retry: what was wrong, and a request for the corrected list.
    out.rejected = read.invalid;
    const request = `Some findings were rejected: ${read.invalid.map((i) => `finding ${i.index}: ${i.error}`).join('; ')}. Cite only runs that really happened, copying the input and a part of the output exactly. Reply with the corrected JSON object only (every finding that is valid, and the corrected ones).`;
    try {
      const again = await ask('analysis_retry', {
        system: ANALYZE_SYSTEM, messages: [...messages, { role: 'assistant', content: [{ text: reply.text }] }, { role: 'user', content: [{ text: request }] }], maxTokens: ANALYZE_MAX_TOKENS,
      });
      const second = check(again.text);
      if (second) read = second; // a retry that is not a findings list keeps the valid findings of the first reply
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
  }
  out.findings = withIds(read.findings); // what is still invalid after the retry was left out by readFindings
  if (read.invalid.length > 0) out.rejected = read.invalid;
  log.info('Interview analysis done', { interviewId, findings: out.findings.length, plannedRuns: out.plan.length, runs: out.runs.length });
  return finish(out.error ? 'partial' : 'ok');
}

/** The context the models are given, from the stored submission, the problem and the interview config. */
function buildContext({ submission, milestone, config, codeStatus }) {
  const positions = view.mainPositions(config);
  const { rubricFor } = require('../agent/interview-engine');
  return {
    statement: (milestone && milestone.description) || '',
    code: submission.code || '',
    codeStatus,
    testResults: submission.testResults || [],
    questions: positions.map((position) => ({
      question: config.themes[position.themeIndex].mainQuestions[position.mainIndex],
      rubric: rubricFor(config, position),
    })),
  };
}

module.exports = {
  analyzeCode, buildContext, readPlan, readFindings, readLines, buildPlanMessage, buildAnalysisMessage, testLines,
  PLAN_SYSTEM, ANALYZE_SYSTEM, PLAN_PROMPT_VERSION, ANALYZE_PROMPT_VERSION, MAX_PLANNED_RUNS, MAX_FINDINGS,
};
