// node run-deployed.js <function-name> [--region us-east-1]
//
// Checks the DEPLOYED runner and prints PASS / FAIL tables:
//   (a) diagnostics.seccomp is true (Landlock is reported, but not required: standard Lambda runs kernel 5.10)
//   (b) student code cannot open a socket to 1.1.1.1:443, 169.254.100.1:9001 or 127.0.0.1:9001 (the Lambda Runtime API)
//   (c) a program that prints its own environment (and a child's) shows no AWS variables
//   (d) no event this script sends contains expectedOutput, and the runner rejects an event that does
//   (e) IAM, with YOUR credentials (aws iam simulate-principal-policy on the runner role): ec2:CreateNetworkInterface is
//       denied when lambda:SourceFunctionArn is the runner's ARN (and allowed without it, so Lambda's own networking works);
//       s3:ListAllMyBuckets, dynamodb:Scan and secretsmanager:GetSecretValue are denied
//   (f) the full hostile corpus (hostile.js). Cases that rely on Landlock are marked SKIP when the kernel has none.
// Plus a few extra / informational rows. Exit code 0 only when nothing FAILED (SKIP and INFO do not count).
//
// Needs: lambda:InvokeFunction and lambda:GetFunctionConfiguration on the runner, iam:SimulatePrincipalPolicy, and the
// AWS CLI on the PATH for (e).
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

// The SDK lives in the shared layer's node_modules.
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

async function invoke(event, { timeoutMs = 90000, allowExpectedOutput = false } = {}) {
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
      new InvokeCommand({ FunctionName: functionName, InvocationType: 'RequestResponse', Payload: payload }),
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
  record(t, '(a) diagnostics.seccomp is true', pass(!!d && d.seccomp === true), `seccomp=${d ? d.seccomp : 'missing'}`);
  record(t, '(info) diagnostics.landlock (optional, needs kernel 5.13)', 'INFO', `landlock=${d ? d.landlock : 'missing'}`);
  const landlock = !!d && d.landlock === true;

  const out = await invoke(one(OUTBOUND, { timeLimitMs: 15000 }), { timeoutMs: 120000 });
  const ro = out.body.results && out.body.results[0];
  const lines = ro ? ro.stdout.trim().split('\n') : [];
  const wanted = ['1.1.1.1:443', '169.254.100.1:9001', '127.0.0.1:9001'];
  const ok = !!ro && ro.status === 'accepted' && lines.length === 3 && wanted.every((w, i) => lines[i].startsWith(w)) && !lines.some(l => /CONNECTED/.test(l));
  record(t, '(b) socket connects to 1.1.1.1:443, 169.254.100.1:9001, 127.0.0.1:9001 all fail', pass(ok), ro ? lines.join(' | ') : (out.functionError || 'no result'));

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

  record(t, '(extra) the function has no environment variables', pass(!config.Environment || Object.keys(config.Environment.Variables || {}).length === 0),
    JSON.stringify(Object.keys((config.Environment && config.Environment.Variables) || {})));
  record(t, '(extra) the function runs inside a VPC', pass(!!config.VpcConfig && (config.VpcConfig.SubnetIds || []).length > 0),
    `${((config.VpcConfig || {}).SubnetIds || []).length} subnets, ${((config.VpcConfig || {}).SecurityGroupIds || []).length} security group(s)`);
  return { landlock };
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

async function hostileCorpus(landlock) {
  const t = 'hostile';
  for (const c of cases) {
    if (skip.has(c.name)) continue;
    if (c.needsLandlock && !landlock) { record(t, c.name, 'SKIP', 'protection is the Landlock file policy; this kernel has none'); continue; }
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
    if (diagnostics.seccomp === false) problems.push('seccomp false');

    // The next call must be clean and healthy (this also proves a killed runtime came back).
    const probe = await invoke(one('#include <cstdio>\nint main(){puts("hi");}'));
    const pr = probe.body.results && probe.body.results[0];
    if (!pr || pr.status !== 'accepted' || pr.stdout.trim() !== 'hi') problems.push(`next call not healthy (${pr ? pr.status : probe.functionError})`);

    record(t, c.name, problems.length ? 'FAIL' : 'PASS',
      problems.length ? problems.join('; ') : `${r ? r.status : 'function error'}, ${wallMs} ms${diagnostics.leftoverKilled ? `, ${diagnostics.leftoverKilled} leftover killed` : ''}`);
  }
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

  const { landlock } = await sandboxChecks(config);
  iamChecks(config);
  const before = rows.length;
  await hostileCorpus(landlock);

  for (const table of ['deployment', 'iam', 'hostile']) {
    console.log(`\n${table}`);
    console.table(rows.filter(r => r.table === table).map(({ check, result, detail }) => ({ check, result, detail })));
  }
  const count = result => rows.filter(r => r.result === result).length;
  console.log(`\nPASS ${count('PASS')}   FAIL ${count('FAIL')}   SKIP ${count('SKIP')}   INFO ${count('INFO')}   (hostile cases run: ${rows.length - before})`);
  console.log(count('FAIL') === 0 ? 'ALL PASS' : `${count('FAIL')} FAILED`);
  process.exit(count('FAIL') === 0 ? 0 : 1);
})();
