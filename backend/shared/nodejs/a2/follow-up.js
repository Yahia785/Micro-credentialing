/**
 * The follow-up of an A2 interview question, chosen after the correct / wrong check of the main answer.
 *
 *   correct          the plan's fixed follow-up for the function, word for word (when the question has one: compile-error and logic
 *                    questions do not)
 *   wrong / unclear  ONE follow-up written by the agent, to find where the student's reasoning went off. It is written by the same
 *                    writer as host.v6 (split-agent-v6.writeFollowUp) with the correct answer as a private rubric item, so the same
 *                    checks apply: one question, not yes/no, no rubric wording, nothing that states the private item. On top of
 *                    that the question is refused when it contains the correct answer itself. It never carries the code's output
 *                    (observed behavior is left out on purpose: for a student who predicted wrong it would give the answer away).
 *
 * A follow-up is never followed by another one. When the agent cannot write an acceptable follow-up the interview moves on (the log says why).
 */
const splitV6 = require('../agent/split-agent-v6');
const { normalize } = require('./check');

const SOURCE = Object.freeze({ FIXED: 'fixed', AGENT: 'agent' });
const PRIVATE_ITEM_ID = 'r1';

/** The private rubric item of a question: what a correct answer says. It is only ever shown to the writer as private guidance. */
function privateItem(q, truth) {
  const text = q.kind === 'predict' ? `The result for this input is ${truth}.`
    : q.kind === 'tracing' ? `At that stop the values are ${truth}.`
      : q.kind === 'compileError' || q.kind === 'compileErrorOutside' ? `The compiler reports: ${q.answerKey}`
        : `The correct result for this input is ${q.answerKey}.`;
  return { id: PRIVATE_ITEM_ID, text };
}

/** The values of an expected answer as they would appear in a question (empty when too short to tell: a lone digit is in every input). */
function revealsAnswer(question, mainQuestion, q, truth) {
  const key = q.kind === 'predict' || q.kind === 'tracing' ? truth : q.answerKey;
  const expected = normalize(key);
  if (expected.length < 3) return false;
  const asked = ` ${normalize(question)} `;
  const main = ` ${normalize(mainQuestion)} `;
  return asked.includes(` ${expected} `) && !main.includes(` ${expected} `);
}

/**
 * The fixed follow-up of a correct answer, or null. Entries without a question are ignored.
 * @returns {{ source: 'fixed', text: string, answerKey: string }|null}
 */
function fixedFollowUpFor(q) {
  const fixed = q.fixedFollowUp;
  if (!fixed || typeof fixed.question !== 'string' || !fixed.question.trim()) return null;
  return { source: SOURCE.FIXED, text: fixed.question.trim(), answerKey: String(fixed.answerKey || '') };
}

/**
 * One follow-up written by the agent for a wrong or unclear answer.
 * @returns {Promise<{ ok: true, source: 'agent', text: string, isHint: boolean, calls: object[], usage: object, repairs: object[] }
 *                  | { ok: false, reason: string, calls: object[], usage: object, repairs: object[] }>}
 */
async function writeAgentFollowUp({ converseFn, writerModelId, code, turns, q, truth }) {
  const item = privateItem(q, truth);
  const unfinished = q.kind === 'compileError' || q.kind === 'compileErrorOutside' || q.kind === 'logic';
  const written = await splitV6.writeFollowUp({
    converseFn,
    modelId: writerModelId,
    code,
    turns,
    mainQuestion: q.text,
    rubric: [item],
    missing: [PRIVATE_ITEM_ID],
    criteria: [],
    // The code does not compile: the writer asks about the intended design, never what the program prints (write.v2 rule 8).
    codeStatus: unfinished ? { compiles: false, stubs: [], unfinished: true } : null,
    observed: [],
    noUsableAnswer: false,
    mode: 'v6',
  });
  const base = { calls: written.calls || [], usage: written.usage, repairs: written.repairs || [] };
  if (written.unavailable) return { ok: false, reason: 'the writer model was not available', ...base };
  if (!written.ok) return { ok: false, reason: `the follow-up was refused (${written.error})`, ...base };
  if (revealsAnswer(written.question, q.text, q, truth)) return { ok: false, reason: 'the follow-up contained the answer', ...base };
  return { ok: true, source: SOURCE.AGENT, text: written.question, isHint: written.isHint === true, ...base };
}

module.exports = { SOURCE, fixedFollowUpFor, writeAgentFollowUp, revealsAnswer, privateItem };
