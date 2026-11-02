/**
 * Our own runner provider for codeRunner (CODE_RUNNER=own).
 *
 * Invokes the C++ runner Lambda (backend/runner) named by CODE_RUNNER_FUNCTION. The runner compiles
 * once per call and runs every input, so runs that share the same source and limits go out in one
 * invocation; grading always sends a single group.
 *
 * Nothing here logs source, stdin or program output.
 */

const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

// Same margin judge0.js keeps for work after polling.
const DEADLINE_MARGIN_MS = 5000;

let client;
const getClient = () => {
  if (!client) client = new LambdaClient({});
  return client;
};

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
    message: raw.message || null
  };
}

async function invokeRunner(functionName, payload, deadlineMs) {
  const controller = new AbortController();
  let timer;
  if (deadlineMs !== undefined && deadlineMs !== null) {
    const budget = deadlineMs - DEADLINE_MARGIN_MS;
    if (budget <= 0) throw new Error('Own runner stopped: approaching Lambda timeout.');
    timer = setTimeout(() => controller.abort(), budget);
  }

  try {
    const response = await getClient().send(
      new InvokeCommand({ FunctionName: functionName, InvocationType: 'RequestResponse', Payload: JSON.stringify(payload) }),
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

async function runBatch(runs, { deadlineMs } = {}) {
  const functionName = process.env.CODE_RUNNER_FUNCTION;
  if (!functionName) throw new Error('CODE_RUNNER_FUNCTION is not set');

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
      runs: indexes.map(i => ({ stdin: runs[i].stdin, expectedOutput: runs[i].expectedOutput })),
      timeLimitMs: first.timeLimitMs,
      memoryLimitKb: first.memoryLimitKb
    }, deadlineMs);
    indexes.forEach((runIndex, i) => { results[runIndex] = groupResults[i]; });
  }));
  return results;
}

module.exports = { runBatch };
