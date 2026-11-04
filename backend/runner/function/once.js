/**
 * One worker = one invocation. Started by the bootstrap (bootstrap.c), it talks to the Lambda Runtime API directly:
 *   GET  /2018-06-01/runtime/invocation/next            the event (headers: request id, deadline, tenant id)
 *   POST /2018-06-01/runtime/invocation/<id>/response   the handler's result
 *   POST /2018-06-01/runtime/invocation/<id>/error      the handler threw
 *   POST /2018-06-01/runtime/init/error                 the handler could not even be loaded
 * and then exits, so the next invocation gets a fresh process (new memory, new baseline of processes).
 * The request handling itself is index.js, unchanged. The deadline header feeds context.getRemainingTimeInMillis(),
 * which the handler uses for its own timeout logic.
 */
const http = require('http');

const API = process.env.AWS_LAMBDA_RUNTIME_API || '';
const BASE = '/2018-06-01/runtime';

function request(method, path, body, headers = {}) {
  const [host, port] = API.split(':');
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port: Number(port) || 80, method, path, agent: false, headers: body === undefined ? headers : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const errorBody = error => JSON.stringify({ errorType: (error && error.name) || 'Error', errorMessage: String((error && error.message) || error), stackTrace: [] });

let invocationId = null;
let finished = false;

async function postError(error) {
  const body = errorBody(error);
  const headers = { 'Lambda-Runtime-Function-Error-Type': 'Runtime.HandlerFailure' };
  if (invocationId) await request('POST', `${BASE}/invocation/${invocationId}/error`, body, headers);
  else await request('POST', `${BASE}/init/error`, body, { 'Lambda-Runtime-Function-Error-Type': 'Runtime.InitError' });
}

function die(error, code) {
  if (finished) return;
  finished = true;
  console.error('Runner worker failure', { message: String((error && error.message) || error) });
  postError(error).catch(() => {}).finally(() => process.exit(code));
}

process.on('uncaughtException', error => die(error, 2));
process.on('unhandledRejection', error => die(error, 2));

async function main() {
  if (!API) throw new Error('AWS_LAMBDA_RUNTIME_API is not set');
  let handler;
  try {
    ({ handler } = require('./index'));
  } catch (error) {
    die(error, 3);
    return;
  }

  const next = await request('GET', `${BASE}/invocation/next`);
  if (next.status !== 200) throw new Error(`Runtime API /next returned ${next.status}`);
  invocationId = next.headers['lambda-runtime-aws-request-id'];
  const deadline = Number(next.headers['lambda-runtime-deadline-ms']);
  const context = {
    awsRequestId: invocationId,
    invokedFunctionArn: next.headers['lambda-runtime-invoked-function-arn'],
    tenantId: next.headers['lambda-runtime-aws-tenant-id'],
    getRemainingTimeInMillis: () => (Number.isFinite(deadline) ? deadline - Date.now() : 0)
  };

  let result;
  try {
    result = await handler(JSON.parse(next.body), context);
  } catch (error) {
    die(error, 1);
    return;
  }
  const posted = await request('POST', `${BASE}/invocation/${invocationId}/response`, JSON.stringify(result === undefined ? null : result));
  finished = true;
  process.exit(posted.status === 202 ? 0 : 4);
}

main().catch(error => die(error, 2));
