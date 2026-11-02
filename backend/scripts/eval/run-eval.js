#!/usr/bin/env node
/**
 * Automated evaluation of the Host agent.
 *
 * Runs scripted students through the real interview service (services/interview-service.js, the code
 * the endpoints use) with a simulated clock, for each prompt version, case, profile and repeat, then
 * measures how the Host behaved. Only DynamoDB is replaced, with an in-memory store.
 *
 *   node scripts/eval/run-eval.js --fake-model --prompts host.v2,host.v3 --yes
 *   node scripts/eval/run-eval.js --prompts host.v1,host.v2,host.v3 --cases all --profiles all --repeats 3
 *
 * See scripts/eval/README.md for the options and the metrics.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

const engine = require('../../shared/nodejs/agent/interview-engine');
const bedrock = require('../../shared/nodejs/agent/bedrock-client');
const stores = require('./fake-stores');
const { createFakeModel } = require('./fake-model');
const { createFakeJudge } = require('./fake-judge');
const { createFixedModel, ARM: FIXED_ARM } = require('./fixed-baseline');
const judging = require('./judge');
const { caseIds, loadCase } = require('./cases');
const { RUN_PROFILES, GAMING_PROFILES, validateStudents, buildProfile, pairsFor } = require('./students');
const metrics = require('./metrics');
const adaptive = require('./adaptive');
const { writeReports, toJudgeSampleCsv, terminalSummary } = require('./report');

const T0 = Date.parse('2026-01-01T09:00:00.000Z'); // simulated start of every interview
const MAX_ANSWERS = 60; // safety stop, far above any real interview

// ---------------------------------------------------------------------------------------------
// Wiring: run the real service against the in-memory stores
// ---------------------------------------------------------------------------------------------

/**
 * Make the service's database and logger imports resolve to the in-memory stores. Under Jest the
 * test does this with jest.mock instead.
 */
function installFakeStores() {
  if (process.env.JEST_WORKER_ID) return;
  const base = path.resolve(__dirname, '../../shared/nodejs');
  const inject = (file, exports) => {
    const id = require.resolve(path.join(base, file));
    require.cache[id] = { id, filename: id, loaded: true, exports, children: [], paths: [] };
  };
  inject('db/interviews.js', stores.interviews);
  inject('db/submissions.js', stores.submissions);
  inject('db/milestones.js', stores.milestones);
  inject('utils/logger.js', stores.logger);
}

let cachedService;
function loadService() {
  if (!cachedService) {
    installFakeStores();
    cachedService = require('../../shared/nodejs/services/interview-service');
  }
  return cachedService;
}

/**
 * Wrap a model function: pause before every call, retry once on throttling, and keep a record of
 * each call (attempts, retries, whether it finally failed because of throttling, tokens, latency).
 */
function withRetry(base, { calls, sleep, delayMs, retryDelayMs }) {
  return async function converse(request) {
    const record = {
      attempts: 0, throttleRetries: 0, throttled: false, errorName: null,
      inputTokens: 0, outputTokens: 0, latencyMs: 0,
    };
    calls.push(record);
    if (delayMs > 0) await sleep(delayMs);

    for (;;) {
      record.attempts += 1;
      try {
        const result = await base(request);
        record.inputTokens = result.inputTokens || 0;
        record.outputTokens = result.outputTokens || 0;
        record.latencyMs = result.latencyMs || 0;
        return result;
      } catch (error) {
        const throttle = error.name === 'ModelUnavailableError' && metrics.isThrottleError(error.reason);
        if (throttle && record.attempts === 1) {
          record.throttleRetries += 1;
          if (retryDelayMs > 0) await sleep(retryDelayMs);
          continue;
        }
        record.errorName = error.reason || error.name;
        record.throttled = throttle;
        throw error;
      }
    }
  };
}

// ---------------------------------------------------------------------------------------------
// One interview
// ---------------------------------------------------------------------------------------------

const callSummary = (call) => (call ? { ...call } : null);

/** Register the code and interview config the service reads, and build the model function for an arm. */
function setUpInterview({ caseData, submissionId, promptVersion, opts, ctx }) {
  const userId = 'eval-student';
  const milestoneId = `milestone_${caseData.id}`;
  stores.reset();
  stores.submissions.register({
    submissionId, userId, milestoneId, language: 'cpp', status: 'passed', endedBy: 'submit_button', code: caseData.code,
  });
  stores.milestones.register({ milestoneId, language: 'cpp', interview: caseData.config });

  const calls = [];
  let converseFn;
  if (promptVersion === FIXED_ARM) {
    // No model: the fixed question is asked after every main answer. Nothing is sent to Bedrock.
    converseFn = createFixedModel({ fixedFollowUps: caseData.fixedFollowUps, getMainOrdinal: () => ctx.mainOrdinal });
  } else {
    const base = opts.fakeModel ? createFakeModel({ seed: opts.seed, chaos: opts.fakeChaos }) : bedrock.converse;
    converseFn = withRetry(base, { calls, sleep: opts.sleep, delayMs: opts.delayMs, retryDelayMs: opts.retryDelayMs });
  }
  return { userId, calls, converseFn };
}

/** Point the service at the arm's prompt version (and the Bedrock model); returns the function that undoes it. */
function useEnv(promptVersion, opts) {
  const saved = { prompt: process.env.AGENT_PROMPT_VERSION, model: process.env.AGENT_MODEL_ID };
  process.env.AGENT_PROMPT_VERSION = promptVersion === FIXED_ARM ? engine.PROMPT_VERSION : promptVersion;
  if (!opts.fakeModel) process.env.AGENT_MODEL_ID = opts.modelId;
  return () => {
    if (saved.prompt === undefined) delete process.env.AGENT_PROMPT_VERSION;
    else process.env.AGENT_PROMPT_VERSION = saved.prompt;
    if (saved.model === undefined) delete process.env.AGENT_MODEL_ID;
    else process.env.AGENT_MODEL_ID = saved.model;
  };
}

const modelIdOf = (promptVersion, opts) => {
  if (promptVersion === FIXED_ARM) return 'fixed-baseline';
  return opts.fakeModel ? 'fake-model' : opts.modelId;
};

async function runInterview({ caseData, profileName, answers, promptVersion, repeat, opts }) {
  const service = loadService();
  const submissionId = `eval_${caseData.id}_${profileName}_${promptVersion.replace('.', '')}_r${repeat}`;
  const answerMs = opts.answerSeconds * 1000;
  const ctx = { mainOrdinal: 0 };
  const { userId, calls, converseFn } = setUpInterview({ caseData, submissionId, promptVersion, opts, ctx });

  const transcript = {
    schema: 2,
    runId: opts.runId,
    promptVersion,
    caseId: caseData.id,
    profile: profileName,
    repeat,
    modelId: modelIdOf(promptVersion, opts),
    budget: engine.followUpBudget(caseData.config),
    mains: caseData.mains.length,
    simulatedAnswerSeconds: opts.answerSeconds,
    status: 'error',
    error: null,
  };
  const steps = []; // one per answer sent: what was scripted and which model call it triggered
  let interviewId = null;

  const restoreEnv = useEnv(promptVersion, opts);

  try {
    const started = await service.startInterview({ userId, submissionId, now: T0 });
    interviewId = started.interviewId;

    for (let k = 1; k <= MAX_ANSWERS; k += 1) {
      const turns = await stores.interviews.getInterviewTurns(interviewId);
      const asked = turns[turns.length - 1];
      const mainOrdinal = turns.filter((t) => t.role === 'host' && t.kind === 'main').length - 1;
      const entry = answers[mainOrdinal];
      if (!entry) throw new Error('No scripted answer for this question');
      const answerType = asked.kind === 'main' ? 'main' : 'followUp';
      const answer = entry[answerType];
      ctx.mainOrdinal = mainOrdinal;

      const callsBefore = calls.length;
      const result = await service.submitAnswer({
        userId, interviewId, answer: answer.text, clientTiming: {}, now: T0 + k * answerMs, converseFn,
      });
      steps.push({
        scripted: { profile: profileName, source: entry.source, label: answer.label, gap: answer.gap, answerType, mainOrdinal },
        call: calls[callsBefore] || null,
        status: result.ended ? result.status : null,
      });
      if (result.ended) break;
    }
  } catch (error) {
    transcript.error = error.name === 'ModelUnavailableError' ? 'ModelUnavailableError' : `${error.name}: ${error.message}`;
  } finally {
    restoreEnv();
  }

  if (interviewId) await assemble(transcript, interviewId, steps);
  transcript.calls = calls.map(callSummary);
  return transcript;
}

// ---------------------------------------------------------------------------------------------
// One minimal-pair interview
// ---------------------------------------------------------------------------------------------

// The earlier questions of a pair interview are answered by the strong student and the Host's reply
// is fixed, so both variants of a pair reach the question with exactly the same history and the
// only model call is the decision after the pair's answer.
const SEEDED_REPLY = {
  text: JSON.stringify({ action: 'next_main', question: '', reason: 'Seeded history: earlier answers in a pair interview are scripted.' }),
  inputTokens: 0, outputTokens: 0, latencyMs: 0,
};
const seededConverse = async () => SEEDED_REPLY;

async function runPairInterview({ caseData, mainOrdinal, pair, side, promptVersion, repeat, opts }) {
  const service = loadService();
  const label = `${pair.id}${side}`;
  const submissionId = `pair_${caseData.id}_q${mainOrdinal + 1}_${label}_${promptVersion.replace('.', '')}_r${repeat}`;
  const answerMs = opts.answerSeconds * 1000;
  const ctx = { mainOrdinal };
  const { userId, calls, converseFn } = setUpInterview({ caseData, submissionId, promptVersion, opts, ctx });
  const history = buildProfile(caseData.studentsRaw, 'strong', caseData.mains);
  const variant = pair[side];

  const transcript = {
    schema: 2,
    kind: 'pair',
    runId: opts.runId,
    promptVersion,
    caseId: caseData.id,
    profile: 'pair',
    repeat,
    modelId: modelIdOf(promptVersion, opts),
    budget: engine.followUpBudget(caseData.config),
    mains: caseData.mains.length,
    simulatedAnswerSeconds: opts.answerSeconds,
    pair: { pairId: pair.id, side, mainOrdinal, gap: variant.gap },
    status: 'error',
    error: null,
  };
  const steps = [];
  let interviewId = null;
  const restoreEnv = useEnv(promptVersion, opts);

  try {
    const started = await service.startInterview({ userId, submissionId, now: T0 });
    interviewId = started.interviewId;

    for (let k = 0; k < mainOrdinal; k += 1) {
      await service.submitAnswer({
        userId, interviewId, answer: history[k].main.text, clientTiming: {}, now: T0 + (k + 1) * answerMs, converseFn: seededConverse,
      });
      steps.push({ scripted: { profile: 'pair', source: 'strong', label: 'good', answerType: 'main', mainOrdinal: k, seeded: true }, call: null, status: null });
    }
    const result = await service.submitAnswer({
      userId, interviewId, answer: variant.text, clientTiming: {}, now: T0 + (mainOrdinal + 1) * answerMs, converseFn,
    });
    steps.push({
      scripted: { profile: 'pair', pairId: pair.id, side, label: 'vague', gap: variant.gap, answerType: 'main', mainOrdinal },
      call: calls[0] || null,
      status: result.ended ? result.status : null,
    });
  } catch (error) {
    transcript.error = error.name === 'ModelUnavailableError' ? 'ModelUnavailableError' : `${error.name}: ${error.message}`;
  } finally {
    restoreEnv();
  }

  if (interviewId) await assemble(transcript, interviewId, steps);
  // The interview is deliberately left open after the decision: that is the end of a pair.
  if (transcript.error === 'interview did not finish') {
    transcript.error = null;
    transcript.status = 'pair';
  }
  transcript.calls = calls.map(callSummary);
  return transcript;
}

/** Copy the stored interview into the transcript and attach what the runner knows about each turn. */
async function assemble(transcript, interviewId, steps) {
  const meta = await stores.interviews.getInterviewMeta(interviewId);
  const stored = await stores.interviews.getInterviewTurns(interviewId);

  let studentIndex = -1;
  let mainOrdinal = -1;
  const turns = stored.map(({ interviewId: _id, sk: _sk, ...turn }) => {
    if (turn.role === 'student') {
      studentIndex += 1;
      return { ...turn, scripted: steps[studentIndex].scripted };
    }
    if (turn.kind === 'main') mainOrdinal += 1;
    const step = steps[studentIndex];
    return {
      ...turn,
      mainOrdinal,
      ...(studentIndex >= 0 && step && step.call && { modelCall: callSummary(step.call) }),
    };
  });

  transcript.turns = turns;
  transcript.startedAt = meta.startedAt;
  transcript.deadline = meta.deadline;
  transcript.endedAt = meta.endedAt || null;
  transcript.endReason = meta.endReason || null;
  transcript.fallbackCount = meta.fallbackCount;
  transcript.promptVersionStored = meta.promptVersion;

  if (meta.status === 'completed' || meta.status === 'timed_out') {
    transcript.status = meta.status;
    transcript.error = null;
  } else if (!transcript.error) {
    transcript.error = 'interview did not finish';
  }
  if (meta.endDetail) transcript.endDetail = meta.endDetail;
  if (meta.status === 'completed' && steps.length) {
    const last = steps[steps.length - 1];
    if (last.call) transcript.endModelCall = callSummary(last.call);
  }
  if (meta.status === 'timed_out' && steps.length) {
    const last = steps[steps.length - 1];
    transcript.timedOutOnAnswer = { label: last.scripted.label, mainOrdinal: last.scripted.mainOrdinal };
  }
}

// ---------------------------------------------------------------------------------------------
// The whole run
// ---------------------------------------------------------------------------------------------

function splitList(value, all, label) {
  if (value === undefined || value === 'all') return [...all];
  const items = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = items.filter((i) => !all.includes(i));
  if (unknown.length) throw new Error(`Unknown ${label}: ${unknown.join(', ')}. Available: ${all.join(', ')}`);
  return items;
}

function normalizeOptions(raw) {
  const runId = raw.runId || new Date().toISOString().replace(/[:.]/g, '-');
  const fakeModel = !!raw.fakeModel;
  const repeats = Number(raw.repeats === undefined ? 1 : raw.repeats);
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error('--repeats must be a whole number of at least 1');

  if (raw.baseline !== undefined && raw.baseline !== FIXED_ARM) throw new Error(`--baseline must be "${FIXED_ARM}"`);
  const judge = !!raw.judge;
  const judgeSample = Number(raw.judgeSample === undefined ? 30 : raw.judgeSample);
  if (!Number.isInteger(judgeSample) || judgeSample < 0) throw new Error('--judge-sample must be a whole number of 0 or more');
  const modelId = fakeModel ? 'fake-model' : bedrock.resolveModelId(raw.model);
  const judgeModelId = fakeModel ? 'fake-judge' : bedrock.resolveModelId(raw.judgeModel || judging.DEFAULT_JUDGE_MODEL);
  if (judge && !fakeModel && judgeModelId === modelId) {
    throw new Error('The judge must be a different model from the Host. Pass another one with --judge-model.');
  }
  const prompts = splitList(raw.prompts === undefined ? engine.PROMPT_VERSION : raw.prompts, engine.PROMPT_VERSIONS, 'prompt version');

  return {
    runId,
    prompts,
    baseline: raw.baseline || null,
    arms: raw.baseline ? [...prompts, FIXED_ARM] : prompts,
    pairs: !raw.noPairs,
    judge,
    judgeModelId,
    judgeSample,
    judgePrices: {
      inputPerMillion: Number(raw.judgePriceIn === undefined ? judging.DEFAULT_JUDGE_PRICES.inputPerMillion : raw.judgePriceIn),
      outputPerMillion: Number(raw.judgePriceOut === undefined ? judging.DEFAULT_JUDGE_PRICES.outputPerMillion : raw.judgePriceOut),
    },
    cases: splitList(raw.cases, caseIds(), 'case'),
    profiles: splitList(raw.profiles, RUN_PROFILES, 'profile'),
    repeats,
    out: path.resolve(raw.out || path.join(__dirname, '../../eval-results', runId)),
    fakeModel,
    fakeChaos: raw.fakeChaos === undefined ? 0.26 : Number(raw.fakeChaos),
    seed: raw.seed === undefined ? 1 : raw.seed,
    yes: !!raw.yes,
    modelId,
    answerSeconds: Number(raw.answerSeconds === undefined ? 30 : raw.answerSeconds),
    delayMs: Number(raw.delayMs === undefined ? (fakeModel ? 0 : 500) : raw.delayMs),
    retryDelayMs: Number(raw.retryDelayMs === undefined ? (fakeModel ? 0 : 3000) : raw.retryDelayMs),
    prices: {
      inputPerMillion: Number(raw.priceIn === undefined ? metrics.DEFAULT_PRICES.inputPerMillion : raw.priceIn),
      outputPerMillion: Number(raw.priceOut === undefined ? metrics.DEFAULT_PRICES.outputPerMillion : raw.priceOut),
    },
    sleep: raw.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    log: raw.log || console.log,
    confirm: raw.confirm,
  };
}

/**
 * How big the run is. `interviews` counts the scripted interviews over all arms (prompts, and the
 * fixed baseline when asked for); model calls are only made by the prompt versions. When pairs and the
 * judge are on, the minimal-pair interviews and an upper bound for the judge calls are added.
 */
function planOf(opts, loaded) {
  const perCase = opts.cases.map((id) => loaded[id]);
  const arms = opts.arms || opts.prompts;
  const interviews = arms.length * opts.profiles.length * opts.repeats * perCase.length;
  const perInterview = (c) => ({
    min: c.mains.length,
    max: c.mains.length * (1 + engine.followUpBudget(c.config)),
  });
  const total = (pick) => opts.prompts.length * opts.profiles.length * opts.repeats *
    perCase.reduce((acc, c) => acc + perInterview(c)[pick], 0);

  // One pair interview per case, main question, pair and side, per arm and repeat; one model call each.
  const pairVariants = opts.pairs
    ? perCase.reduce((acc, c) => acc + c.mains.reduce((n, _m, i) => n + 2 * pairsFor(c.studentsRaw, i).length, 0), 0)
    : 0;
  const pairInterviews = pairVariants * arms.length * opts.repeats;
  const pairCalls = pairVariants * opts.prompts.length * opts.repeats;

  // The judge sees every follow-up asked after a weak answer: at most one per weak main answer and one per pair interview.
  let judgeCalls = 0;
  if (opts.judge) {
    const weakMains = perCase.reduce((acc, c) => acc + opts.profiles.reduce((n, profile) => n + buildProfile(c.studentsRaw, profile, c.mains)
      .filter((entry) => entry.main.label !== 'good').length, 0), 0);
    judgeCalls = weakMains * arms.length * opts.repeats + pairInterviews;
  }
  return {
    interviews,
    minCalls: total('min') + pairCalls,
    maxCalls: total('max') + pairCalls,
    pairInterviews,
    judgeCalls,
  };
}

async function askToProceed(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// ---------------------------------------------------------------------------------------------
// The judge pass
// ---------------------------------------------------------------------------------------------

const JUDGE_TOKENS = { input: 800, output: 60 }; // typical size of one judge call, for the estimate

/** A small seeded random generator (mulberry32), so the same seed gives the same sample. */
function seededRandom(seed) {
  let a = crypto.createHash('sha256').update(String(seed)).digest().readUInt32BE(0);
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleOf(items, count, seed) {
  const random = seededRandom(`${seed}|judge-sample`);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

/**
 * Ask the judge which gap each follow-up targets, for every follow-up asked right after a scripted
 * answer that has a gap. The judgement is stored on the follow-up turn.
 * @param {Array<{ transcript: object }>} entries
 * @returns {Promise<{ summary: object, items: object[] }>} items are the unique judged inputs, for the sample file
 */
async function judgeTranscripts({ entries, loaded, opts }) {
  const calls = [];
  const converse = opts.fakeModel
    ? createFakeJudge({ seed: opts.seed, chaos: opts.fakeChaos })
    : bedrock.converse;
  const wrapped = withRetry(converse, { calls, sleep: opts.sleep, delayMs: opts.fakeModel ? 0 : opts.delayMs, retryDelayMs: opts.retryDelayMs });
  const judge = judging.createJudge({ modelId: opts.judgeModelId, converseFn: wrapped });

  const items = [];
  let judgements = 0;
  let unjudged = 0;
  for (const { transcript, file } of entries) {
    const caseData = loaded[transcript.caseId];
    const turns = transcript.turns || [];
    for (let i = 1; i < turns.length; i += 1) {
      const turn = turns[i];
      const answerTurn = turns[i - 1];
      if (turn.role !== 'host' || turn.kind !== 'follow_up' || answerTurn.role !== 'student') continue;
      const gap = answerTurn.scripted && answerTurn.scripted.gap;
      if (!gap) continue;
      const ordinal = answerTurn.scripted.mainOrdinal;
      const input = {
        mainQuestion: caseData.mains[ordinal].question,
        answer: answerTurn.text,
        followUp: turn.text,
        gaps: caseData.studentsRaw.gaps[ordinal],
      };
      const result = await judge.judge(input);
      judgements += 1;
      if (!result.valid) unjudged += 1;
      turn.judgement = {
        valid: result.valid,
        target: result.target,
        reason: result.reason,
        ...(result.error && { error: result.error }),
        judgeModel: opts.judgeModelId,
        judgePrompt: judging.JUDGE_PROMPT_VERSION,
      };
      if (result.valid && !result.cached) {
        items.push({ ...input, target: result.target, reason: result.reason, source: file ? path.relative(opts.out, file).split(path.sep).join('/') : '' });
      }
    }
    if (file) fs.writeFileSync(file, JSON.stringify(transcript, null, 2));
  }

  const usage = judge.usage;
  return {
    items,
    summary: {
      model: opts.judgeModelId,
      promptVersion: judging.JUDGE_PROMPT_VERSION,
      judgements,
      unjudged,
      ...usage,
      estimatedCostUsd: judging.estimateJudgeCost(usage, opts.judgePrices),
      prices: opts.judgePrices,
    },
  };
}

async function runEval(rawOptions) {
  const opts = normalizeOptions(rawOptions);
  const log = opts.log;

  const loaded = {};
  for (const id of opts.cases) {
    const caseData = loadCase(id);
    validateStudents(caseData.studentsRaw, caseData.mains.length, id, caseData.mains);
    if (opts.baseline && caseData.fixedFollowUps.length !== caseData.mains.length) {
      throw new Error(`${id}: fixedFollowUps needs ${caseData.mains.length} questions (one per main question) for --baseline fixed`);
    }
    loaded[id] = caseData;
  }

  const plan = planOf(opts, loaded);
  log(`Run ${opts.runId}`);
  log(`  arms: ${opts.arms.join(', ')} | cases: ${opts.cases.join(', ')} | profiles: ${opts.profiles.join(', ')} | repeats: ${opts.repeats}`);
  log(`  ${plan.interviews} interviews, about ${plan.minCalls}-${plan.maxCalls} model calls${opts.fakeModel ? ' (fake model, no Bedrock)' : ` to ${opts.modelId} in us-east-1`}`);
  if (opts.pairs) log(`  plus ${plan.pairInterviews} minimal-pair interviews (one decision each, already counted in the calls above); --no-pairs skips them`);
  if (!opts.fakeModel) {
    const typical = Math.round((plan.minCalls + plan.maxCalls) / 2);
    const cost = metrics.estimateCost(typical * 3500, typical * 120, opts.prices);
    log(`  rough cost for ${typical} calls at ~3,500 input / ~120 output tokens each: $${cost.toFixed(2)} (prices: $${opts.prices.inputPerMillion}/$${opts.prices.outputPerMillion} per million tokens, third-party figure, verify)`);
    log(`  the code and scripted answers are sent to Bedrock; ${opts.delayMs} ms pause before each call`);
  }
  if (opts.judge) {
    if (opts.fakeModel) log(`  judge: fake (no Bedrock), up to ${plan.judgeCalls} judgements`);
    else {
      const judgeCost = judging.estimateJudgeCost({ inputTokens: plan.judgeCalls * JUDGE_TOKENS.input, outputTokens: plan.judgeCalls * JUDGE_TOKENS.output }, opts.judgePrices);
      log(`  judge: ${opts.judgeModelId}, up to ${plan.judgeCalls} judgements at ~${JUDGE_TOKENS.input} input / ~${JUDGE_TOKENS.output} output tokens each: at most $${judgeCost.toFixed(2)} ($${opts.judgePrices.inputPerMillion}/$${opts.judgePrices.outputPerMillion} per million tokens; repeated inputs are reused)`);
      log('  the judge sees the main question, the scripted answer, the follow-up and the gap list. No code.');
      if (judging.sameProvider(opts.judgeModelId, opts.modelId)) {
        log('  warning: the judge and the Host come from the same provider, which can favour the Host\'s own style. Prefer another family.');
      }
    }
  }
  log(`  output: ${opts.out}`);

  if (!opts.yes) {
    const proceed = opts.confirm ? await opts.confirm(plan) : await askToProceed('Proceed? (y/N) ');
    if (!proceed) {
      log('Cancelled. Nothing was run.');
      return { cancelled: true, plan, outDir: opts.out };
    }
  }

  fs.mkdirSync(path.join(opts.out, 'transcripts'), { recursive: true });
  if (opts.pairs) fs.mkdirSync(path.join(opts.out, 'pairs'), { recursive: true });

  const transcripts = [];
  const pairTranscripts = [];
  const files = new Map(); // transcript -> file, so the judge can add its judgements
  const failures = [];
  let done = 0;
  // Repeats outermost and arms innermost, so slow periods and throttling affect every arm alike.
  for (let repeat = 1; repeat <= opts.repeats; repeat += 1) {
    for (const caseId of opts.cases) {
      for (const profileName of opts.profiles) {
        const answers = buildProfile(loaded[caseId].studentsRaw, profileName, loaded[caseId].mains);
        for (const promptVersion of opts.arms) {
          const transcript = await runInterview({
            caseData: loaded[caseId], profileName, answers, promptVersion, repeat, opts,
          });
          transcripts.push(transcript);
          const name = `${promptVersion}__${caseId}__${profileName}__r${repeat}.json`;
          files.set(transcript, path.join(opts.out, 'transcripts', name));
          fs.writeFileSync(files.get(transcript), JSON.stringify(transcript, null, 2));
          if (transcript.status === 'error') failures.push({ file: name, error: transcript.error });
          done += 1;
          log(`[${done}/${plan.interviews}] ${promptVersion} ${caseId} ${profileName} r${repeat}: ${transcript.status}, ${transcript.turns ? transcript.turns.filter((t) => t.role === 'host').length : 0} questions${transcript.error ? ` (${transcript.error})` : ''}`);
        }
      }
    }
  }

  if (opts.pairs) {
    let pairsDone = 0;
    for (let repeat = 1; repeat <= opts.repeats; repeat += 1) {
      for (const caseId of opts.cases) {
        const caseData = loaded[caseId];
        for (let mainOrdinal = 0; mainOrdinal < caseData.mains.length; mainOrdinal += 1) {
          for (const pair of pairsFor(caseData.studentsRaw, mainOrdinal)) {
            for (const side of ['a', 'b']) {
              for (const promptVersion of opts.arms) {
                const transcript = await runPairInterview({ caseData, mainOrdinal, pair, side, promptVersion, repeat, opts });
                pairTranscripts.push(transcript);
                const name = `${promptVersion}__${caseId}__q${mainOrdinal + 1}__${pair.id}${side}__r${repeat}.json`;
                files.set(transcript, path.join(opts.out, 'pairs', name));
                fs.writeFileSync(files.get(transcript), JSON.stringify(transcript, null, 2));
                if (transcript.status === 'error') failures.push({ file: `pairs/${name}`, error: transcript.error });
                pairsDone += 1;
                if (pairsDone % 20 === 0 || pairsDone === plan.pairInterviews) log(`[pairs ${pairsDone}/${plan.pairInterviews}]`);
              }
            }
          }
        }
      }
    }
  }

  let judgeSummary = null;
  let judgeItems = [];
  if (opts.judge) {
    log('Judging follow-ups...');
    const entries = [...transcripts, ...pairTranscripts].map((transcript) => ({ transcript, file: files.get(transcript) }));
    const judged = await judgeTranscripts({ entries, loaded, opts });
    judgeSummary = judged.summary;
    judgeItems = judged.items;
    log(`  ${judgeSummary.judgements} follow-ups judged (${judgeSummary.unjudged} without a usable judgement), ${judgeSummary.calls} judge calls, ${judgeSummary.cached} reused`);
  }

  const results = metrics.summarizeRun(transcripts, opts.prices);
  adaptive.attachAdaptive(results, transcripts, pairTranscripts);
  const totals = Object.values(results).map((r) => r.overall);
  const notes = [];
  if (opts.cases.includes('case1') && opts.prompts.some((p) => p !== 'host.v1')) {
    notes.push('case1 (the linked list) shares code and wording with the examples in host.v2 and host.v3, so those prompts are advantaged there. host.v1 has no examples. Use case2 and case3 for a fair comparison.');
  }
  if (opts.fakeModel) notes.push('Fake model: these numbers test the runner, they say nothing about a real model.');
  if (!opts.judge) notes.push('The judge was not run (--judge), so gap targeting, direction agreement and discrimination are n/a.');
  if (opts.profiles.some((p) => GAMING_PROFILES.includes(p))) {
    notes.push('The gaming profiles are counted in the interview totals, so questions per interview and the cost columns are not directly comparable with runs that left them out.');
  }

  const report = {
    runId: opts.runId,
    options: {
      prompts: opts.prompts, baseline: opts.baseline, cases: opts.cases, profiles: opts.profiles, repeats: opts.repeats,
      fakeModel: opts.fakeModel, modelId: opts.modelId, answerSeconds: opts.answerSeconds, prices: opts.prices,
      pairs: opts.pairs, judge: opts.judge, judgeModel: opts.judge ? opts.judgeModelId : null,
    },
    plan: {
      ...plan,
      actualCalls: totals.reduce((a, s) => a + s.calls, 0) + pairTranscripts.reduce((a, t) => a + (t.calls || []).length, 0),
      actualCostUsd: totals.reduce((a, s) => a + s.estimatedCostUsd, 0),
    },
    pairInterviews: pairTranscripts.length,
    judge: judgeSummary,
    results,
    failures,
    notes,
  };
  writeReports(opts.out, report);

  if (opts.judge && opts.judgeSample > 0) {
    const sample = sampleOf(judgeItems, opts.judgeSample, opts.seed);
    fs.writeFileSync(path.join(opts.out, 'judge-sample.csv'), toJudgeSampleCsv(sample));
    log(`Wrote judge-sample.csv with ${sample.length} judged follow-ups. Fill in the human_target column to measure how often the judge agrees with a person.`);
  }

  log('');
  log(terminalSummary(report));
  log('');
  log(`Done. ${transcripts.length} transcripts${opts.pairs ? `, ${pairTranscripts.length} pair interviews` : ''}, ${failures.length} failed.`);
  log(`Results folder: ${opts.out}`);
  return { cancelled: false, outDir: opts.out, report, transcripts, pairTranscripts };
}

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

const FLAGS = ['fake-model', 'yes', 'judge', 'no-pairs'];
const toCamel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument: ${argv[i]}`);
    const name = argv[i].slice(2);
    if (FLAGS.includes(name)) out[toCamel(name)] = true;
    else {
      if (argv[i + 1] === undefined) throw new Error(`--${name} needs a value`);
      out[toCamel(name)] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

if (require.main === module) {
  runEval(parseArgs(process.argv.slice(2)))
    .then((result) => {
      if (result.cancelled && !process.stdin.isTTY) {
        console.error('Not a terminal, so there was nobody to confirm. Re-run with --yes.');
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error(`Failed: ${error.message}`);
      process.exit(1);
    });
}

module.exports = {
  runEval, runInterview, runPairInterview, normalizeOptions, planOf, parseArgs, withRetry, installFakeStores,
  judgeTranscripts, sampleOf, FIXED_ARM,
};
