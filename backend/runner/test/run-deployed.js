// node run-deployed.js <function-name> [--region us-east-1]
//
// Checks the DEPLOYED runner and prints PASS / FAIL tables:
//   (a) the launcher started the program safely (diagnostics.sandboxStep is none). diagnostics.seccomp and .landlock are
//       INFO only: standard Lambda refuses our seccomp filter and has no Landlock; Lambda's own filter is the sandbox there
//   (b) student code cannot connect to 1.1.1.1:443 or 169.254.100.1:9001. 127.0.0.1:9001 (the Lambda Runtime API) is reported
//       as INFO: without our seccomp filter student code can reach it (see SECURITY.md)
//   (c) a program that prints its own environment (and a child's) shows no AWS variables
//   (d) no event this script sends contains expectedOutput, and the runner rejects an event that does
//   (e) IAM, with YOUR credentials (aws iam simulate-principal-policy on the runner role): ec2:CreateNetworkInterface is
//       denied when lambda:SourceFunctionArn is the runner's ARN (and allowed without it, so Lambda's own networking works);
//       s3:ListAllMyBuckets, dynamodb:Scan and secretsmanager:GetSecretValue are denied
//   (f) the full hostile corpus (hostile.js). Cases that rely on Landlock or on our seccomp filter are marked SKIP when the
//       platform did not give us that protection.
//   (g) isolation between students: with tenant isolation, calls with different tenant ids never share an execution
//       environment (environment ids compared), and a call without a tenant id is refused; and, always (custom runtime,
//       one fresh worker process per invocation), every call reports call #1 and none returns a FunctionError.
//       Also prints the wall time of each of 10 sequential calls.
// Plus a few extra / informational rows. Exit code 0 only when nothing FAILED (SKIP and INFO do not count).
//
// Needs: lambda:InvokeFunction and lambda:GetFunctionConfiguration on the runner, iam:SimulatePrincipalPolicy, and the
// AWS CLI on the PATH for (e).
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

// The SDK lives in the shared layer's node_modules.
const crypto = require('crypto');
const requireFromLayer = createRequire(path.join(__dirname, '../../shared/nodejs/package.json'));
const { LambdaClient, InvokeCommand, GetFunctionConfigurationCommand } = requireFromLayer('@aws-sdk/client-lambda');
const cases = require('./hostile');
const { OUTBOUND, ENV_PRINT, ENVIRON, PTRACE_SCOPE, PROC_MEM } = require('./deployed-probes');

// ---- arguments: <function-name> [--region <region>] in any order ----
function parseArgs(argv) {
  let functionName = null;
  let region = 'us-east-1';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--region') {
      region = argv[++i];
      if (!region || region.startsWith('--')) return null;
    } else if (argv[i].startsWith('--')) {
      return null;
    } else if (functionName === null) {
      functionName = argv[i];
    } else {
      return null;
    }
  }
  return functionName ? { functionName, region } : null;
}
const parsed = parseArgs(process.argv.slice(2));
if (!parsed) {
  console.error('usage: node run-deployed.js <function-name> [--region us-east-1]');
  process.exit(2);
}
const { functionName, region } = parsed;
const client = new LambdaClient({ region });

// ---- invoking the runner. Every event goes through here, and none may contain expectedOutput ----
let eventsSent = 0;
let eventsWithExpectedOutput = 0;

// Tenant isolation: every invocation carries a tenant id (a hash, like the backend sends). Set from the function's configuration.
let tenantMode = false;
const tenantFor = label => crypto.createHash('sha256').update(`run-deployed:${label}`).digest('hex');
const MAIN_TENANT = tenantFor('main');

/** tenant: undefined = the main tenant, null = send no tenant id, a string = that tenant id. */
async function invoke(event, { timeoutMs = 90000, allowExpectedOutput = false, tenant } = {}) {
  const payload = JSON.stringify(event);
  if (payload.includes('expectedOutput')) {
    if (!allowExpectedOutput) throw new Error('BUG: this script tried to send an event that contains expectedOutput');
    eventsWithExpectedOutput++;
  } else {
    eventsSent++;
  }
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await client.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'RequestResponse',
        Payload: payload,
        ...(tenantMode && tenant !== null ? { TenantId: tenant === undefined ? MAIN_TENANT : tenant } : {})
      }),
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

const one = (source, { timeLimitMs = 4000, memoryLimitKb = 128000 } = {}) => ({ source, runs: [{ stdin: '' }], timeLimitMs, memoryLimitKb });

const rows = [];
const record = (table, check, result, detail) => rows.push({ table, check, result, detail });
const pass = ok => (ok ? 'PASS' : 'FAIL');

/** Run the AWS CLI with the caller's own credentials. */
function aws(args) {
  const out = spawnSync('aws', [...args, '--region', region, '--output', 'json'], { encoding: 'utf-8', shell: process.platform === 'win32' });
  if (out.status !== 0) throw new Error((out.stderr || out.error?.message || 'aws failed').trim().slice(0, 300));
  return JSON.parse(out.stdout);
}

function simulate(roleArn, actions, contextEntries) {
  const args = ['iam', 'simulate-principal-policy', '--policy-source-arn', roleArn, '--action-names', ...actions, '--resource-arns', '*'];
  if (contextEntries) args.push('--context-entries', contextEntries);
  const decisions = {};
  for (const r of aws(args).EvaluationResults) decisions[r.EvalActionName] = r.EvalDecision;
  return decisions;
}

// ---- (a)-(d) and the function's configuration ----

async function sandboxChecks(config) {
  const t = 'deployment';

  const b = await invoke(one('#include <cstdio>\nint main(){puts("ok");}'));
  const d = b.body.diagnostics;
  record(t, '(a) the launcher started the program safely (diagnostics.sandboxStep is none)', pass(!!d && d.sandboxStep === 'none'),
    d ? `sandboxStep=${d.sandboxStep} errno=${d.errno}` : (b.functionError || 'no result'));
  record(t, '(info) diagnostics.seccomp (our filter; Lambda\'s own filter refuses it)', 'INFO',
    d ? `seccomp=${d.seccomp} seccompErrno=${d.seccompErrno} nnp=${d.nnp} subreaperErrno=${d.subreaperErrno}` : 'missing');
  record(t, '(info) diagnostics.landlock (optional, needs kernel 5.13)', 'INFO', `landlock=${d ? d.landlock : 'missing'}`);
  const landlock = !!d && d.landlock === true;
  const seccomp = !!d && d.seccomp === true;

  const out = await invoke(one(OUTBOUND, { timeLimitMs: 15000 }), { timeoutMs: 120000 });
  const ro = out.body.results && out.body.results[0];
  const lines = ro ? ro.stdout.trim().split('\n') : [];
  const wanted = ['1.1.1.1:443', '169.254.100.1:9001', '127.0.0.1:9001'];
  const shaped = !!ro && ro.status === 'accepted' && lines.length === 3 && wanted.every((w, i) => lines[i].startsWith(w));
  const connected = address => lines.some(l => l.startsWith(address) && /CONNECTED/.test(l));
  record(t, '(b) a socket connect to 1.1.1.1:443 (the internet) fails', pass(shaped && !connected('1.1.1.1:443')), ro ? lines[0] : (out.functionError || 'no result'));
  record(t, '(b) a socket connect to 169.254.100.1:9001 fails', pass(shaped && !connected('169.254.100.1:9001')), ro ? lines[1] : (out.functionError || 'no result'));
  record(t, '(info) a socket connect to 127.0.0.1:9001 (the Lambda Runtime API)', 'INFO',
    ro ? `${lines[2]}${connected('127.0.0.1:9001') ? '  <- reachable from student code; see SECURITY.md' : ''}` : (out.functionError || 'no result'));

  const env = await invoke(one(ENV_PRINT));
  const re = env.body.results && env.body.results[0];
  record(t, '(c) a program printing its own environment shows no AWS variables', pass(!!re && re.status === 'accepted' && re.stdout.trim() === 'count=0\nchild_aws=0'),
    re ? re.stdout.trim().replace(/\n/g, ' | ').slice(0, 160) : (env.functionError || 'no result'));

  const envProc = await invoke(one(ENVIRON));
  const rp = envProc.body.results && envProc.body.results[0];
  record(t, '(info) other processes\' /proc/*/environ readable by student code', 'INFO',
    rp ? (/LEAK/.test(rp.stdout) ? 'yes: Lambda\'s environment (AWS_*) is readable, so the role must be worthless (see (e))' : `no AWS variables found (${rp.stdout.trim()} bytes read)`) : 'no result');

  const yama = await invoke(one(PTRACE_SCOPE));
  const ry = yama.body.results && yama.body.results[0];
  record(t, '(info) /proc/sys/kernel/yama/ptrace_scope as seen by student code', 'INFO',
    ry ? (ry.status === 'accepted' ? ry.stdout.trim() : `${ry.status}: ${ry.compileOutput.slice(0, 100)}`) : (yama.functionError || 'no result'));

  const mem = await invoke(one(PROC_MEM));
  const rm = mem.body.results && mem.body.results[0];
  record(t, '(info) /proc/<pid>/mem of the parent and grandparent from student code', 'INFO',
    rm ? (rm.status === 'accepted' ? rm.stdout.trim().replace(/\n/g, ' | ') : `${rm.status}: ${rm.compileOutput.slice(0, 100)}`) : (mem.functionError || 'no result'));

  const rejected = await invoke({ ...one('int main(){}'), runs: [{ stdin: '', expectedOutput: 'x' }] }, { allowExpectedOutput: true });
  record(t, '(d) no event this script sent contained expectedOutput', pass(eventsSent > 0), `${eventsSent} events checked before sending`);
  record(t, '(d) the runner rejects an event that contains expectedOutput', pass(/expectedOutput is not accepted/.test(rejected.body.error || '') && (rejected.body.results || []).length === 0),
    rejected.body.error || rejected.functionError || 'not rejected');

  // One switch, no secrets: REQUIRE_TENANT_ID.
  const variables = (config.Environment && config.Environment.Variables) || {};
  const allowed = new Set(['REQUIRE_TENANT_ID']);
  record(t, '(extra) the function\'s only environment variable is the REQUIRE_TENANT_ID switch (no secrets)',
    pass(Object.keys(variables).every(k => allowed.has(k)) && variables.REQUIRE_TENANT_ID === (tenantMode ? 'true' : 'false')),
    JSON.stringify(variables));
  record(t, `(extra) tenant isolation is ${tenantMode ? 'on (TenancyConfig PER_TENANT)' : 'OFF (default): every call still runs in a fresh worker process'}`, 'INFO',
    JSON.stringify(config.TenancyConfig || null));
  record(t, '(extra) the function runs inside a VPC', pass(!!config.VpcConfig && (config.VpcConfig.SubnetIds || []).length > 0),
    `${((config.VpcConfig || {}).SubnetIds || []).length} subnets, ${((config.VpcConfig || {}).SecurityGroupIds || []).length} security group(s)`);
  return { landlock, seccomp };
}

// ---- (e) IAM ----

function iamChecks(config) {
  const t = 'iam';
  const roleArn = config.Role;
  const functionArn = config.FunctionArn.split(':').slice(0, 7).join(':'); // without a version suffix
  try {
    const withKey = simulate(roleArn, ['ec2:CreateNetworkInterface'], `ContextKeyName=lambda:SourceFunctionArn,ContextKeyValues=${functionArn},ContextKeyType=string`);
    record(t, '(e) ec2:CreateNetworkInterface denied when lambda:SourceFunctionArn is the runner', pass(withKey['ec2:CreateNetworkInterface'] === 'explicitDeny'),
      `${withKey['ec2:CreateNetworkInterface']}  (${functionArn})`);

    const without = simulate(roleArn, ['ec2:CreateNetworkInterface']);
    record(t, '(e) ...and allowed without it, so Lambda\'s own VPC networking keeps working', pass(without['ec2:CreateNetworkInterface'] === 'allowed'),
      without['ec2:CreateNetworkInterface']);

    const others = simulate(roleArn, ['s3:ListAllMyBuckets', 'dynamodb:Scan', 'secretsmanager:GetSecretValue']);
    for (const action of ['s3:ListAllMyBuckets', 'dynamodb:Scan', 'secretsmanager:GetSecretValue']) {
      record(t, `(e) ${action} denied`, pass(others[action] === 'implicitDeny' || others[action] === 'explicitDeny'), others[action]);
    }
  } catch (error) {
    record(t, '(e) IAM simulation could not run', 'FAIL', error.message);
  }
}

// ---- (f) hostile corpus ----

// Cases whose original check looks for the FAKE secret that only exists in the Docker tests.
const skip = new Set(['read /proc/*/environ for the secret']);
const overrideCheck = {
  'compile: #include /proc/*/environ must not leak the secret': r => !/AWS_|LAMBDA_|_HANDLER/.test(r.compileOutput)
};

async function hostileCorpus({ landlock, seccomp }) {
  const t = 'hostile';
  for (const c of cases) {
    if (skip.has(c.name)) continue;
    if (c.needsLandlock && !landlock) { record(t, c.name, 'SKIP', 'protection is the Landlock file policy; this kernel has none'); continue; }
    if (c.needsSeccomp && !seccomp) { record(t, c.name, 'SKIP', 'checks our own seccomp filter, which Lambda\'s filter refuses; Lambda\'s filter is the sandbox here'); continue; }
    const limits = { timeLimitMs: c.timeLimitMs || 1000, memoryLimitKb: c.memoryLimitKb || 128000 };
    const { body, functionError, wallMs } = await invoke({ source: c.source, runs: [{ stdin: '' }], ...limits });
    const r = body.results && body.results[0];
    const diagnostics = body.diagnostics || {};
    const problems = [];

    if (c.expectDeath) {
      if (r && r.status !== 'internal_error') problems.push(`expected the function to fail, got ${r.status}`);
    } else if (!r) {
      problems.push(functionError ? `function error: ${functionError}` : 'no result');
    } else {
      if (c.expect !== 'any' && r.status !== c.expect) problems.push(`status ${r.status}, wanted ${c.expect}`);
      if (c.expectStdout !== undefined && r.stdout.trim() !== c.expectStdout) problems.push(`stdout ${JSON.stringify(r.stdout.trim().slice(0, 80))}, wanted ${JSON.stringify(c.expectStdout)}`);
      const check = overrideCheck[c.name] || c.check;
      if (check && !check(r)) problems.push('content check failed');
      if (r.status === 'internal_error' && !c.allowInternal) problems.push(`internal_error: ${r.message}`);
    }
    if (wallMs > (c.maxWallMs || 6000) + 4000) problems.push(`took ${wallMs} ms`);
    if (diagnostics.survivors) problems.push(`${diagnostics.survivors} process(es) survived`);
    if (diagnostics.sandboxStep && diagnostics.sandboxStep !== 'none') problems.push(`sandbox step ${diagnostics.sandboxStep} failed (errno ${diagnostics.errno})`);

    // The next call must be clean and healthy (this also proves a killed runtime came back).
    const probe = await invoke(one('#include <cstdio>\nint main(){puts("hi");}'));
    const pr = probe.body.results && probe.body.results[0];
    if (!pr || pr.status !== 'accepted' || pr.stdout.trim() !== 'hi') problems.push(`next call not healthy (${pr ? pr.status : probe.functionError})`);

    record(t, c.name, problems.length ? 'FAIL' : 'PASS',
      problems.length ? problems.join('; ') : `${r ? r.status : 'function error'}, ${wallMs} ms${diagnostics.leftoverKilled ? `, ${diagnostics.leftoverKilled} leftover killed` : ''}`);
  }
}

// ---- (g) isolation between students, and how long a call takes ----

const TRIVIAL = '#include <cstdio>\nint main(){puts("ok");}';

async function isolationChecks() {
  const t = 'isolation';
  const call = async tenant => {
    const r = await invoke(one(TRIVIAL), tenant === undefined ? {} : { tenant });
    const d = r.body.diagnostics || {};
    return { env: d.environmentId, calls: d.callsInEnvironment, ms: r.wallMs, error: r.functionError || r.body.error || null };
  };

  if (tenantMode) {
    const A = tenantFor('isolation-A');
    const B = tenantFor('isolation-B');
    const seen = { A: new Set(), B: new Set() };
    let failed = 0;
    for (let i = 0; i < 8; i++) {
      for (const [name, id] of [['A', A], ['B', B]]) {
        const r = await call(id);
        if (r.env) seen[name].add(r.env); else failed++;
      }
    }
    // Two tenants at the same moment force two environments to exist at once.
    const [ca, cb] = await Promise.all([call(A), call(B)]);
    if (ca.env) seen.A.add(ca.env); else failed++;
    if (cb.env) seen.B.add(cb.env); else failed++;
    const shared = [...seen.A].filter(e => seen.B.has(e));
    record(t, '(g) tenants A and B never share an execution environment', pass(failed === 0 && seen.A.size > 0 && seen.B.size > 0 && shared.length === 0),
      `A used ${seen.A.size} environment(s), B used ${seen.B.size}, shared ${shared.length}${failed ? `, ${failed} calls failed` : ''}`);

    const none = await call(null);
    record(t, '(g) a call without a tenant id is refused', pass(!!none.error && !none.env), none.error ? String(none.error).slice(0, 160) : 'it ran!');
  }

  // Every call runs in a brand-new worker process (custom runtime: bootstrap + one-shot worker), tenant isolation or not:
  // every call reports call #1 and no call returns a FunctionError. Per-call wall time over 10 sequential calls.
  const ids = [];
  const counts = [];
  const errors = [];
  const times = [];
  for (let i = 0; i < 10; i++) {
    const r = await call(tenantMode ? tenantFor('isolation-A') : undefined);
    ids.push(r.env);
    counts.push(r.calls);
    times.push(r.ms);
    if (r.error) errors.push(`#${i + 1}: ${String(r.error).slice(0, 80)}`);
  }
  record(t, '(g) every call runs in a fresh worker: call #1 each time, no FunctionError (10 sequential calls)',
    pass(errors.length === 0 && ids.every(Boolean) && new Set(ids).size === ids.length && counts.every(n => n === 1)),
    `calls-in-environment ${JSON.stringify(counts)}, ${ids.length - new Set(ids).size} repeated environment id(s)${errors.length ? `, errors: ${errors.join('; ')}` : ''}`);
  const sorted = [...times].sort((x, y) => x - y);
  record(t, '(info) wall time per call, 10 sequential trivial calls (compile + run + worker start)', 'INFO',
    `${times.join(', ')} ms; min ${sorted[0]}, median ${sorted[Math.floor(sorted.length / 2)]}, max ${sorted[sorted.length - 1]}`);
}

(async () => {
  console.log(`Runner: ${functionName} (${region})`);
  let config;
  try {
    config = await client.send(new GetFunctionConfigurationCommand({ FunctionName: functionName }));
  } catch (error) {
    console.error(`Cannot read the function configuration: ${error.message}`);
    process.exit(2);
  }

  tenantMode = !!(config.TenancyConfig && config.TenancyConfig.TenantIsolationMode === 'PER_TENANT');
  console.log(`Tenant isolation: ${tenantMode ? 'on (PER_TENANT)' : 'off (default; every call runs in a fresh worker process)'}`);

  const protections = await sandboxChecks(config);
  iamChecks(config);
  await isolationChecks();
  const before = rows.length;
  await hostileCorpus(protections);

  for (const table of ['deployment', 'iam', 'isolation', 'hostile']) {
    console.log(`\n${table}`);
    console.table(rows.filter(r => r.table === table).map(({ check, result, detail }) => ({ check, result, detail })));
  }
  const count = result => rows.filter(r => r.result === result).length;
  console.log(`\nPASS ${count('PASS')}   FAIL ${count('FAIL')}   SKIP ${count('SKIP')}   INFO ${count('INFO')}   (hostile cases run: ${rows.length - before})`);
  console.log(count('FAIL') === 0 ? 'ALL PASS' : `${count('FAIL')} FAILED`);
  process.exit(count('FAIL') === 0 ? 0 : 1);
})();
