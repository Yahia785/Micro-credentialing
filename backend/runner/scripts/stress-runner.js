#!/usr/bin/env node
// node scripts/stress-runner.js [--function micro-credentialing-runner-dev-recycle] [--region us-east-1] [--tenant]
//                               [--account-limit N] [--dry-run]
//
// Load test of the DEPLOYED C++ runner. It never touches Judge0 and never the backend: it invokes the runner function directly
// with your AWS credentials (lambda:InvokeFunction, lambda:GetFunctionConcurrency, lambda:GetAccountSettings).
//
// Workload (per call, like a student pressing Run): a typical program compiled once and run on 5 test inputs (85%), a slow
// program whose 5 runs all hit the 1 s time limit (10%), a program with a compile error (5%).
// Ramp: 1, 5, 10, 25, 50, 100 calls in parallel (stops at the first level where throttles + errors exceed 5%), then a 3-minute
// steady load of 2 calls per second.
//
// Before anything is invoked it prints the account's concurrent execution limit and the runner's reserved concurrency and
// asks for confirmation ("yes"), together with the planned number of calls and an estimated cost. Safety rules:
//   * never more than (account limit - 20) calls in parallel, so the rest of the backend keeps working;
//   * while the account limit is below 50 only levels 1 and 5 run, and the steady load is skipped. (With a limit under 40,
//     "limit - 20" would be below 20, so the cap there is half the limit: the other half stays free. A limit of 10 allows 5.)
// Report per level: p50 / p95 / max latency, cold starts, throttles (TooManyRequestsException), function errors, internal_error
// results, billed duration and its estimated cost. At the end: a recommended reserved concurrency and whether the account limit
// is enough for 100 students.
const path = require('path');

const LEVELS = [1, 5, 10, 25, 50, 100];
const STEADY_RATE = 2;            // calls per second
const STEADY_SECONDS = 180;
const ERROR_STOP = 0.05;          // stop when throttles + errors exceed 5% of a level
const MEMORY_MB = 1769;
const PRICE_GB_SECOND = 0.0000166667;
const PRICE_REQUEST = 0.20 / 1e6;
const HEADROOM = 20;              // concurrent executions always left to the rest of the backend
const UNRESERVED_MINIMUM = 100;   // AWS keeps at least this many unreserved when you reserve concurrency
// Typical billed time per call kind, only used for the estimate printed before the run (measured: ~0.16 s for hello world).
const ESTIMATE_SECONDS = { typical: 0.7, slow: 6.5, compileError: 0.4 };

// ---------- pure helpers (tested in test/stress-runner.test.js) ----------

const TYPICAL = [
  { source: '#include <iostream>\nint main(){int n; std::cin>>n; long long s=0; while(n--){long long x; std::cin>>x; s+=x;} std::cout<<s<<"\\n";}',
    inputs: ['3\n1 2 3\n', '1\n10\n', '5\n5 4 3 2 1\n', '0\n', '4\n-1 -2 -3 -4\n'] },
  { source: '#include <iostream>\n#include <vector>\n#include <algorithm>\nint main(){int n; std::cin>>n; std::vector<int> v(n); for(auto&x:v) std::cin>>x; std::sort(v.begin(),v.end()); for(int x:v) std::cout<<x<<" "; std::cout<<"\\n";}',
    inputs: ['3\n3 1 2\n', '1\n7\n', '5\n5 4 3 2 1\n', '2\n9 9\n', '4\n10 -3 8 0\n'] },
  { source: '#include <iostream>\nint main(){int n; std::cin>>n; long long a=0,b=1; for(int i=0;i<n;i++){long long t=a+b; a=b; b=t;} std::cout<<a<<"\\n";}',
    inputs: ['0\n', '1\n', '10\n', '40\n', '80\n'] },
  { source: '#include <iostream>\n#include <string>\n#include <algorithm>\nint main(){std::string s; std::getline(std::cin,s); std::reverse(s.begin(),s.end()); std::cout<<s<<"\\n";}',
    inputs: ['hello\n', 'a\n', 'racecar\n', 'two words\n', '12345\n'] },
  { source: '#include <iostream>\nint main(){int n; std::cin>>n; int c=0; for(int i=2;i<=n;i++){bool p=true; for(int j=2;j*j<=i;j++) if(i%j==0){p=false;break;} if(p) c++;} std::cout<<c<<"\\n";}',
    inputs: ['10\n', '100\n', '1000\n', '20000\n', '2\n'] }
];
const SLOW = { source: '#include <cstdio>\nint main(){ volatile long long x=0; while(true) x++; }', inputs: ['1\n', '2\n', '3\n', '4\n', '5\n'] };
const COMPILE_ERROR = { source: '#include <iostream>\nint main(){ int x = ; std::cout << x }', inputs: ['1\n', '2\n', '3\n', '4\n', '5\n'] };
const EXPECTED_STATUS = { typical: 'accepted', slow: 'time_limit', compileError: 'compile_error' };

/** Small deterministic generator, so a rerun sends the same mix. */
function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** n calls: 10% slow, 5% compile errors, the rest typical, in a shuffled order. */
function buildWorkload(n, seed = 1) {
  const slow = Math.round(n * 0.10);
  const bad = Math.round(n * 0.05);
  const kinds = [...Array(slow).fill('slow'), ...Array(bad).fill('compileError'), ...Array(Math.max(0, n - slow - bad)).fill('typical')].slice(0, n);
  const random = prng(seed);
  for (let i = kinds.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [kinds[i], kinds[j]] = [kinds[j], kinds[i]]; }
  return kinds.map(kind => {
    const program = kind === 'slow' ? SLOW : kind === 'compileError' ? COMPILE_ERROR : TYPICAL[Math.floor(random() * TYPICAL.length)];
    return { kind, event: { source: program.source, runs: program.inputs.map(stdin => ({ stdin })), timeLimitMs: kind === 'slow' ? 1000 : 2000, memoryLimitKb: 256000 } };
  });
}

/** Levels that may run, and the parallel-call cap, for an account limit. */
function planLevels(accountLimit) {
  const cap = accountLimit >= 40 ? accountLimit - HEADROOM : Math.floor(accountLimit / 2);
  let levels = accountLimit < 50 ? LEVELS.filter(l => l <= 5) : LEVELS;
  levels = levels.filter(l => l <= cap);
  return { cap, levels, steady: accountLimit >= 50 && cap >= 5 };
}

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : 0);

const costOf = (billedMs, requests) => (billedMs / 1000) * (MEMORY_MB / 1024) * PRICE_GB_SECOND + requests * PRICE_REQUEST;

/** Billed and init duration from the REPORT line of the invocation log tail. */
function parseReport(logTail) {
  const billed = /Billed Duration: (\d+) ms/.exec(logTail || '');
  const init = /Init Duration: ([\d.]+) ms/.exec(logTail || '');
  return { billedMs: billed ? Number(billed[1]) : null, coldStart: !!init, initMs: init ? Number(init[1]) : 0 };
}

function estimate(callCounts) {
  const calls = Object.values(callCounts).reduce((a, b) => a + b, 0);
  const seconds = Object.entries(callCounts).reduce((sum, [kind, n]) => sum + n * ESTIMATE_SECONDS[kind], 0);
  return { calls, billedSeconds: seconds, cost: costOf(seconds * 1000, calls) };
}

function summarize(results, wallMs) {
  const latencies = results.map(r => r.latencyMs).sort((a, b) => a - b);
  const billed = results.reduce((sum, r) => sum + (r.billedMs || 0), 0);
  return {
    calls: results.length,
    p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: latencies[latencies.length - 1] || 0,
    coldStarts: results.filter(r => r.coldStart).length,
    throttles: results.filter(r => r.throttled).length,
    functionErrors: results.filter(r => r.functionError).length,
    otherErrors: results.filter(r => r.error && !r.throttled).length,
    internalErrors: results.reduce((n, r) => n + (r.internalErrors || 0), 0),
    unexpected: results.filter(r => r.unexpected).length,
    billedMs: billed, cost: costOf(billed, results.length), wallMs
  };
}

const failureRate = s => (s.calls ? (s.throttles + s.functionErrors + s.otherErrors) / s.calls : 0);

/**
 * Recommendation from what was measured. Little's law: concurrency = calls per second x seconds per call. The worst case the
 * run limits allow is every student at 10 runs a minute (backend/shared/nodejs/services/run-limiter.js).
 */
function recommend({ accountLimit, meanLatencySec, highestCleanLevel, students = 100 }) {
  const worstSustained = Math.ceil(students * (10 / 60) * meanLatencySec);
  const wanted = Math.max(25, Math.ceil(worstSustained * 1.5));
  const reservable = Math.max(0, accountLimit - UNRESERVED_MINIMUM);
  const reserved = Math.min(wanted, reservable);
  const enough = accountLimit >= UNRESERVED_MINIMUM + wanted;
  return { worstSustained, wanted, reservable, reserved, enough, highestCleanLevel, students };
}

// ---------- the run ----------

function parseArgs(argv) {
  const o = { functionName: 'micro-credentialing-runner-dev-recycle', region: 'us-east-1', tenant: false, dryRun: false, accountLimit: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--function') o.functionName = argv[++i];
    else if (a === '--region') o.region = argv[++i];
    else if (a === '--tenant') o.tenant = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--account-limit') o.accountLimit = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const confirm = question => new Promise(resolve => {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, answer => { rl.close(); resolve(answer.trim().toLowerCase() === 'yes'); });
});

const ms = n => `${Math.round(n)} ms`;
const usd = n => `$${n.toFixed(4)}`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { createRequire } = require('module');
  const layer = createRequire(path.join(__dirname, '../../shared/nodejs/package.json'));
  const { LambdaClient, InvokeCommand, GetAccountSettingsCommand, GetFunctionConcurrencyCommand } = layer('@aws-sdk/client-lambda');
  const crypto = require('crypto');
  // maxAttempts 1: the SDK must not hide throttles by retrying them.
  const client = new LambdaClient({ region: opts.region, maxAttempts: 1 });

  let accountLimit = opts.accountLimit;
  let unreservedAccount = null;
  if (accountLimit === null) {
    const settings = await client.send(new GetAccountSettingsCommand({}));
    accountLimit = settings.AccountLimit.ConcurrentExecutions;
    unreservedAccount = settings.AccountLimit.UnreservedConcurrentExecutions;
  }
  let reserved = null;
  try {
    reserved = (await client.send(new GetFunctionConcurrencyCommand({ FunctionName: opts.functionName }))).ReservedConcurrentExecutions;
  } catch (error) {
    if (opts.accountLimit === null) console.log(`(could not read the reserved concurrency: ${error.message})`);
  }
  console.log(`Account concurrent execution limit: ${accountLimit}${unreservedAccount !== null ? ` (unreserved: ${unreservedAccount})` : ''}`);
  console.log(`Runner ${opts.functionName}: reserved concurrency ${reserved === undefined || reserved === null ? 'none (shares the account pool)' : reserved}`);

  const plan = planLevels(accountLimit);
  console.log(`Parallel-call cap: ${plan.cap} (rule: account limit - ${HEADROOM}${accountLimit < 40 ? '; below 40 it is half the limit' : ''})`);
  if (!plan.levels.length) { console.log('The account limit is too low to run any level safely. Nothing to do.'); return; }
  console.log(`Levels that will run: ${plan.levels.join(', ')}${plan.levels.length < LEVELS.length ? `  (skipped: ${LEVELS.filter(l => !plan.levels.includes(l)).join(', ')})` : ''}`);
  console.log(plan.steady ? `Steady load: ${STEADY_RATE} calls/s for ${STEADY_SECONDS / 60} minutes` : 'Steady load: skipped (account limit below 50)');

  const counts = { typical: 0, slow: 0, compileError: 0 };
  const tally = n => buildWorkload(n).forEach(c => counts[c.kind]++);
  plan.levels.forEach(tally);
  if (plan.steady) tally(STEADY_RATE * STEADY_SECONDS);
  const est = estimate(counts);
  console.log(`Planned calls: ${est.calls} at most (typical ${counts.typical}, slow ${counts.slow}, compile error ${counts.compileError}); each call runs 5 test inputs.`);
  console.log(`Estimated cost: about ${usd(est.cost)} (${est.billedSeconds.toFixed(0)} billed seconds at ${MEMORY_MB} MB; slow programs dominate; the real figure is printed at the end).`);
  if (opts.dryRun) { console.log('--dry-run: nothing was invoked.'); return; }
  if (!(await confirm('Start the load test against the deployed runner? Type "yes" to continue: '))) { console.log('Cancelled. Nothing was invoked.'); return; }

  const tenantId = opts.tenant ? crypto.createHash('sha256').update('stress-test').digest('hex') : undefined;
  const invokeOne = async ({ kind, event }) => {
    const started = Date.now();
    const out = { kind, latencyMs: 0 };
    try {
      const response = await client.send(new InvokeCommand({
        FunctionName: opts.functionName, InvocationType: 'RequestResponse', LogType: 'Tail',
        Payload: JSON.stringify(event), ...(tenantId ? { TenantId: tenantId } : {})
      }), { abortSignal: AbortSignal.timeout(120000) });
      out.latencyMs = Date.now() - started;
      Object.assign(out, parseReport(response.LogResult ? Buffer.from(response.LogResult, 'base64').toString('utf-8') : ''));
      if (response.FunctionError) out.functionError = response.FunctionError;
      else {
        const body = JSON.parse(Buffer.from(response.Payload).toString('utf-8'));
        if (body.error || !Array.isArray(body.results)) out.error = body.error || 'no results';
        else {
          out.internalErrors = body.results.filter(r => r.status === 'internal_error').length;
          // a typical program must be accepted, a slow one time_limit, a broken one compile_error
          out.unexpected = body.results.some(r => r.status !== EXPECTED_STATUS[kind]) && !out.internalErrors;
        }
      }
    } catch (error) {
      out.latencyMs = Date.now() - started;
      out.throttled = error.name === 'TooManyRequestsException';
      out.error = `${error.name}: ${error.message}`;
    }
    return out;
  };

  const table = [];
  const everything = [];
  let highestCleanLevel = 0;
  let stopped = false;
  for (const level of plan.levels) {
    const started = Date.now();
    const results = await Promise.all(buildWorkload(level, level).map(invokeOne));
    const s = summarize(results, Date.now() - started);
    everything.push(...results);
    table.push({ level: `${level} parallel`, ...row(s) });
    console.log(`  level ${level}: p50 ${ms(s.p50)}, p95 ${ms(s.p95)}, throttles ${s.throttles}, errors ${s.functionErrors + s.otherErrors}`);
    if (failureRate(s) > ERROR_STOP) { console.log(`  stopping: more than ${ERROR_STOP * 100}% throttles or errors at level ${level}`); stopped = true; break; }
    highestCleanLevel = level;
  }

  if (plan.steady && !stopped) {
    const workload = buildWorkload(STEADY_RATE * STEADY_SECONDS, 99);
    const results = [];
    const inFlight = new Set();
    const begin = Date.now();
    let skipped = 0;
    let abort = false;
    for (let i = 0; i < workload.length && !abort; i++) {
      const due = begin + (i * 1000) / STEADY_RATE;
      await new Promise(r => setTimeout(r, Math.max(0, due - Date.now())));
      if (inFlight.size >= plan.cap) { skipped++; continue; } // never above the cap
      const p = invokeOne(workload[i]).then(r => { results.push(r); inFlight.delete(p); });
      inFlight.add(p);
      if (results.length >= 20 && summarize(results, 0) && failureRate(summarize(results, 0)) > ERROR_STOP) abort = true;
    }
    await Promise.all(inFlight);
    const s = summarize(results, Date.now() - begin);
    everything.push(...results);
    table.push({ level: `steady ${STEADY_RATE}/s x ${STEADY_SECONDS}s`, ...row(s) });
    if (skipped) console.log(`  steady load: ${skipped} calls not sent because the parallel cap (${plan.cap}) was reached`);
    if (abort) console.log(`  steady load stopped early: more than ${ERROR_STOP * 100}% throttles or errors`);
  }

  console.table(table);
  const total = summarize(everything, 0);
  console.log(`Total: ${total.calls} calls, ${(total.billedMs / 1000).toFixed(1)} billed seconds, actual cost about ${usd(total.cost)} (${MEMORY_MB} MB x $${PRICE_GB_SECOND}/GB-s + $0.20 per million requests).`);
  if (total.unexpected) console.log(`NOTE: ${total.unexpected} call(s) returned a status other than the expected one (typical -> accepted, slow -> time_limit, broken -> compile_error).`);

  const meanLatencySec = everything.length ? everything.reduce((a, r) => a + r.latencyMs, 0) / everything.length / 1000 : 1;
  const rec = recommend({ accountLimit, meanLatencySec, highestCleanLevel });
  console.log('\nRecommendation');
  console.log(`  Worst sustained load for ${rec.students} students at the run limit (10 runs/min each, mean call ${meanLatencySec.toFixed(2)} s): about ${rec.worstSustained} concurrent executions.`);
  console.log(`  Highest parallel level that ran clean in this test: ${rec.highestCleanLevel}.`);
  if (rec.reservable === 0) {
    console.log(`  Reserved concurrency: cannot be set yet. AWS keeps ${UNRESERVED_MINIMUM} concurrent executions unreserved and the account limit is ${accountLimit}.`);
  } else {
    console.log(`  Reserved concurrency for the runner: ${rec.reserved}${rec.reserved < rec.wanted ? ` (the most the account allows; ${rec.wanted} is wanted)` : ''}. It guarantees the runner that many and stops a burst from taking more than that from the other functions.`);
  }
  console.log(rec.enough
    ? `  Account limit ${accountLimit}: enough for ${rec.students} students (needs ${UNRESERVED_MINIMUM} unreserved + ${rec.wanted} reserved).`
    : `  Account limit ${accountLimit}: NOT enough for ${rec.students} students (needs ${UNRESERVED_MINIMUM + rec.wanted}: ${UNRESERVED_MINIMUM} unreserved + ${rec.wanted} for the runner). Wait for the requested increase before an exam. Until then calls over the limit are throttled (TooManyRequestsException).`);
}

function row(s) {
  return { calls: s.calls, p50: ms(s.p50), p95: ms(s.p95), max: ms(s.max), coldStarts: s.coldStarts, throttles: s.throttles,
    functionErrors: s.functionErrors, otherErrors: s.otherErrors, internalErrors: s.internalErrors, billedMs: s.billedMs, cost: usd(s.cost) };
}

module.exports = { buildWorkload, planLevels, percentile, costOf, parseReport, estimate, summarize, failureRate, recommend, parseArgs, LEVELS };

if (require.main === module) main().catch(error => { console.error(error.message); process.exit(2); });
