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
const splitAgent = require('../../shared/nodejs/agent/split-agent');
const bedrock = require('../../shared/nodejs/agent/bedrock-client');
const stores = require('./fake-stores');
const { createFakeModel } = require('./fake-model');
const { createFakeJudge } = require('./fake-judge');
const { createFixedModel, ARM: FIXED_ARM } = require('./fixed-baseline');
const judging = require('./judge');
const rubricJudging = require('./judge-rubric');
const rubricStats = require('./rubric');
const { caseIds, loadCase } = require('./cases');
const { RUN_PROFILES, EXTRA_PROFILES, GAMING_PROFILES, HEADLINE_EXCLUDED_CASES, validateStudents, buildProfile, pairsFor, pairGapsLeft } = require('./students');
const { createRunSupport } = require('./eval-runs');
const metrics = require('./metrics');
const adaptive = require('./adaptive');
const { writeReports, toJudgeSampleCsv, terminalSummary } = require('./report');
const { sampleFollowUps } = require('./followups');

// USD per million tokens for the split agent's default model (DeepSeek v3.2, AWS Price List API, us-east-1, 2026-11-03); verify.
const SPLIT_PRICES = Object.freeze({ inputPerMillion: 0.62, outputPerMillion: 1.85 });
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

/** host.v6 runs the student's code through these two functions (the real runner with a cache, or the fake); other arms never call them. */
const runArgs = (opts) => (opts.runSupport ? { runBatch: opts.runSupport.runBatch, countRun: opts.runSupport.countRun } : {});

/** Register the code and interview config the service reads, and build the model function for an arm. */
function setUpInterview({ caseData, submissionId, promptVersion, temperature, opts, ctx }) {
  const userId = 'eval-student';
  const milestoneId = `milestone_${caseData.id}`;
  stores.reset();
  stores.submissions.register({
    submissionId, userId, milestoneId, language: 'cpp', status: 'passed', endedBy: 'submit_button', code: caseData.code,
    // what the grader stored, for the cases where it matters (the unfinished-code cases 10 and 11)
    ...(caseData.submission || {}),
  });
  stores.milestones.register({ milestoneId, language: 'cpp', interview: caseData.config });

  const calls = [];
  let converseFn;
  if (promptVersion === FIXED_ARM) {
    // No model: the fixed question is asked after every main answer. Nothing is sent to Bedrock.
    converseFn = createFixedModel({ fixedFollowUps: caseData.fixedFollowUps, getMainOrdinal: () => ctx.mainOrdinal });
  } else {
    const model = opts.fakeModel ? createFakeModel({ seed: opts.seed, chaos: opts.fakeChaos }) : bedrock.converse;
    // The arm's temperature goes with every call to the model (the guard's rewrite too); the engine and the service do not know it.
    const base = temperature === undefined || temperature === null ? model : (request) => model({ ...request, temperature });
    converseFn = withRetry(base, { calls, sleep: opts.sleep, delayMs: opts.delayMs, retryDelayMs: opts.retryDelayMs });
  }
  return { userId, calls, converseFn };
}

/** Point the service at the arm's prompt version (and the Bedrock model); returns the function that undoes it. */
function useEnv(promptVersion, opts) {
  const saved = { prompt: process.env.AGENT_PROMPT_VERSION, model: process.env.AGENT_MODEL_ID };
  process.env.AGENT_PROMPT_VERSION = promptVersion === FIXED_ARM ? engine.PROMPT_VERSION : promptVersion;
  if (!opts.fakeModel) process.env.AGENT_MODEL_ID = opts.modelId;
  const savedSplit = { checker: process.env.AGENT_CHECKER_MODEL_ID, writer: process.env.AGENT_WRITER_MODEL_ID };
  process.env.AGENT_CHECKER_MODEL_ID = opts.checkerModelId;
  process.env.AGENT_WRITER_MODEL_ID = opts.writerModelId;
  const putBack = (name, value) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
  return () => {
    putBack('AGENT_CHECKER_MODEL_ID', savedSplit.checker);
    putBack('AGENT_WRITER_MODEL_ID', savedSplit.writer);
    if (saved.prompt === undefined) delete process.env.AGENT_PROMPT_VERSION;
    else process.env.AGENT_PROMPT_VERSION = saved.prompt;
    if (saved.model === undefined) delete process.env.AGENT_MODEL_ID;
    else process.env.AGENT_MODEL_ID = saved.model;
  };
}

const modelIdOf = (promptVersion, opts) => {
  if (promptVersion === FIXED_ARM) return 'fixed-baseline';
  if (engine.usesSplit(promptVersion)) return `check: ${opts.checkerModelId}, write: ${opts.writerModelId}`;
  return opts.fakeModel ? 'fake-model' : opts.modelId;
};

/**
 * An arm is a prompt version at a temperature (or the fixed baseline). `armOf` fills in the defaults for a plain prompt
 * version: the arm is named after the prompt and runs at the default temperature of that version (0 for the rubric
 * prompts, host.v4 and later; the Bedrock client's default for the others).
 */
const defaultTemperature = (promptVersion) => (engine.usesRubric(promptVersion) ? engine.RUBRIC_PROMPT_TEMPERATURE : bedrock.DEFAULT_TEMPERATURE);
function armOf({ promptVersion, arm, temperature }) {
  if (promptVersion === FIXED_ARM) return { arm: arm || FIXED_ARM, promptVersion, temperature: null };
  return { arm: arm || promptVersion, promptVersion, temperature: temperature === undefined ? defaultTemperature(promptVersion) : temperature };
}
const safeName = (text) => String(text).replace(/[^A-Za-z0-9_-]/g, '');

async function runInterview({ caseData, profileName, answers, promptVersion, arm: armName, temperature: armTemperature, repeat, opts }) {
  const service = loadService();
  const { arm, temperature } = armOf({ promptVersion, arm: armName, temperature: armTemperature });
  const submissionId = `eval_${caseData.id}_${profileName}_${safeName(arm)}_r${repeat}`;
  const answerMs = opts.answerSeconds * 1000;
  const ctx = { mainOrdinal: 0 };
  const { userId, calls, converseFn } = setUpInterview({ caseData, submissionId, promptVersion, temperature, opts, ctx });

  const transcript = {
    schema: 2,
    runId: opts.runId,
    promptVersion,
    arm,
    temperature,
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
    const started = await service.startInterview({ userId, submissionId, now: T0, ...runArgs(opts) });
    interviewId = started.interviewId;
    // The student's page opens the interview once it is created: that is when the clock starts (the real flow).
    await service.getInterview({ userId, interviewId, isAdmin: false, now: T0 });

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
        scripted: {
          profile: profileName, source: entry.source, label: answer.label, gaps: answer.gaps,
          gapCount: caseData.studentsRaw.gaps[mainOrdinal].length, answerType, mainOrdinal,
          ...(answer.ownCode && { ownCode: true }),
          ...(answer.claimsCorrect && { claimsCorrect: true }),
          ...(answer.manipulation && { manipulation: answer.manipulation }),
        },
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

async function runPairInterview({ caseData, mainOrdinal, pair, side, promptVersion, arm: armName, temperature: armTemperature, repeat, opts }) {
  const service = loadService();
  const { arm, temperature } = armOf({ promptVersion, arm: armName, temperature: armTemperature });
  const label = `${pair.id}${side}`;
  const submissionId = `pair_${caseData.id}_q${mainOrdinal + 1}_${label}_${safeName(arm)}_r${repeat}`;
  const answerMs = opts.answerSeconds * 1000;
  const ctx = { mainOrdinal };
  const { userId, calls, converseFn } = setUpInterview({ caseData, submissionId, promptVersion, temperature, opts, ctx });
  const history = buildProfile(caseData.studentsRaw, 'strong', caseData.mains);
  const variant = pair[side];

  const transcript = {
    schema: 2,
    kind: 'pair',
    runId: opts.runId,
    promptVersion,
    arm,
    temperature,
    caseId: caseData.id,
    profile: 'pair',
    repeat,
    modelId: modelIdOf(promptVersion, opts),
    budget: engine.followUpBudget(caseData.config),
    mains: caseData.mains.length,
    simulatedAnswerSeconds: opts.answerSeconds,
    pair: {
      pairId: pair.id, side, mainOrdinal, gap: variant.gap, gaps: pairGapsLeft(variant), gapCount: caseData.studentsRaw.gaps[mainOrdinal].length,
    },
    status: 'error',
    error: null,
  };
  const steps = [];
  let interviewId = null;
  const restoreEnv = useEnv(promptVersion, opts);

  try {
    const started = await service.startInterview({ userId, submissionId, now: T0, ...runArgs(opts) });
    interviewId = started.interviewId;
    await service.getInterview({ userId, interviewId, isAdmin: false, now: T0 });

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
      scripted: {
        profile: 'pair', pairId: pair.id, side, label: 'vague', gaps: pairGapsLeft(variant),
        gapCount: caseData.studentsRaw.gaps[mainOrdinal].length, answerType: 'main', mainOrdinal,
      },
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

function parseTemperature(text) {
  const value = Number(text);
  if (String(text).trim() === '' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Bad temperature "${text}": use a number from 0 to 1`);
  }
  return value;
}

/**
 * The Host arms: each prompt version at one temperature. `--prompts host.v4@0,host.v4@0.2,host.v3` names the
 * temperature of an arm after an @; `--temperatures 0,0.2` gives every prompt without an @ one arm per temperature.
 * Without either, the arm is the prompt version itself and runs at the default temperature of its version (0 for host.v4 and later, 0.2 for the others).
 */
function parseArms(promptsValue, temperaturesValue) {
  const names = promptsValue === 'all' ? [...engine.PROMPT_VERSIONS] : String(promptsValue).split(',').map((s) => s.trim()).filter(Boolean);
  const temps = temperaturesValue === undefined ? null : String(temperaturesValue).split(',').map((s) => s.trim()).filter(Boolean).map(parseTemperature);
  if (temps && temps.length === 0) throw new Error('--temperatures needs at least one number');
  const specs = [];
  for (const item of names) {
    const [promptVersion, at] = item.split('@');
    if (!engine.PROMPT_VERSIONS.includes(promptVersion)) {
      throw new Error(`Unknown prompt version: ${promptVersion}. Available: ${engine.PROMPT_VERSIONS.join(', ')}`);
    }
    const temperatures = at !== undefined ? [parseTemperature(at)] : temps;
    if (!temperatures) specs.push({ arm: promptVersion, promptVersion, temperature: defaultTemperature(promptVersion) });
    else temperatures.forEach((temperature) => specs.push({ arm: `${promptVersion}@${temperature}`, promptVersion, temperature }));
  }
  const seen = new Set();
  for (const spec of specs) {
    if (seen.has(spec.arm)) throw new Error(`The arm ${spec.arm} is listed twice`);
    seen.add(spec.arm);
  }
  if (specs.length === 0) throw new Error('--prompts needs at least one prompt version');
  return specs;
}

/** `all` is what "all" means; `allowed` (default: the same) is everything that may be named (host.v6's extra cases and profiles). */
function splitList(value, all, label, allowed = all) {
  if (value === undefined || value === 'all') return [...all];
  const items = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = items.filter((i) => !allowed.includes(i));
  if (unknown.length) throw new Error(`Unknown ${label}: ${unknown.join(', ')}. Available: ${allowed.join(', ')}`);
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
  const rubricSample = Number(raw.rubricSample === undefined ? 40 : raw.rubricSample);
  if (!Number.isInteger(rubricSample) || rubricSample < 0) throw new Error('--rubric-sample must be a whole number of 0 or more');
  const modelId = fakeModel ? 'fake-model' : bedrock.resolveModelId(raw.model);
  const judgeModelId = fakeModel ? 'fake-judge' : bedrock.resolveModelId(raw.judgeModel || judging.DEFAULT_JUDGE_MODEL);
  if (judge && !fakeModel && judgeModelId === modelId) {
    throw new Error('The judge must be a different model from the Host. Pass another one with --judge-model.');
  }
  const armSpecs = parseArms(raw.prompts === undefined ? engine.PROMPT_VERSION : raw.prompts, raw.temperatures);
  // host.v5 (the split agent) calls two models: the checker and the writer. Direct model ids only.
  const checkerModelId = fakeModel ? 'fake-checker' : bedrock.resolveModelId(raw.checkerModel || process.env.AGENT_CHECKER_MODEL_ID || splitAgent.DEFAULT_SPLIT_MODEL);
  const writerModelId = fakeModel ? 'fake-writer' : bedrock.resolveModelId(raw.writerModel || process.env.AGENT_WRITER_MODEL_ID || splitAgent.DEFAULT_SPLIT_MODEL);
  const prompts = armSpecs.map((spec) => spec.arm);

  return {
    runId,
    prompts,
    baseline: raw.baseline || null,
    armSpecs,
    armList: raw.baseline ? [...armSpecs, { arm: FIXED_ARM, promptVersion: FIXED_ARM, temperature: null }] : armSpecs,
    arms: raw.baseline ? [...prompts, FIXED_ARM] : prompts,
    pairs: !raw.noPairs,
    judge,
    judgeModelId,
    judgeSample,
    rubricSample,
    judgePrices: {
      inputPerMillion: Number(raw.judgePriceIn === undefined ? judging.DEFAULT_JUDGE_PRICES.inputPerMillion : raw.judgePriceIn),
      outputPerMillion: Number(raw.judgePriceOut === undefined ? judging.DEFAULT_JUDGE_PRICES.outputPerMillion : raw.judgePriceOut),
    },
    // `all` is the established set; cases 10 and 11 and the manip and claims profiles (host.v6 material) are run when named.
    cases: splitList(raw.cases, caseIds(), 'case', caseIds({ includeExtra: true })),
    profiles: splitList(raw.profiles, RUN_PROFILES, 'profile', [...RUN_PROFILES, ...EXTRA_PROFILES]),
    // where host.v6 gets its program output: the real runner (cached on disk), or the free fake. With --fake-model the default is the fake.
    runner: raw.runner || (fakeModel ? 'fake' : 'real'),
    runnerFunction: raw.runnerFunction,
    runCacheDir: raw.runCacheDir,
    repeats,
    out: path.resolve(raw.out || path.join(__dirname, '../../eval-results', runId)),
    fakeModel,
    fakeChaos: raw.fakeChaos === undefined ? 0.26 : Number(raw.fakeChaos),
    seed: raw.seed === undefined ? 1 : raw.seed,
    yes: !!raw.yes,
    modelId,
    checkerModelId,
    writerModelId,
    splitPrices: {
      inputPerMillion: Number(raw.splitPriceIn === undefined ? SPLIT_PRICES.inputPerMillion : raw.splitPriceIn),
      outputPerMillion: Number(raw.splitPriceOut === undefined ? SPLIT_PRICES.outputPerMillion : raw.splitPriceOut),
    },
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
  // The model is asked after a main answer and after every follow-up answer but the last one allowed: with a follow-up
  // budget of b, at most b calls per main question. With no follow-up budget nothing is asked (the engine decides alone).
  const perInterview = (c) => {
    const budget = engine.followUpBudget(c.config);
    return { min: budget > 0 ? c.mains.length : 0, max: c.mains.length * budget };
  };
  // host.v5 asks the checker on every decision and the writer too when something is missing: 1 to 2 calls per decision.
  const specs = opts.armSpecs || opts.prompts.map((p) => ({ promptVersion: String(p).split('@')[0] }));
  const factor = (pick) => specs.reduce((acc, spec) => acc + (engine.usesSplit(spec.promptVersion) && pick === 'max' ? 2 : 1), 0);
  const total = (pick) => factor(pick) * opts.profiles.length * opts.repeats *
    perCase.reduce((acc, c) => acc + perInterview(c)[pick], 0);

  // One pair interview per case, main question, pair and side, per arm and repeat; one model call each.
  const pairVariants = opts.pairs
    ? perCase.reduce((acc, c) => acc + c.mains.reduce((n, _m, i) => n + 2 * pairsFor(c.studentsRaw, i).length, 0), 0)
    : 0;
  const pairInterviews = pairVariants * arms.length * opts.repeats;
  const pairCalls = (pick) => pairVariants * factor(pick) * opts.repeats;

  // The judge labels every follow-up, whatever the answer before it: at most the follow-up budget of each interview, and one per pair interview.
  const followUpsPerRound = perCase.reduce((acc, c) => acc + c.mains.length * engine.followUpBudget(c.config), 0);
  const judgeCalls = opts.judge ? arms.length * opts.profiles.length * opts.repeats * followUpsPerRound + pairInterviews : 0;
  // Rubric check (host.v4 arms): every main answer and follow-up answer of a full interview is checked once. The answers are
  // scripted, so the same answer in another arm or repeat is the same input and is reused: the distinct answers bound the calls.
  const rubricArms = (opts.armSpecs || []).filter((spec) => engine.usesRubric(spec.promptVersion)).length ||
    (opts.armSpecs ? 0 : opts.prompts.filter((p) => engine.usesRubric(String(p).split('@')[0])).length);
  const answersPerProfile = perCase.reduce((acc, c) => acc + c.mains.length * (1 + engine.followUpBudget(c.config)), 0);
  const rubricAnswers = opts.judge ? rubricArms * opts.profiles.length * opts.repeats * answersPerProfile : 0;
  const rubricCalls = opts.judge && rubricArms > 0 ? opts.profiles.length * answersPerProfile : 0;
  return {
    interviews,
    minCalls: total('min') + pairCalls('min'),
    maxCalls: total('max') + pairCalls('max'),
    decisionsPerArm: opts.profiles.length * opts.repeats * perCase.reduce((acc, c) => acc + (engine.followUpBudget(c.config) > 0 ? c.mains.length : 0), 0)
      + pairVariants * opts.repeats,
    splitArms: specs.filter((spec) => engine.usesSplit(spec.promptVersion)).length,
    pairInterviews,
    judgeCalls,
    rubricArms,
    rubricAnswers,
    rubricCalls,
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
const RUBRIC_TOKENS = { input: 600, output: 70 }; // typical size of one rubric-check call
const CHECK_TOKENS = { input: 900, output: 90 }; // host.v5, check.v1 call (measured on DeepSeek in the bake-off: ~805 / ~82)
const WRITE_TOKENS = { input: 2300, output: 70 }; // host.v5, write.v1 call (bake-off: ~2064 / ~54, plus the transcript)
const WRITE_SHARE = 0.6; // a guess: the share of decisions where the checker finds something missing
const HOST_TOKENS = { input: 3500, output: 120 }; // typical size of one Host call (host.v1 to host.v3)
const HOST_V4_TOKENS = { input: 4300, output: 190 }; // host.v4: a longer prompt, the rubric in the message, a longer reply
const REWRITE_SHARE = 0.1; // a guess: the share of Host calls that get one more call from the two-question guard

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
 * Ask the blind judge to label every follow-up the Host asked (in the full interviews and the pair
 * interviews), whatever the answer before it was, and store the labels on the follow-up turn. The judge
 * input is built from the case only (main question, criteria, gap list, follow-up text): the scripted
 * answer is not part of it. The answer and the gaps it left are kept next to the labels, for scoring and
 * for the sample file.
 * @param {Array<{ transcript: object }>} entries
 * @returns {Promise<{ summary: object, items: object[] }>} items are the unique judged follow-ups (per answer), for the sample file
 */
async function judgeTranscripts({ entries, loaded, opts }) {
  const calls = [];
  const converse = opts.fakeModel
    ? createFakeJudge({ seed: opts.seed, chaos: opts.fakeChaos })
    : bedrock.converse;
  const wrapped = withRetry(converse, { calls, sleep: opts.sleep, delayMs: opts.fakeModel ? 0 : opts.delayMs, retryDelayMs: opts.retryDelayMs });
  const judge = judging.createJudge({ modelId: opts.judgeModelId, converseFn: wrapped });
  const rubricJudge = rubricJudging.createRubricJudge({ modelId: opts.judgeModelId, converseFn: wrapped });

  const items = [];
  let rubricChecks = 0;
  let rubricUnjudged = 0;
  const seenItems = new Set();
  let judgements = 0;
  let unjudged = 0;
  for (const { transcript, file } of entries) {
    const caseData = loaded[transcript.caseId];
    const turns = transcript.turns || [];
    // Rubric check (host.v4 arms): the second, separate judge call. It sees the question, the rubric and the answer; not the
    // follow-up, not the code, not the Host's own check. Every main answer and follow-up answer of a full interview.
    if (engine.usesRubric(transcript.promptVersion) && !transcript.pair) {
      for (const turn of turns) {
        if (turn.role !== 'student' || !turn.scripted) continue;
        const rubric = caseData.mains[turn.scripted.mainOrdinal].rubric;
        if (!rubric.length) continue;
        const result = await rubricJudge.judge({ mainQuestion: caseData.mains[turn.scripted.mainOrdinal].question, rubric, answer: turn.text });
        rubricChecks += 1;
        if (!result.valid) rubricUnjudged += 1;
        turn.rubricCheck = {
          valid: result.valid,
          ...(result.valid && { missing: result.missing, reason: result.reason }),
          ...(result.error && { error: result.error }),
          judgeModel: opts.judgeModelId,
          judgePrompt: rubricJudging.RUBRIC_JUDGE_PROMPT_VERSION,
        };
      }
    }
    for (let i = 1; i < turns.length; i += 1) {
      const turn = turns[i];
      const answerTurn = turns[i - 1];
      if (turn.role !== 'host' || turn.kind !== 'follow_up' || answerTurn.role !== 'student' || !answerTurn.scripted) continue;
      const ordinal = answerTurn.scripted.mainOrdinal;
      // Blind input: nothing about the student's answer.
      const input = {
        mainQuestion: caseData.mains[ordinal].question,
        criteria: caseData.mains[ordinal].criteria,
        gaps: caseData.studentsRaw.gaps[ordinal],
        followUp: turn.text,
      };
      const result = await judge.judge(input);
      judgements += 1;
      if (!result.valid) unjudged += 1;
      turn.judgement = {
        valid: result.valid,
        ...(result.valid && {
          targets: result.targets, reveals: result.reveals, twoPart: result.twoPart, beyondScope: result.beyondScope, reason: result.reason,
        }),
        ...(result.error && { error: result.error }),
        judgeModel: opts.judgeModelId,
        judgePrompt: judging.JUDGE_PROMPT_VERSION,
      };
      // When the two-question guard changed this follow-up, the blind judge also labels the original, so the two-part rate can be
      // reported as if the guard were off. Only the two-part label of the original is used.
      if (turn.guard && turn.guard.fired) {
        const original = await judge.judge({ ...input, followUp: turn.guard.original });
        turn.guard.originalJudgement = original.valid ? { valid: true, twoPart: original.twoPart } : { valid: false };
      }
      const itemKey = JSON.stringify([input, answerTurn.text]);
      if (result.valid && !seenItems.has(itemKey)) {
        seenItems.add(itemKey);
        items.push({
          ...input,
          answer: answerTurn.text,
          gapsLeft: answerTurn.scripted.gaps || [],
          targets: result.targets,
          reveals: result.reveals,
          twoPart: result.twoPart,
          beyondScope: result.beyondScope,
          reason: result.reason,
          source: file ? path.relative(opts.out, file).split(path.sep).join('/') : '',
        });
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
      rubricCheck: {
        promptVersion: rubricJudging.RUBRIC_JUDGE_PROMPT_VERSION,
        answers: rubricChecks,
        unjudged: rubricUnjudged,
        ...rubricJudge.usage,
        estimatedCostUsd: judging.estimateJudgeCost(rubricJudge.usage, opts.judgePrices),
      },
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
  const usesRuns = opts.armSpecs.some((spec) => engine.usesV6(spec.promptVersion));
  // Only host.v6 runs the student's code. The support is created for every run (cheap) and passed to the service, which ignores it for the others.
  opts.runSupport = createRunSupport({ mode: opts.runner, runnerFunction: opts.runnerFunction, ...(opts.runCacheDir && { cacheDir: opts.runCacheDir }) });
  log(`Run ${opts.runId}`);
  log(`  arms: ${opts.arms.join(', ')} | cases: ${opts.cases.join(', ')} | profiles: ${opts.profiles.join(', ')} | repeats: ${opts.repeats}`);
  log(`  ${plan.interviews} interviews, about ${plan.minCalls}-${plan.maxCalls} model calls${opts.fakeModel ? ' (fake model, no Bedrock)' : ` in us-east-1 (single-model arms: ${opts.modelId}${plan.splitArms ? `; host.v5: checker ${opts.checkerModelId}, writer ${opts.writerModelId}` : ''})`}`);
  if (usesRuns) {
    log(`  host.v6 runs the student's code on the inputs set for Q1 and Q3: runner = ${opts.runner}${opts.runner === 'real' ? ' (CODE_RUNNER=own: the dev runner Lambda, needs AWS credentials; results are cached in eval-results/run-cache, so repeats and other arms do not run the same program twice)' : ' (free, deterministic; no AWS)'}`);
  }
  if (opts.pairs) log(`  plus ${plan.pairInterviews} minimal-pair interviews (one decision each, already counted in the calls above); --no-pairs skips them`);
  log('  the model is not asked when only one action is allowed (the next main question, or end); the two-question guard can add one rewrite call per follow-up that asks two things (not counted above)');
  if (opts.armSpecs.some((spec) => spec.temperature !== bedrock.DEFAULT_TEMPERATURE)) {
    log(`  temperatures: ${opts.armSpecs.map((spec) => `${spec.arm} = ${spec.temperature}`).join(', ')}`);
  }
  if (!opts.fakeModel) {
    const single = opts.armSpecs.filter((spec) => !engine.usesSplit(spec.promptVersion));
    const splitSpecs = opts.armSpecs.filter((spec) => engine.usesSplit(spec.promptVersion));
    const parts = [];
    let seconds = 0;
    if (single.length) {
      // One call per decision, plus a guessed share of rewrite calls from the guards.
      const calls = single.length * plan.decisionsPerArm * (1 + REWRITE_SHARE);
      const tokens = single.reduce((acc, spec) => {
        const t = engine.usesRubric(spec.promptVersion) ? HOST_V4_TOKENS : HOST_TOKENS;
        return { input: acc.input + plan.decisionsPerArm * (1 + REWRITE_SHARE) * t.input, output: acc.output + plan.decisionsPerArm * (1 + REWRITE_SHARE) * t.output };
      }, { input: 0, output: 0 });
      const cost = metrics.estimateCost(tokens.input, tokens.output, opts.prices);
      parts.push(cost);
      seconds += calls * (opts.delayMs / 1000 + 3);
      log(`  rough cost, single-model arms (${single.map((s) => s.arm).join(', ')}): ${Math.round(calls)} calls including ~${Math.round(calls * REWRITE_SHARE / (1 + REWRITE_SHARE))} rewrite calls (a guess: ${REWRITE_SHARE * 100}%) at ~${HOST_TOKENS.input.toLocaleString('en-US')} input / ~${HOST_TOKENS.output} output tokens each (host.v4 and later: ~${HOST_V4_TOKENS.input.toLocaleString('en-US')} / ~${HOST_V4_TOKENS.output}): $${cost.toFixed(2)} (prices: $${opts.prices.inputPerMillion}/$${opts.prices.outputPerMillion} per million tokens, third-party figure, verify)`);
    }
    if (splitSpecs.length) {
      // host.v5: a check on every decision, a write on the share of decisions that find something missing, and repairs on a guessed share of the writes.
      const checks = splitSpecs.length * plan.decisionsPerArm;
      const writes = checks * WRITE_SHARE;
      const repairs = writes * REWRITE_SHARE;
      const cost = metrics.estimateCost(checks * CHECK_TOKENS.input + (writes + repairs) * WRITE_TOKENS.input, checks * CHECK_TOKENS.output + (writes + repairs) * WRITE_TOKENS.output, opts.splitPrices);
      parts.push(cost);
      seconds += (checks + writes + repairs) * (opts.delayMs / 1000 + 2.5);
      log(`  rough cost, host.v5 (${splitSpecs.map((s) => s.arm).join(', ')}): ~${Math.round(checks)} check calls (checker ${opts.checkerModelId}) and ~${Math.round(writes + repairs)} write calls (writer ${opts.writerModelId}; a guess: ${WRITE_SHARE * 100}% of the decisions find something missing, ${REWRITE_SHARE * 100}% of the writes are repaired once) at ~${CHECK_TOKENS.input} / ~${CHECK_TOKENS.output} (check) and ~${WRITE_TOKENS.input} / ~${WRITE_TOKENS.output} (write) tokens: $${cost.toFixed(2)} (prices: $${opts.splitPrices.inputPerMillion}/$${opts.splitPrices.outputPerMillion} per million tokens, AWS Price List API for the default model, verify)`);
    }
    log(`  Host cost in total: $${parts.reduce((a, b) => a + b, 0).toFixed(2)}`);
    log(`  the code and scripted answers are sent to Bedrock; ${opts.delayMs} ms pause before each call`);
    // A guess, not a measurement: about 3 s per single-model Host call, 2.5 s per split call and 2 s per judge call on top of the pause, one call at a time.
    seconds += (plan.judgeCalls + plan.rubricCalls) * (opts.delayMs / 1000 + 2);
    log(`  rough time: about ${Math.round(seconds / 60)} minutes (a guess: ~3 s per single-model Host call, ~2.5 s per split call, ~2 s per judge call, one at a time)`);
  }
  if (opts.judge) {
    if (opts.fakeModel) {
      log(`  judge: fake (no Bedrock), up to ${plan.judgeCalls} judgements`);
      if (plan.rubricArms) log(`  rubric check: fake, ${plan.rubricAnswers} answers in ${plan.rubricArms} host.v4 arm(s), at most ${plan.rubricCalls} distinct calls`);
    } else {
      const judgeCost = judging.estimateJudgeCost({ inputTokens: plan.judgeCalls * JUDGE_TOKENS.input, outputTokens: plan.judgeCalls * JUDGE_TOKENS.output }, opts.judgePrices);
      log(`  judge: ${opts.judgeModelId}, up to ${plan.judgeCalls} judgements at ~${JUDGE_TOKENS.input} input / ~${JUDGE_TOKENS.output} output tokens each: at most $${judgeCost.toFixed(2)} ($${opts.judgePrices.inputPerMillion}/$${opts.judgePrices.outputPerMillion} per million tokens; repeated inputs are reused)`);
      log(`  the judge (${judging.JUDGE_PROMPT_VERSION}) is blind to the student's answer: it sees the main question, the criteria, the gap list and the follow-up. No code.`);
      if (plan.rubricArms) {
        const rubricCost = judging.estimateJudgeCost({ inputTokens: plan.rubricCalls * RUBRIC_TOKENS.input, outputTokens: plan.rubricCalls * RUBRIC_TOKENS.output }, opts.judgePrices);
        log(`  rubric check (${rubricJudging.RUBRIC_JUDGE_PROMPT_VERSION}, a separate judge call that sees the question, the rubric and the answer): ${plan.rubricAnswers} answers in ${plan.rubricArms} host.v4 arm(s), at most ${plan.rubricCalls} distinct calls at ~${RUBRIC_TOKENS.input} input / ~${RUBRIC_TOKENS.output} output tokens each: at most $${rubricCost.toFixed(2)} (identical inputs are reused; the answers are scripted, so most are)`);
      }
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
        for (const spec of opts.armList) {
          const transcript = await runInterview({
            caseData: loaded[caseId], profileName, answers, promptVersion: spec.promptVersion, arm: spec.arm, temperature: spec.temperature, repeat, opts,
          });
          transcripts.push(transcript);
          const name = `${spec.arm}__${caseId}__${profileName}__r${repeat}.json`;
          files.set(transcript, path.join(opts.out, 'transcripts', name));
          fs.writeFileSync(files.get(transcript), JSON.stringify(transcript, null, 2));
          if (transcript.status === 'error') failures.push({ file: name, error: transcript.error });
          done += 1;
          log(`[${done}/${plan.interviews}] ${spec.arm} ${caseId} ${profileName} r${repeat}: ${transcript.status}, ${transcript.turns ? transcript.turns.filter((t) => t.role === 'host').length : 0} questions${transcript.error ? ` (${transcript.error})` : ''}`);
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
              for (const spec of opts.armList) {
                const transcript = await runPairInterview({
                  caseData, mainOrdinal, pair, side, promptVersion: spec.promptVersion, arm: spec.arm, temperature: spec.temperature, repeat, opts,
                });
                pairTranscripts.push(transcript);
                const name = `${spec.arm}__${caseId}__q${mainOrdinal + 1}__${pair.id}${side}__r${repeat}.json`;
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

  const results = metrics.summarizeRun(transcripts, opts.prices, opts.splitPrices);
  adaptive.attachAdaptive(results, transcripts, pairTranscripts);
  rubricStats.attachRubric(results, transcripts);
  const totals = Object.values(results).map((r) => r.allCases); // calls and cost cover every case, not only the headline ones
  const notes = [];
  if (opts.cases.includes('case1') && opts.prompts.some((p) => p !== 'host.v1')) {
    notes.push(`case1 (the linked list) shares code and wording with the examples in host.v2 and host.v3, so those prompts are advantaged there. host.v1 has no examples. The headline numbers leave it out; it is reported on its own in the case 1 section.`);
  }
  if (opts.cases.some((c) => ['case2', 'case3'].includes(c))) {
    notes.push('The headline numbers are cases 4 to 9 (the tank controller). Cases 2 and 3 are kept as a separate side check, reported on their own below.');
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
      armSpecs: opts.armSpecs, rubricSample: opts.rubricSample,
      pairs: opts.pairs, judge: opts.judge, judgeModel: opts.judge ? opts.judgeModelId : null,
      runner: usesRuns ? opts.runner : null,
      judgePrompt: opts.judge ? judging.JUDGE_PROMPT_VERSION : null, headlineExcludes: HEADLINE_EXCLUDED_CASES,
    },
    plan: {
      ...plan,
      actualCalls: totals.reduce((a, s) => a + s.calls, 0) + pairTranscripts.reduce((a, t) => a + (t.calls || []).length, 0),
      actualCostUsd: totals.reduce((a, s) => a + s.estimatedCostUsd, 0),
    },
    pairInterviews: pairTranscripts.length,
    judge: judgeSummary,
    results,
    followUps: sampleFollowUps(transcripts, { seed: opts.seed }),
    failures,
    notes,
  };
  writeReports(opts.out, report);

  if (opts.judge && opts.judgeSample > 0) {
    const sample = sampleOf(judgeItems, opts.judgeSample, opts.seed);
    fs.writeFileSync(path.join(opts.out, 'judge-sample.csv'), toJudgeSampleCsv(sample));
    log(`Wrote judge-sample.csv with ${sample.length} judged follow-ups. Fill in the human_* columns to measure how often the judge agrees with a person.`);
  }

  if (opts.judge && opts.rubricSample > 0 && plan.rubricArms > 0) {
    const sample = rubricStats.buildRubricSample({ transcripts, loaded, count: opts.rubricSample, seed: opts.seed });
    fs.writeFileSync(path.join(opts.out, 'rubric-check-blind.csv'), rubricStats.toBlindCsv(sample));
    fs.writeFileSync(path.join(opts.out, 'rubric-check-key.csv'), rubricStats.toKeyCsv(sample));
    log(`Wrote rubric-check-blind.csv (${sample.length} answers; fill in human_missing with ids like "r1 r3", or "none") and rubric-check-key.csv. Then run: node scripts/eval/compare-rubric.js ${path.relative(process.cwd(), opts.out) || '.'}`);
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
