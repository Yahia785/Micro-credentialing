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

const engine = require('../../shared/nodejs/agent/interview-engine');
const bedrock = require('../../shared/nodejs/agent/bedrock-client');
const stores = require('./fake-stores');
const { createFakeModel } = require('./fake-model');
const { caseIds, loadCase } = require('./cases');
const { PROFILES, validateStudents, buildProfile } = require('./students');
const metrics = require('./metrics');
const { writeReports } = require('./report');

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

async function runInterview({ caseData, profileName, answers, promptVersion, repeat, opts }) {
  stores.reset();
  const service = loadService();
  const userId = 'eval-student';
  const milestoneId = `milestone_${caseData.id}`;
  const submissionId = `eval_${caseData.id}_${profileName}_${promptVersion.replace('.', '')}_r${repeat}`;
  const answerMs = opts.answerSeconds * 1000;

  stores.submissions.register({
    submissionId, userId, milestoneId, language: 'cpp', status: 'passed', endedBy: 'submit_button', code: caseData.code,
  });
  stores.milestones.register({ milestoneId, language: 'cpp', interview: caseData.config });

  const calls = [];
  const base = opts.fakeModel ? createFakeModel({ seed: opts.seed, chaos: opts.fakeChaos }) : bedrock.converse;
  const converseFn = withRetry(base, { calls, sleep: opts.sleep, delayMs: opts.delayMs, retryDelayMs: opts.retryDelayMs });

  const transcript = {
    schema: 1,
    runId: opts.runId,
    promptVersion,
    caseId: caseData.id,
    profile: profileName,
    repeat,
    modelId: opts.fakeModel ? 'fake-model' : opts.modelId,
    budget: engine.followUpBudget(caseData.config),
    mains: caseData.mains.length,
    simulatedAnswerSeconds: opts.answerSeconds,
    status: 'error',
    error: null,
  };
  const steps = []; // one per answer sent: what was scripted and which model call it triggered
  let interviewId = null;

  const savedEnv = { prompt: process.env.AGENT_PROMPT_VERSION, model: process.env.AGENT_MODEL_ID };
  process.env.AGENT_PROMPT_VERSION = promptVersion;
  if (!opts.fakeModel) process.env.AGENT_MODEL_ID = opts.modelId;

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

      const callsBefore = calls.length;
      const result = await service.submitAnswer({
        userId, interviewId, answer: answer.text, clientTiming: {}, now: T0 + k * answerMs, converseFn,
      });
      steps.push({
        scripted: { profile: profileName, source: entry.source, label: answer.label, answerType, mainOrdinal },
        call: calls[callsBefore] || null,
        status: result.ended ? result.status : null,
      });
      if (result.ended) break;
    }
  } catch (error) {
    transcript.error = error.name === 'ModelUnavailableError' ? 'ModelUnavailableError' : `${error.name}: ${error.message}`;
  } finally {
    if (savedEnv.prompt === undefined) delete process.env.AGENT_PROMPT_VERSION;
    else process.env.AGENT_PROMPT_VERSION = savedEnv.prompt;
    if (savedEnv.model === undefined) delete process.env.AGENT_MODEL_ID;
    else process.env.AGENT_MODEL_ID = savedEnv.model;
  }

  if (interviewId) await assemble(transcript, interviewId, steps);
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

  return {
    runId,
    prompts: splitList(raw.prompts === undefined ? engine.PROMPT_VERSION : raw.prompts, engine.PROMPT_VERSIONS, 'prompt version'),
    cases: splitList(raw.cases, caseIds(), 'case'),
    profiles: splitList(raw.profiles, PROFILES, 'profile'),
    repeats,
    out: path.resolve(raw.out || path.join(__dirname, '../../eval-results', runId)),
    fakeModel,
    fakeChaos: raw.fakeChaos === undefined ? 0.26 : Number(raw.fakeChaos),
    seed: raw.seed === undefined ? 1 : raw.seed,
    yes: !!raw.yes,
    modelId: fakeModel ? 'fake-model' : bedrock.resolveModelId(raw.model),
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

function planOf(opts, loaded) {
  const perCase = opts.cases.map((id) => loaded[id]);
  const interviews = opts.prompts.length * opts.profiles.length * opts.repeats * perCase.length;
  const perInterview = (c) => ({
    min: c.mains.length,
    max: c.mains.length * (1 + engine.followUpBudget(c.config)),
  });
  const total = (pick) => opts.prompts.length * opts.profiles.length * opts.repeats *
    perCase.reduce((acc, c) => acc + perInterview(c)[pick], 0);
  return { interviews, minCalls: total('min'), maxCalls: total('max') };
}

async function askToProceed(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function runEval(rawOptions) {
  const opts = normalizeOptions(rawOptions);
  const log = opts.log;

  const loaded = {};
  for (const id of opts.cases) {
    const caseData = loadCase(id);
    validateStudents(caseData.studentsRaw, caseData.mains.length, id);
    loaded[id] = caseData;
  }

  const plan = planOf(opts, loaded);
  log(`Run ${opts.runId}`);
  log(`  prompts: ${opts.prompts.join(', ')} | cases: ${opts.cases.join(', ')} | profiles: ${opts.profiles.join(', ')} | repeats: ${opts.repeats}`);
  log(`  ${plan.interviews} interviews, about ${plan.minCalls}-${plan.maxCalls} model calls${opts.fakeModel ? ' (fake model, no Bedrock)' : ` to ${opts.modelId} in us-east-1`}`);
  if (!opts.fakeModel) {
    const typical = Math.round((plan.minCalls + plan.maxCalls) / 2);
    const cost = metrics.estimateCost(typical * 3500, typical * 120, opts.prices);
    log(`  rough cost for ${typical} calls at ~3,500 input / ~120 output tokens each: $${cost.toFixed(2)} (prices: $${opts.prices.inputPerMillion}/$${opts.prices.outputPerMillion} per million tokens, third-party figure, verify)`);
    log(`  the code and scripted answers are sent to Bedrock; ${opts.delayMs} ms pause before each call`);
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

  const transcripts = [];
  const failures = [];
  let done = 0;
  // Repeats outermost and prompts innermost, so slow periods and throttling affect every prompt alike.
  for (let repeat = 1; repeat <= opts.repeats; repeat += 1) {
    for (const caseId of opts.cases) {
      for (const profileName of opts.profiles) {
        const answers = buildProfile(loaded[caseId].studentsRaw, profileName);
        for (const promptVersion of opts.prompts) {
          const transcript = await runInterview({
            caseData: loaded[caseId], profileName, answers, promptVersion, repeat, opts,
          });
          transcripts.push(transcript);
          const name = `${promptVersion}__${caseId}__${profileName}__r${repeat}.json`;
          fs.writeFileSync(path.join(opts.out, 'transcripts', name), JSON.stringify(transcript, null, 2));
          if (transcript.status === 'error') failures.push({ file: name, error: transcript.error });
          done += 1;
          log(`[${done}/${plan.interviews}] ${promptVersion} ${caseId} ${profileName} r${repeat}: ${transcript.status}, ${transcript.turns ? transcript.turns.filter((t) => t.role === 'host').length : 0} questions${transcript.error ? ` (${transcript.error})` : ''}`);
        }
      }
    }
  }

  const results = metrics.summarizeRun(transcripts, opts.prices);
  const totals = Object.values(results).map((r) => r.overall);
  const notes = [];
  if (opts.cases.includes('case1') && opts.prompts.some((p) => p !== 'host.v1')) {
    notes.push('case1 (the linked list) shares code and wording with the examples in host.v2 and host.v3, so those prompts are advantaged there. host.v1 has no examples. Use case2 and case3 for a fair comparison.');
  }
  if (opts.fakeModel) notes.push('Fake model: these numbers test the runner, they say nothing about a real model.');

  const report = {
    runId: opts.runId,
    options: {
      prompts: opts.prompts, cases: opts.cases, profiles: opts.profiles, repeats: opts.repeats,
      fakeModel: opts.fakeModel, modelId: opts.modelId, answerSeconds: opts.answerSeconds, prices: opts.prices,
    },
    plan: {
      ...plan,
      actualCalls: totals.reduce((a, s) => a + s.calls, 0),
      actualCostUsd: totals.reduce((a, s) => a + s.estimatedCostUsd, 0),
    },
    results,
    failures,
    notes,
  };
  writeReports(opts.out, report);
  log(`Done. ${transcripts.length} transcripts, ${failures.length} failed. Summary: ${path.join(opts.out, 'summary.md')}`);
  return { cancelled: false, outDir: opts.out, report, transcripts };
}

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

const FLAGS = ['fake-model', 'yes'];
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
  runEval, runInterview, normalizeOptions, planOf, parseArgs, withRetry, installFakeStores,
};
