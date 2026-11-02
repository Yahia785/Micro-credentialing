// node run-deployed.js <function-name> [--region us-east-1]
//
// Invokes the DEPLOYED runner with the AWS SDK (default credential chain) and prints a pass/fail table:
//   1. three deployment checks: (a) outbound TCP connect fails, (b) diagnostics.landlock is true,
//      (c) reading /proc/*/environ gets nothing
//   2. the hostile corpus (hostile.js), with the checks that need Docker (process list, /tmp listing)
//      replaced by what the function reports itself (diagnostics.survivors) and a clean follow-up call.
//
// The invoking identity needs lambda:InvokeFunction on the runner. The role of the function itself
// has no permissions; "can't read any AWS resource" is checked from the function side below.
const path = require('path');
const { createRequire } = require('module');

// The SDK lives in the shared layer's node_modules.
const requireFromLayer = createRequire(path.join(__dirname, '../../shared/nodejs/package.json'));
const { LambdaClient, InvokeCommand } = requireFromLayer('@aws-sdk/client-lambda');
const cases = require('./hostile');
const { OUTBOUND, ENVIRON, AWS_CALL } = require('./deployed-probes');

const args = process.argv.slice(2);
const functionName = args.find(a => !a.startsWith('--'));
const regionIndex = args.indexOf('--region');
const region = regionIndex >= 0 ? args[regionIndex + 1] : 'us-east-1';
if (!functionName || functionName === args[regionIndex + 1]) {
  console.error('usage: node run-deployed.js <function-name> [--region us-east-1]');
  process.exit(2);
}

const client = new LambdaClient({ region });

async function invoke(event, timeoutMs = 90000) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await client.send(
      new InvokeCommand({ FunctionName: functionName, InvocationType: 'RequestResponse', Payload: JSON.stringify(event) }),
      { abortSignal: controller.signal }
    );
    const text = response.Payload ? Buffer.from(response.Payload).toString('utf-8') : '';
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
    return { body, functionError: response.FunctionError || null, wallMs: Date.now() - started };
  } catch (error) {
    return { body: {}, functionError: `invoke failed: ${error.message}`, wallMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

const one = (source, extra = {}) => ({
  source, runs: [{ stdin: '', expectedOutput: extra.expectedOutput }], timeLimitMs: extra.timeLimitMs || 4000, memoryLimitKb: 128000
});

// ---- three deployment checks ----

async function deploymentChecks() {
  const rows = [];
  const record = (check, ok, detail) => rows.push({ check, result: ok ? 'PASS' : 'FAIL', detail });

  const a = await invoke(one(OUTBOUND, { expectedOutput: 'blocked', timeLimitMs: 15000 }), 120000);
  const ra = a.body.results && a.body.results[0];
  record('(a) outbound TCP connect from student code fails', !!ra && ra.status === 'accepted' && ra.stdout.trim() === 'blocked',
    ra ? `${ra.status}: ${ra.stdout.trim() || ra.message || ''}` : (a.functionError || 'no result'));

  const b = await invoke(one('#include <cstdio>\nint main(){puts("ok");}', { expectedOutput: 'ok' }));
  record('(b) diagnostics.landlock is true', !!b.body.diagnostics && b.body.diagnostics.landlock === true,
    `landlock=${b.body.diagnostics ? b.body.diagnostics.landlock : 'missing'}`);

  const c = await invoke(one(ENVIRON, { expectedOutput: '0' }));
  const rc = c.body.results && c.body.results[0];
  record('(c) reading /proc/*/environ gets nothing', !!rc && rc.status === 'accepted' && rc.stdout.trim() === '0',
    rc ? `${rc.status}: ${rc.stdout.trim()}` : (c.functionError || 'no result'));

  const d = await invoke(one(AWS_CALL, { expectedOutput: 'none' }));
  const rd = d.body.results && d.body.results[0];
  record('(extra) no AWS credentials in the program environment', !!rd && rd.status === 'accepted' && rd.stdout.trim() === 'none',
    rd ? `${rd.status}: ${rd.stdout.trim()}` : (d.functionError || 'no result'));
  return rows;
}

// ---- hostile corpus ----

// Cases whose original check looks for the FAKE secret that only exists in the Docker tests.
const skip = new Set(['read /proc/*/environ for the secret']);
const overrideCheck = {
  'compile: #include /proc/*/environ must not leak the secret': r => !/AWS_|LAMBDA_|_HANDLER/.test(r.compileOutput)
};

async function hostileCorpus() {
  const rows = [];
  for (const t of cases) {
    if (skip.has(t.name)) continue;
    const limits = { timeLimitMs: t.timeLimitMs || 1000, memoryLimitKb: t.memoryLimitKb || 128000 };
    const { body, functionError, wallMs } = await invoke({ source: t.source, runs: [{ stdin: '', expectedOutput: t.expectedOutput }], ...limits });
    const r = body.results && body.results[0];
    const diagnostics = body.diagnostics || {};
    const problems = [];

    if (t.expectDeath) {
      if (r && r.status !== 'internal_error') problems.push(`expected the function to fail, got ${r.status}`);
    } else if (!r) {
      problems.push(functionError ? `function error: ${functionError}` : 'no result');
    } else {
      if (t.expect !== 'any' && r.status !== t.expect) problems.push(`status ${r.status}, wanted ${t.expect}`);
      const check = overrideCheck[t.name] || t.check;
      if (check && !check(r)) problems.push('content check failed');
      if (r.status === 'internal_error' && !t.allowInternal) problems.push(`internal_error: ${r.message}`);
    }
    if (wallMs > (t.maxWallMs || 6000) + 4000) problems.push(`took ${wallMs} ms`);
    if (diagnostics.survivors) problems.push(`${diagnostics.survivors} process(es) survived`);
    if (diagnostics.landlock === false) problems.push('landlock false');

    // The next call must be clean and healthy (this also proves a killed runtime came back).
    const probe = await invoke(one('#include <cstdio>\nint main(){puts("hi");}', { expectedOutput: 'hi' }));
    const pr = probe.body.results && probe.body.results[0];
    if (!pr || pr.status !== 'accepted') problems.push(`next call not healthy (${pr ? pr.status : probe.functionError})`);

    rows.push({
      case: t.name, status: r ? r.status : (t.expectDeath ? 'function error' : 'none'), ms: wallMs,
      killed: diagnostics.leftoverKilled ?? '', result: problems.length ? `FAIL ${problems.join('; ')}` : 'PASS'
    });
  }
  return rows;
}

(async () => {
  console.log(`Runner: ${functionName} (${region})`);
  const deployment = await deploymentChecks();
  console.table(deployment);
  const hostile = await hostileCorpus();
  console.table(hostile);

  const failed = deployment.filter(r => r.result !== 'PASS').length + hostile.filter(r => r.result !== 'PASS').length;
  console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
