// node --test test/once.test.js   (no Docker needed)
// once.js against a fake Lambda Runtime API: one worker handles exactly one invocation (GET next, POST response or error)
// and then exits; the deadline and tenant headers reach the handler's context.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WORKER = path.join(__dirname, '../function/once.js');

/** Serves one invocation and records what the worker posts back. */
function fakeApi(event, headers = {}) {
  const seen = { posts: [], nextCalls: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/2018-06-01/runtime/invocation/next') {
        seen.nextCalls++;
        res.writeHead(200, { 'Lambda-Runtime-Aws-Request-Id': 'req-1', 'Lambda-Runtime-Deadline-Ms': String(Date.now() + 20000), ...headers });
        res.end(typeof event === 'string' ? event : JSON.stringify(event));
      } else {
        seen.posts.push({ url: req.url, body: Buffer.concat(chunks).toString('utf-8'), errorType: req.headers['lambda-runtime-function-error-type'] });
        res.writeHead(202);
        res.end('{"status":"OK"}');
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

function runWorker(port, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [WORKER], { env: { ...process.env, AWS_LAMBDA_RUNTIME_API: `127.0.0.1:${port}`, ...env }, stdio: 'ignore' });
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

test('one worker handles one invocation: GET next, POST the response, exit 0', async () => {
  const { server, seen, port } = await fakeApi({ source: '', runs: [] });
  const exit = await runWorker(port);
  server.close();
  assert.strictEqual(exit.code, 0);
  assert.strictEqual(seen.nextCalls, 1);
  assert.strictEqual(seen.posts.length, 1);
  assert.strictEqual(seen.posts[0].url, '/2018-06-01/runtime/invocation/req-1/response');
  assert.match(JSON.parse(seen.posts[0].body).error, /source is required/); // index.js's own validation answered
});

test('the tenant header reaches the handler: REQUIRE_TENANT_ID=true refuses a call without one, accepts one with it', async () => {
  const none = await fakeApi({ source: '', runs: [] });
  await runWorker(none.port, { REQUIRE_TENANT_ID: 'true' });
  none.server.close();
  assert.match(JSON.parse(none.seen.posts[0].body).error, /tenant id required/);

  const some = await fakeApi({ source: '', runs: [] }, { 'Lambda-Runtime-Aws-Tenant-Id': 'abc123' });
  await runWorker(some.port, { REQUIRE_TENANT_ID: 'true' });
  some.server.close();
  assert.match(JSON.parse(some.seen.posts[0].body).error, /source is required/);
});

test('a handler failure is posted to the error endpoint, then the worker exits non-zero', async () => {
  const { server, seen, port } = await fakeApi('this is not json');
  const exit = await runWorker(port);
  server.close();
  assert.notStrictEqual(exit.code, 0);
  assert.strictEqual(seen.posts.length, 1);
  assert.strictEqual(seen.posts[0].url, '/2018-06-01/runtime/invocation/req-1/error');
  assert.strictEqual(seen.posts[0].errorType, 'Runtime.HandlerFailure');
  assert.ok(JSON.parse(seen.posts[0].body).errorMessage);
});

test('the worker never asks for a second event', async () => {
  const { server, seen, port } = await fakeApi({ source: '', runs: [] });
  await runWorker(port);
  await new Promise(r => setTimeout(r, 200));
  server.close();
  assert.strictEqual(seen.nextCalls, 1);
});
