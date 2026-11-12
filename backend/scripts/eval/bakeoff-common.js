/**
 * Shared parts of the two bake-off scripts (bakeoff-check.js, bakeoff-write.js): the models and their prices, the
 * model caller (it accepts the inference profiles that Claude needs, which the agent's own client refuses), the
 * evidence check for the checker's reply, the reference answer sets and the comparison numbers.
 * Nothing here is used by the interview agent or the evaluation.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const bedrock = require('../../shared/nodejs/agent/bedrock-client');
const { parseCsvObjects } = require('./csv');
const { loadCase } = require('./cases');
const { RUN_PROFILES, buildProfile } = require('./students');

const REGION = 'us-east-1';
const BACKEND = path.resolve(__dirname, '../..');
const DEMO_FILE = path.join(BACKEND, 'eval-results', 'demo', 'demo-case4-host.v4.1-2026-11-03T13-54-38-889Z.json');
const LABELS_FILE = path.join(BACKEND, 'eval-results', '2026-11-02T20-53-51-825Z', 'rubric-check-blind.csv');
const SETS = Object.freeze(['demo', 'scripted', 'claude-labels']);

/**
 * USD per million tokens from the AWS Price List API for us-east-1 (on-demand, 2026-11-03). Claude is called through the
 * US geographic inference profile (us.*), whose price includes the regional premium.
 */
const MODELS = Object.freeze({
  'qwen3-coder-30b': { modelId: 'qwen.qwen3-coder-30b-a3b-v1:0', label: 'Qwen3 Coder 30B A3B (current)', input: 0.15, output: 0.6 },
  'mistral-large-3': { modelId: 'mistral.mistral-large-3-675b-instruct', label: 'Mistral Large 3', input: 0.5, output: 1.5 },
  'qwen3-vl-235b': { modelId: 'qwen.qwen3-vl-235b-a22b', label: 'Qwen3 VL 235B A22B (largest Qwen3 here)', input: 0.53, output: 2.66 },
  'deepseek-v3.2': { modelId: 'deepseek.v3.2', label: 'DeepSeek v3.2', input: 0.62, output: 1.85 },
  'claude-haiku-5.5': { modelId: 'us.anthropic.claude-haiku-5-5', label: 'Claude Haiku 5.5 (small, fast)', input: 0.11, output: 0.55 },
  'claude-sonnet-5.5': { modelId: 'us.anthropic.claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (mid-size)', input: 2.2, output: 11 },
});
const isClaude = (key) => /^claude/.test(key);

const costOf = (model, inputTokens, outputTokens) => (inputTokens * model.input + outputTokens * model.output) / 1e6;

// ---------------------------------------------------------------------------------------------
// The model caller
// ---------------------------------------------------------------------------------------------

let client;
function getClient() {
  if (!client) {
    // Same SDK as the agent's client; resolved from the shared layer's node_modules.
    const { BedrockRuntimeClient } = require(require.resolve('@aws-sdk/client-bedrock-runtime', { paths: [path.resolve(BACKEND, 'shared/nodejs')] }));
    client = new BedrockRuntimeClient({ region: REGION, maxAttempts: 2 });
  }
  return client;
}

/**
 * One Converse call to any model id (profile ids included). Returns { text, inputTokens, outputTokens, latencyMs }.
 * Only text blocks are read; a reasoning block, if the model sends one, is ignored. Throws an Error whose `name` is the SDK error class.
 */
async function converseAny({ modelId, system, messages, maxTokens = 600, temperature = 0, timeoutMs = 60000 }) {
  const { ConverseCommand } = require(require.resolve('@aws-sdk/client-bedrock-runtime', { paths: [path.resolve(BACKEND, 'shared/nodejs')] }));
  const started = Date.now();
  const response = await getClient().send(
    new ConverseCommand({ modelId, system: [{ text: system }], messages, inferenceConfig: { maxTokens, temperature } }),
    { abortSignal: AbortSignal.timeout(timeoutMs) }
  );
  const text = (response.output?.message?.content || []).map((b) => b.text || '').join('').trim();
  if (!text) { const e = new Error('empty response'); e.name = 'EmptyResponse'; throw e; }
  return { text, inputTokens: response.usage?.inputTokens || 0, outputTokens: response.usage?.outputTokens || 0, latencyMs: Date.now() - started };
}

/** A caller for one model: retries a throttled call once and keeps running totals. */
function makeCaller(key, { call = converseAny, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const model = MODELS[key];
  const totals = { calls: 0, inputTokens: 0, outputTokens: 0, errors: {} };
  async function converse(request) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await call({ modelId: model.modelId, temperature: 0, ...request });
        totals.calls += 1;
        totals.inputTokens += result.inputTokens;
        totals.outputTokens += result.outputTokens;
        return result;
      } catch (error) {
        const throttled = /Throttl|TooManyRequests/i.test(error.name);
        if (throttled && attempt === 1) { await sleep(3000); continue; }
        totals.errors[error.name] = (totals.errors[error.name] || 0) + 1;
        throw error;
      }
    }
  }
  return { key, model, converse, totals };
}

// ---------------------------------------------------------------------------------------------
// The checker prompt, its message and the evidence check
// ---------------------------------------------------------------------------------------------

// The checker prompt, its message and the evidence check live in the engine (shared/nodejs/agent/rubric-check.js): host.v5 uses them too.
const { CHECK_PROMPT_VERSION, CHECK_SYSTEM, buildCheckMessage, validateCheck, squash } = require('../../shared/nodejs/agent/rubric-check');

// ---------------------------------------------------------------------------------------------
// The reference answer sets
// ---------------------------------------------------------------------------------------------

const gapToRubric = (id) => id.replace(/^g/, 'r');

/** "r1: text | r2: text" as [{ id, text }]. */
function parseRubricCell(cell) {
  return String(cell).split(/\s\|\s(?=r\d+: )/).map((part) => {
    const m = /^(r\d+): ([\s\S]*)$/.exec(part.trim());
    if (!m) throw new Error(`Cannot read the rubric item "${part.slice(0, 40)}"`);
    return { id: m[1], text: m[2] };
  });
}

/** The wording of the tank questions before the settings were named (LOW, HIGH, MAX): the CSV of labels was written with it. */
const LEGACY_QUESTIONS = [
  'With settings 20, 80, 100, walk me through what your controller does for the readings 50, 18, 40, 85, 70, 15, and how many times the pump starts.',
  'Why does the controller use two levels, 20 and 80, instead of switching the pump at a single level like 50?',
  'Suppose the controller is FILLING and the next reading is -5. What happens, and what happens with the readings after that?',
  'If the check `reading >= s.high` were changed to `reading > s.high`, what would change in the output?',
];

/** The 5 main answers of the demo transcript, each with no item missing. */
function loadDemoSet(file = DEMO_FILE) {
  const demo = JSON.parse(fs.readFileSync(file, 'utf8'));
  const caseData = loadCase(demo.caseId);
  const mains = demo.turns.filter((t) => t.role === 'host' && t.kind === 'main');
  const answers = demo.turns.filter((t) => t.role === 'student' && t.kind === 'main');
  return answers.map((turn, i) => ({
    set: 'demo',
    id: `D${i + 1}`,
    caseId: demo.caseId,
    mainOrdinal: i,
    // The case's current wording (the transcript has the wording of before the settings were named; the rubric is the same).
    question: caseData.mains[i].question,
    rubric: caseData.mains[i].rubric,
    answer: turn.text,
    reference: [],
  }));
}

/** Every distinct scripted main answer of cases 4 and 5, with the gaps it leaves (g1 = r1, ...). */
function loadScriptedSet(caseIds = ['case4', 'case5']) {
  const items = [];
  const seen = new Set();
  for (const caseId of caseIds) {
    const caseData = loadCase(caseId);
    for (const profile of RUN_PROFILES) {
      const history = buildProfile(caseData.studentsRaw, profile, caseData.mains);
      history.forEach((entry, ordinal) => {
        const key = `${caseId}|${ordinal}|${entry.main.text}`;
        if (seen.has(key)) return;
        seen.add(key);
        items.push({
          set: 'scripted',
          id: `S${items.length + 1}`,
          caseId,
          profile,
          mainOrdinal: ordinal,
          question: caseData.mains[ordinal].question,
          rubric: caseData.mains[ordinal].rubric,
          answer: entry.main.text,
          reference: entry.main.gaps.map(gapToRubric),
        });
      });
    }
  }
  return items;
}

/**
 * The 40 answers of rubric-check-blind.csv. Their labels (the human_missing column) were written by Claude, not by a person, so this
 * set is called "claude-labels". The reference is that column ("r1 r3", or "none").
 */
function loadClaudeLabelsSet(file = LABELS_FILE) {
  return parseCsvObjects(fs.readFileSync(file, 'utf8')).map((row) => {
    const rubric = parseRubricCell(row.rubric_items);
    const label = String(row.human_missing || '').trim().toLowerCase();
    if (!label) throw new Error(`${row.id}: the label (human_missing column) is empty`);
    const reference = label === 'none' ? [] : label.split(/[\s,]+/).filter(Boolean);
    if (reference.some((id) => !rubric.some((item) => item.id === id))) throw new Error(`${row.id}: label "${label}" names an unknown item`);
    const caseData = loadCase(row.case);
    const mainOrdinal = caseData.mains.findIndex((m) => m.question === row.main_question || LEGACY_QUESTIONS.includes(row.main_question) && LEGACY_QUESTIONS.indexOf(row.main_question) === caseData.mains.indexOf(m));
    return {
      set: 'claude-labels', id: row.id, caseId: row.case, mainOrdinal, question: row.main_question, rubric, answer: row.student_answer, reference,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

/** One checked answer against its reference: exact match, items called missing that the reference shows, and the reverse. */
function compareMissing(missing, reference) {
  const falseMissing = missing.filter((id) => !reference.includes(id));
  const missed = reference.filter((id) => !missing.includes(id));
  return { exact: falseMissing.length === 0 && missed.length === 0, falseMissing, missed };
}

const median = (values) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * Per variant and reference set: answers, valid replies, exact match, false-missing and missed items (and how many items
 * were compared), invalid replies, cost per 100 checks and median latency. `records` are { set, valid, missing, reference, cost, latencyMs }.
 */
function summarise(records) {
  const out = {};
  for (const set of SETS) {
    const rows = records.filter((r) => r.set === set && !r.repeat);
    if (!rows.length) continue;
    const valid = rows.filter((r) => r.valid);
    let exact = 0; let falseMissing = 0; let missed = 0; let items = 0; let shownRef = 0; let missingRef = 0;
    valid.forEach((r) => {
      const c = compareMissing(r.missing, r.reference);
      if (c.exact) exact += 1;
      falseMissing += c.falseMissing.length;
      missed += c.missed.length;
      items += r.rubricSize;
      missingRef += r.reference.length;
      shownRef += r.rubricSize - r.reference.length;
    });
    const all = records.filter((r) => r.set === set);
    out[set] = {
      answers: rows.length,
      invalid: rows.length - valid.length,
      exact, exactRate: rows.length ? exact / rows.length : null,
      falseMissing, falseMissingOutOf: shownRef,
      missed, missedOutOf: missingRef,
      items,
      costPer100: all.length ? (all.reduce((a, r) => a + r.cost, 0) / all.length) * 100 : null,
      medianLatencyMs: median(all.map((r) => r.latencyMs)),
    };
  }
  return out;
}

/**
 * The best variant by the checker results: the most exact matches on the scripted set (the reference that is not Claude's); only
 * a tie there is broken by the claude-labels set (exact matches), then by the fewest false-missing items on the scripted set.
 * `candidates` limits the choice.
 */
function pickBest(results, candidates) {
  const rate = (variant, set) => {
    const s = (results[variant].summary || {})[set];
    return s && s.answers ? s.exact / s.answers : -1;
  };
  const falseMissing = (variant) => ((results[variant].summary || {}).scripted || { falseMissing: 0 }).falseMissing;
  const ranked = candidates.filter((c) => results[c]).sort((a, b) => (
    rate(b, 'scripted') - rate(a, 'scripted') || rate(b, 'claude-labels') - rate(a, 'claude-labels') || falseMissing(a) - falseMissing(b)
  ));
  return ranked[0] || null;
}

const hash = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

module.exports = {
  REGION, DEMO_FILE, LABELS_FILE, SETS, MODELS, isClaude, costOf, converseAny, makeCaller,
  CHECK_PROMPT_VERSION, CHECK_SYSTEM, buildCheckMessage, validateCheck, squash,
  gapToRubric, parseRubricCell, loadDemoSet, loadScriptedSet, loadClaudeLabelsSet,
  compareMissing, median, summarise, pickBest, hash,
};
