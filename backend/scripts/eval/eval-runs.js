/**
 * Running the student's code in the evaluation (host.v6 runs it on the inputs the instructor set for a main question).
 *
 *   --runner real   the default. The same path as the product: codeRunner.runCppBatch with CODE_RUNNER=own, which invokes the dev runner Lambda
 *                   (needs AWS credentials in us-east-1; set CODE_RUNNER_FUNCTION or pass --runner-function). Results are cached on disk per
 *                   code hash and stdin (eval-results/run-cache/), so repeats, other arms and a second run never run the same program twice.
 *   --runner fake   free: a deterministic stand-in that "runs" the tank controller programs of the cases (the output the reference program
 *                   and each buggy variant would print, from build-tank-cases.js; a stub function and a program that does not compile behave
 *                   like their real counterparts). For dry runs and tests. Other programs print nothing.
 *
 * Both modes give the service the two functions it takes (runBatch and countRun). countRun is an in-memory counter with the product's limit
 * (30 agent runs per interview); the Run button's limits are not involved.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { simulate } = require('./build-tank-cases');
const { findStubs } = require('../../shared/nodejs/agent/code-status');
const { RateLimitError } = require('../../shared/nodejs/utils/errors');
const { DEFAULTS } = require('../../shared/nodejs/services/run-limiter');

const DEFAULT_CACHE_DIR = path.resolve(__dirname, '../../eval-results/run-cache');
const DEFAULT_RUNNER_FUNCTION = 'micro-credentialing-runner-dev-recycle'; // the RunnerFunctionName default of template.yaml (the dev runner stack)

const result = (over) => ({ status: 'accepted', stdout: '', stderr: '', compileOutput: '', timeMs: 3, memoryKb: 900, statusText: null, runId: null, message: null, ...over });

/** Which tank program is this? The reference, or the one buggy variant (see build-tank-cases.js), judged by the line that differs. */
function tankVariant(source) {
  if (/reading\s*>\s*s\.high/.test(source)) return 'case6';
  if (!/current\s*==\s*TankState::ALARM/.test(source)) return 'case7';
  if (/reading\s*<\s*s\.max/.test(source)) return 'case8';
  if (/if\s*\(next\s*==\s*TankState::FILLING\)\s*\{/.test(source)) return 'case9';
  if (/return\s+TankState::IDLE;/.test(source)) return 'case5';
  return 'case4';
}

/** What the fake runner returns for one program and one input. */
function fakeRun(source, stdin) {
  if (/step\(state,\s*reading,\s*s\)\s*(?!;)\n/.test(source)) {
    return result({ status: 'compile_error', compileOutput: "main.cpp: error: expected ';' before 'state'" });
  }
  if (!/TankState/.test(source)) return result({}); // not a tank program: the fake knows nothing about it
  if (findStubs(source).length > 0) return result({ status: 'runtime_error', stderr: 'Segmentation fault', timeMs: 2 });
  return result({ stdout: `${simulate(tankVariant(source), stdin).join('\n')}\n` });
}

const cacheKey = ({ source, stdin, timeLimitMs, memoryLimitKb }) => crypto.createHash('sha256')
  .update(JSON.stringify({ source, stdin, timeLimitMs, memoryLimitKb })).digest('hex');

/**
 * @param {{ mode?: 'real'|'fake', cacheDir?: string, runnerFunction?: string, realRunBatch?: Function }} options
 *        realRunBatch lets a test stand in for the real runner
 * @returns {{ runBatch: Function, countRun: Function, stats: { runs: number, cacheHits: number, executed: number } }}
 */
function createRunSupport({ mode = 'real', cacheDir = DEFAULT_CACHE_DIR, runnerFunction, realRunBatch } = {}) {
  if (mode !== 'real' && mode !== 'fake') throw new Error('--runner must be "real" or "fake"');
  const stats = { runs: 0, cacheHits: 0, executed: 0 };
  let provider = realRunBatch || null;

  const loadReal = () => {
    if (provider) return provider;
    // The own runner, the way the deployed functions use it. Credentials come from the AWS profile or environment of the person running this.
    process.env.CODE_RUNNER = 'own';
    process.env.CODE_RUNNER_FUNCTION = runnerFunction || process.env.CODE_RUNNER_FUNCTION || DEFAULT_RUNNER_FUNCTION;
    process.env.CODE_RUNNER_TENANT_ISOLATION = 'off';
    process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
    provider = require('../../shared/nodejs/utils/codeRunner').runCppBatch;
    return provider;
  };

  const cached = (key) => {
    try { return JSON.parse(fs.readFileSync(path.join(cacheDir, `${key}.json`), 'utf8')); } catch { return null; }
  };
  const store = (key, value) => {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, `${key}.json`), JSON.stringify(value));
  };

  async function runBatch(runs, options = {}) {
    stats.runs += runs.length;
    if (mode === 'fake') {
      stats.executed += runs.length;
      return runs.map((run) => fakeRun(run.source, run.stdin));
    }
    const out = new Array(runs.length);
    const missing = [];
    runs.forEach((run, i) => {
      const hit = cached(cacheKey(run));
      if (hit) { out[i] = hit; stats.cacheHits += 1; } else { missing.push(i); }
    });
    if (missing.length) {
      const fresh = await loadReal()(missing.map((i) => runs[i]), options);
      missing.forEach((i, n) => {
        out[i] = fresh[n];
        stats.executed += 1;
        // A provider failure is not a result: it is never cached, so the next run tries again.
        if (fresh[n] && fresh[n].status !== 'internal_error') store(cacheKey(runs[i]), fresh[n]);
      });
    }
    return out;
  }

  const counts = new Map();
  async function countRun({ interviewId }) {
    const used = counts.get(interviewId) || 0;
    if (used >= DEFAULTS.agentPerInterview) throw new RateLimitError("You've reached the agent run limit for this interview", 'agent');
    counts.set(interviewId, used + 1);
  }

  return { runBatch, countRun, stats };
}

module.exports = { createRunSupport, fakeRun, tankVariant, cacheKey, DEFAULT_CACHE_DIR };
