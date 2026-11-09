#!/usr/bin/env node
// node scripts/compare-judge0.js [--function <runner function>] [--only <n,n,...>] [--limit <n>] [--skip <n>] [--dry-run]
//
// Runs the normal-program fixture (test/fixtures/normal.js: 29 programs, 37 runs) through BOTH providers of the backend:
//   Judge0   shared/nodejs/utils/codeRunnerJudge0.js  (the REAL Judge0 key, read the way the backend reads it:
//            judge0.getJudge0Credentials(), i.e. Secrets Manager secret JUDGE0_API_KEY_SECRET_ARN, default
//            micro-credentialing/judge0-api-key, with YOUR AWS credentials)
//   own      shared/nodejs/utils/codeRunnerOwn.js     (the DEPLOYED runner, default micro-credentialing-runner-dev-recycle)
// One Judge0 batch per program. Prints the status of every run for each side, then the mismatches (status; and stdout for
// runs that ended accepted / wrong_answer).
//
// Judge0's free tier allows about 50 requests a day, so BEFORE any Judge0 call the script prints how many it will make and
// asks you to type "yes". Every program costs one submit request plus at least one poll request (one more for each second
// Judge0 needs): --limit/--skip/--only run a part of the fixture, e.g. over several days. --dry-run only prints the plan
// and calls nothing. After the run it prints how many Judge0 requests it really made.
//
// The deployed runner has no tenant isolation (CODE_RUNNER_TENANT_ISOLATION=off); pass --tenant for the tenant function.
const path = require('path');
const readline = require('readline');

const SHARED = path.join(__dirname, '../../shared/nodejs');
const DEFAULT_FUNCTION = 'micro-credentialing-runner-dev-recycle';
const DEFAULT_SECRET = 'micro-credentialing/judge0-api-key';
const MEMORY_KB = 256000;
const clip = (text, n = 60) => {
  const s = JSON.stringify(text === undefined || text === null ? '' : String(text));
  return s.length > n ? `${s.slice(0, n - 3)}..."` : s;
};

/** The runs of one fixture program, in the shape codeRunner providers take. */
function toRuns(program) {
  return program.runs.map(run => ({
    source: program.source,
    stdin: run.stdin,
    expectedOutput: run.expectedOutput,
    timeLimitMs: program.timeLimitMs,
    memoryLimitKb: program.memoryLimitKb || MEMORY_KB
  }));
}

/**
 * Compare two provider results for one run. Returns a list of differences (empty = same).
 * Status always; stdout when either side ended accepted or wrong_answer.
 */
function differences(judge0, own) {
  const out = [];
  if (judge0.status !== own.status) out.push(`status: judge0 ${judge0.status}, own ${own.status}`);
  const outputMatters = s => s === 'accepted' || s === 'wrong_answer';
  if ((outputMatters(judge0.status) || outputMatters(own.status)) && (judge0.stdout || '') !== (own.stdout || '')) {
    out.push(`stdout: judge0 ${clip(judge0.stdout)}, own ${clip(own.stdout)}`);
  }
  return out;
}

/**
 * Run the selected programs through both sides. `providers` = { judge0: runBatch, own: runBatch } so tests can pass fakes.
 * One batch per program on each side. Never throws for a provider failure: that run is reported as internal_error.
 */
async function compare(programs, providers, { onProgram = () => {} } = {}) {
  const rows = [];
  const mismatches = [];
  for (const program of programs) {
    const runs = toRuns(program);
    const [j, o] = await Promise.all(['judge0', 'own'].map(async side => {
      try { return await providers[side](runs); } catch (error) {
        return runs.map(() => ({ status: 'internal_error', stdout: '', message: error.message }));
      }
    }));
    program.runs.forEach((run, i) => {
      const diffs = differences(j[i], o[i]);
      rows.push({ program: program.name, run: i, fixture: run.status, judge0: j[i].status, own: o[i].status, same: diffs.length ? 'MISMATCH' : 'ok' });
      for (const d of diffs) mismatches.push({ program: program.name, run: i, difference: d });
    });
    onProgram(program, rows.length);
  }
  return { rows, mismatches };
}

function parseArgs(argv) {
  const opts = { functionName: DEFAULT_FUNCTION, only: null, limit: null, skip: 0, dryRun: false, tenant: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--function') opts.functionName = argv[++i];
    else if (a === '--only') opts.only = String(argv[++i]).split(',').map(Number);
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--skip') opts.skip = Number(argv[++i]);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--tenant') opts.tenant = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

function select(programs, { only, limit, skip }) {
  let chosen = programs.map((program, index) => ({ program, index }));
  if (only) chosen = chosen.filter(c => only.includes(c.index + 1));
  else chosen = chosen.slice(skip, limit === null ? undefined : skip + limit);
  return chosen.map(c => c.program);
}

const confirm = question => new Promise(resolve => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, answer => { rl.close(); resolve(answer.trim().toLowerCase() === 'yes'); });
});

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const programs = select(require('../test/fixtures/normal'), opts);
  const runCount = programs.reduce((n, p) => n + p.runs.length, 0);
  if (!programs.length) { console.error('No program selected.'); process.exit(2); }

  console.log(`Programs: ${programs.length} (${runCount} runs). Judge0 gets ONE batch per program.`);
  console.log(`Judge0 requests this will make: ${programs.length} submit + at least ${programs.length} poll = at least ${programs.length * 2}`
    + ` (each poll is another request; a program Judge0 needs more than a second for adds one per second).`);
  console.log(`  ${runCount} submissions in ${programs.length} batches. The free tier allows about 50 requests a day: use --limit/--skip/--only to split the run.`);
  console.log(`Runner: ${opts.functionName} (${opts.tenant ? 'with' : 'without'} tenant ids), region ${process.env.AWS_REGION || 'us-east-1'}`);
  if (opts.dryRun) { console.log('--dry-run: nothing was called.'); return; }
  if (!(await confirm(`Make these Judge0 calls now? Type "yes" to continue: `))) { console.log('Cancelled. Nothing was called.'); return; }

  process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
  process.env.JUDGE0_API_KEY_SECRET_ARN = process.env.JUDGE0_API_KEY_SECRET_ARN || DEFAULT_SECRET;
  process.env.JUDGE0_API_HOST = process.env.JUDGE0_API_HOST || 'judge0-ce.p.rapidapi.com';
  process.env.CODE_RUNNER_FUNCTION = opts.functionName;
  if (!opts.tenant) process.env.CODE_RUNNER_TENANT_ISOLATION = 'off';

  // Count the requests that really go to Judge0.
  let judge0Requests = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => { if (String(url).includes(process.env.JUDGE0_API_HOST)) judge0Requests++; return realFetch(url, ...rest); };

  // The backend's logger prints a JSON line for every request; keep the table readable (errors still show).
  const logger = require(path.join(SHARED, 'utils/logger'));
  logger.info = () => {};
  logger.warn = () => {};

  const judge0Provider = require(path.join(SHARED, 'utils/codeRunnerJudge0'));
  const ownProvider = require(path.join(SHARED, 'utils/codeRunnerOwn'));
  const providers = {
    judge0: runs => judge0Provider.runBatch(runs, {}),
    own: runs => ownProvider.runBatch(runs, { userId: 'compare-judge0' })
  };

  const { rows, mismatches } = await compare(programs, providers, {
    onProgram: (program, done) => console.log(`  ${program.name}: done (${done}/${runCount} runs)`)
  });
  console.table(rows);
  console.log(`Judge0 requests made: ${judge0Requests}`);
  if (!mismatches.length) console.log(`No mismatches in ${rows.length} runs.`);
  else {
    console.log(`MISMATCHES (${mismatches.length}):`);
    for (const m of mismatches) console.log(`  - ${m.program} / run ${m.run}: ${m.difference}`);
  }
  process.exit(mismatches.length ? 1 : 0);
}

module.exports = { compare, differences, toRuns, select, parseArgs };

if (require.main === module) main().catch(error => { console.error(error.message); process.exit(2); });
