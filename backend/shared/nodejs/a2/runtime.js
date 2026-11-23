/**
 * Running the plan's programs once when an A2 interview is prepared, and reading what they printed. The runtime result is the truth the
 * student's answer is checked against; the plan's own answer (computed when the plan was built) is only compared with it. When the two
 * differ the question gets a mismatch flag and the interview goes on with the runtime result.
 *
 * A predict question runs one plain copy of the student's code on the question's input. A tracing question runs the plain copy and the
 * trace copy (the code with a breakpoint line that records the traced variables); the K-th stop is the answer. Compile-error and logic
 * questions run nothing. Each function is built from its own parts (the same rules as the plan: the whole file, or the one function
 * with its helpers when the file as a whole did not compile), so the program that runs is the one the plan was built from.
 */
const fs = require('fs');
const path = require('path');
const { programFactory } = require('./program');
const { runAllQuestions } = require('../services/interview-runs');
const { askable } = require('./plan-config');

const ASSETS = path.join(__dirname, 'assets');
let assetsCache;
/** The assignment's official header and the test driver, shipped with the code (assets/ is checked against scripts/eval/a2 by a test). */
function loadAssets() {
  if (!assetsCache) {
    assetsCache = {
      officialHeader: fs.readFileSync(path.join(ASSETS, 'functions.h'), 'utf8'),
      driver: fs.readFileSync(path.join(ASSETS, 'main.cpp'), 'utf8'),
    };
  }
  return assetsCache;
}

const trimmed = (text) => String(text === null || text === undefined ? '' : text).replace(/\r\n/g, '\n').trim();

/**
 * One list of runs per asked question (what runAllQuestions takes), plus per question why nothing is run when the function cannot be built.
 * @returns {{ questions: Array<Array<object>>, notes: Array<string|null> }}
 */
function buildRunQuestions({ plan, record, code, studentHeader, assets = loadAssets() }) {
  const factory = programFactory({ record, code, studentHeader, officialHeader: assets.officialHeader });
  const questions = [];
  const notes = [];
  askable(plan).forEach((q) => {
    if (q.kind !== 'predict' && q.kind !== 'tracing') { questions.push([]); notes.push(null); return; }
    const parts = factory(q.function);
    if (parts.error) { questions.push([]); notes.push(parts.error); return; }
    const stdin = `${q.input.cmd}\n`;
    const runs = [{ label: 'plain', stdin, program: { kind: 'plain', header: parts.header, studentSource: parts.studentSource } }];
    if (q.kind === 'tracing') {
      runs.push({
        label: 'trace',
        stdin,
        program: { kind: 'trace', pauseLine: q.line, variables: (q.variables || []).map((v) => ({ name: v.name, expr: v.expr })), header: parts.header, studentSource: parts.studentSource },
      });
    }
    questions.push(runs);
    notes.push(null);
  });
  return { questions, notes };
}

/**
 * The answer the code gives for one asked question, from its run results (runAllQuestions' entry for that question):
 * { answer: string|null, note: string|null }. null means the runtime could not give one (the note says why).
 */
function answerFromRuns(q, entry) {
  if (q.kind !== 'predict' && q.kind !== 'tracing') return { answer: null, note: null };
  if (!entry) return { answer: null, note: 'no run result' };
  if (entry.errors && entry.errors.length) return { answer: null, note: `${entry.errors[0].kind || 'run'} ${entry.errors[0].stage}: ${entry.errors[0].reason}` };
  const plain = (entry.runs || []).find((r) => r.label === 'plain');
  if (!plain) return { answer: null, note: entry.note || 'the program did not run' };
  if (plain.status !== 'accepted') return { answer: null, note: `the program ended with status ${plain.status}` };
  if (q.kind === 'predict') return { answer: trimmed(plain.stdout), note: null };
  const trace = (entry.runs || []).find((r) => r.label === 'trace');
  if (!trace || !trace.trace) return { answer: null, note: 'the trace copy did not run' };
  if (trimmed(trace.stdout) !== trimmed(plain.stdout)) return { answer: null, note: 'instrumentation changed behavior' };
  const stop = trace.trace.stops[q.k - 1];
  if (!stop) return { answer: null, note: `the breakpoint stopped ${trace.trace.total} times, fewer than ${q.k}` };
  return { answer: stop.text, note: null };
}

/**
 * Run the plan's programs once and fill in what the code answers, per asked question.
 * @returns {Promise<Array<{ answerFromCode: string|null, answerSource: 'runtime'|'plan'|null, mismatch: object|null, runtimeNote: string|null }>>}
 *   answerFromCode is the truth: the runtime result, or (when nothing could be run) the plan's own answer, with a flag that says so.
 */
async function runPlan({ plan, record, code, studentHeader, userId, interviewId, limits, runBatch, countRun, deadlineAt }) {
  const asked = askable(plan);
  const { questions, notes } = buildRunQuestions({ plan, record, code, studentHeader });
  const assets = loadAssets();
  const observed = await runAllQuestions({
    code, questions, userId, interviewId, limits, runBatch, countRun, deadlineAt, harness: { header: assets.officialHeader, driver: assets.driver },
  });
  return asked.map((q, i) => {
    if (q.kind !== 'predict' && q.kind !== 'tracing') return { answerFromCode: null, answerSource: null, mismatch: null, runtimeNote: null };
    const result = answerFromRuns(q, observed[i]);
    const planAnswer = q.answer === undefined || q.answer === null ? null : trimmed(q.answer);
    if (result.answer === null) {
      const why = notes[i] || result.note || (observed[i] && observed[i].note) || 'the program could not be run';
      // The plan's own answer is used, and the flag says the runtime could not confirm it.
      return { answerFromCode: planAnswer, answerSource: planAnswer === null ? null : 'plan', mismatch: { kind: 'runtime_unavailable', planAnswer, runtimeAnswer: null }, runtimeNote: why };
    }
    const differs = planAnswer !== null && planAnswer !== trimmed(result.answer);
    return {
      answerFromCode: trimmed(result.answer),
      answerSource: 'runtime',
      mismatch: differs ? { kind: 'runtime_differs_from_plan', planAnswer, runtimeAnswer: trimmed(result.answer) } : null,
      runtimeNote: null,
    };
  });
}

module.exports = { buildRunQuestions, answerFromRuns, runPlan, loadAssets };
