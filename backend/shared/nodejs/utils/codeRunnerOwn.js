/**
 * Our own runner provider for codeRunner (CODE_RUNNER=own).
 *
 * Invokes the C++ runner Lambda (backend/runner) named by CODE_RUNNER_FUNCTION. The runner compiles
 * once per call and runs every input, so runs that share the same source and limits go out in one
 * invocation; grading always sends a single group.
 *
 * Tenant isolation: the runner Lambda is deployed with TenancyConfig PER_TENANT, so every invocation carries a tenant id and
 * Lambda never runs two tenants in the same execution environment (student code can read the runner's memory, so one
 * student's code must never share an environment with another student's). The tenant id is the SHA-256 of the user id
 * (hex, 64 characters), never the raw id. A call without a user id is refused. CODE_RUNNER_TENANT_ISOLATION=off is for the
 * fallback deployment (no tenant isolation, the runner ends its process after each call): no tenant id is sent then.
 *
 * The runner never receives the expected output (a student's code runs next to it). It answers "accepted"
 * when the program ran fine, and this provider compares the output with Judge0's rule (outputCompare.js)
 * and turns a mismatch into wrong_answer.
 *
 * Nothing here logs source, stdin or program output.
 */

const crypto = require('crypto');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { outputMatches } = require('./outputCompare');

// Same margin judge0.js keeps for work after polling.
const DEADLINE_MARGIN_MS = 5000;

let client;
const getClient = () => {
  if (!client) client = new LambdaClient({});
  return client;
};

/** Lambda tenant id for a user: a hash, so the user id itself never leaves the backend. */
function tenantIdFor(userId) {
  return crypto.createHash('sha256').update(String(userId), 'utf8').digest('hex');
}

function toResult(raw) {
  return {
    status: raw.status,
    stdout: raw.stdout || '',
    stderr: raw.stderr || '',
    compileOutput: raw.compileOutput || '',
    timeMs: raw.timeMs || 0,
    memoryKb: raw.memoryKb || 0,
    statusText: raw.statusText || null,
    runId: raw.runId || null,
    message: raw.message || null,
    stdoutInvalidUtf8: raw.stdoutInvalidUtf8 === true // used by the comparison, then dropped
  };
}

/** The runner says "accepted" for a program that ran fine; the verdict on its output is decided here. */
function withVerdict({ stdoutInvalidUtf8, ...result }, expectedOutput) {
  if (result.status !== 'accepted') return result;
  const noExpectedOutput = expectedOutput === undefined || expectedOutput === null || expectedOutput === '';
  // Output that is not valid UTF-8 cannot travel through the reply intact; it never equals a text answer.
  const matches = noExpectedOutput || (!stdoutInvalidUtf8 && outputMatches(expectedOutput, Buffer.from(result.stdout, 'utf-8')));
  if (matches) return { ...result, statusText: result.statusText || 'Accepted' };
  return { ...result, status: 'wrong_answer', statusText: 'Wrong Answer' };
}

async function invokeRunner(functionName, payload, deadlineMs, tenantId) {
  const controller = new AbortController();
  let timer;
  if (deadlineMs !== undefined && deadlineMs !== null) {
    const budget = deadlineMs - DEADLINE_MARGIN_MS;
    if (budget <= 0) throw new Error('Own runner stopped: approaching Lambda timeout.');
    timer = setTimeout(() => controller.abort(), budget);
  }

  try {
    const response = await getClient().send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify(payload),
        ...(tenantId ? { TenantId: tenantId } : {})
      }),
      { abortSignal: controller.signal }
    );
    const body = response.Payload ? Buffer.from(response.Payload).toString('utf-8') : '';
    if (response.FunctionError) {
      throw new Error(`Code runner function error: ${response.FunctionError}`);
    }
    const parsed = JSON.parse(body);
    if (parsed.error) throw new Error(`Code runner rejected the request: ${parsed.error}`);
    if (!Array.isArray(parsed.results) || parsed.results.length !== payload.runs.length) {
      throw new Error('Code runner returned an unexpected number of results');
    }
    return parsed.results.map(toResult);
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Own runner stopped: approaching Lambda timeout.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function runBatch(runs, { deadlineMs, userId } = {}) {
  const functionName = process.env.CODE_RUNNER_FUNCTION;
  if (!functionName) throw new Error('CODE_RUNNER_FUNCTION is not set');

  let tenantId;
  if (process.env.CODE_RUNNER_TENANT_ISOLATION !== 'off') {
    if (userId === undefined || userId === null || userId === '') throw new Error('Own runner needs a user id for tenant isolation');
    tenantId = tenantIdFor(userId);
  }

  const groups = new Map();
  runs.forEach((run, index) => {
    const key = JSON.stringify([run.source, run.timeLimitMs, run.memoryLimitKb]);
    if (!groups.has(key)) groups.set(key, { first: run, indexes: [] });
    groups.get(key).indexes.push(index);
  });

  const results = new Array(runs.length);
  await Promise.all([...groups.values()].map(async ({ first, indexes }) => {
    const groupResults = await invokeRunner(functionName, {
      source: first.source,
      runs: indexes.map(i => ({ stdin: runs[i].stdin })), // never the expected output
      timeLimitMs: first.timeLimitMs,
      memoryLimitKb: first.memoryLimitKb
    }, deadlineMs, tenantId);
    indexes.forEach((runIndex, i) => { results[runIndex] = withVerdict(groupResults[i], runs[runIndex].expectedOutput); });
  }));
  return results;
}

module.exports = { runBatch, tenantIdFor };
