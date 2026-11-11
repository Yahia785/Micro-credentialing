// The Run button endpoint: custom input and visible sample tests, limits, hidden tests, after-submit refusal, invisible problem.
// Fakes: the code runner and the db modules; the run counters are an in-memory store that behaves like the real transaction.
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../db/milestones');
jest.mock('../db/users');
jest.mock('../db/testcases');
jest.mock('../utils/codeRunner', () => ({ runCpp: jest.fn(), runCppBatch: jest.fn(), getCodeRunnerName: jest.fn(() => 'own') }));
const mockStore = new Map();
jest.mock('../db/run-usage', () => ({
  incrementCounters: jest.fn(async counters => {
    const full = counters.find(c => (mockStore.get(c.key) || 0) >= c.limit);
    if (full) return { ok: false, failedKey: full.key };
    counters.forEach(c => mockStore.set(c.key, (mockStore.get(c.key) || 0) + 1));
    return { ok: true };
  }),
  readCount: jest.fn(async key => mockStore.get(key) || 0)
}));

const { getMilestone } = require('../db/milestones');
const { getUser } = require('../db/users');
const { getTestCasesByMilestone } = require('../db/testcases');
const { runCpp, runCppBatch } = require('../utils/codeRunner');
const { handler } = require('../../../functions/submissions/run/index.js');

const ok = (over = {}) => ({ status: 'accepted', statusText: 'Accepted', stdout: '25\n', stderr: '', compileOutput: '', timeMs: 7, memoryKb: 900, runId: 'r', ...over });
const tests = [
  { testCaseId: 't1', input: '5\n', expectedOutput: '25\n', isHidden: false, order: 1 },
  { testCaseId: 't2', input: '6\n', expectedOutput: '36\n', isHidden: false, order: 2 },
  { testCaseId: 'h1', input: 'SECRET-IN\n', expectedOutput: 'SECRET-OUT\n', isHidden: true, order: 3 }
];

function call(body, userId = 'u1') {
  return handler({ httpMethod: 'POST', body: JSON.stringify(body), requestContext: { authorizer: { claims: { sub: userId } } } }, { getRemainingTimeInMillis: () => 30000 })
    .then(res => ({ status: res.statusCode, body: JSON.parse(res.body) }));
}

beforeEach(() => {
  [getMilestone, getUser, getTestCasesByMilestone, runCpp, runCppBatch].forEach(m => m.mockReset());
  mockStore.clear();
  delete process.env.RUN_LIMIT_PER_MINUTE;
  delete process.env.RUN_LIMIT_PER_ASSESSMENT;
  getMilestone.mockResolvedValue({ milestoneId: 'm1', language: 'cpp', timeLimit: 2000, memoryLimit: 128000 });
  getUser.mockResolvedValue({ userId: 'u1', role: 'user', completedMilestones: [] });
  getTestCasesByMilestone.mockResolvedValue(tests);
  runCpp.mockResolvedValue(ok());
  runCppBatch.mockImplementation(async runs => runs.map(r => ok({ stdout: r.stdin === '5\n' ? '25\n' : '35\n' })));
});

describe('custom input', () => {
  it('runs the code on the input and returns trimmed output, status and time', async () => {
    const res = await call({ milestoneId: 'm1', code: 'int main(){}', input: '5\n' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'custom', status: 'accepted', stdout: '25\n', timeMs: 7, runsLeft: 149 });
    expect(runCpp).toHaveBeenCalledWith(expect.objectContaining({ source: 'int main(){}', stdin: '5\n', timeLimitMs: 2000, userId: 'u1' }));
    expect(getTestCasesByMilestone).not.toHaveBeenCalled();
  });

  it('shows compile output, and cuts very long output', async () => {
    runCpp.mockResolvedValueOnce(ok({ status: 'compile_error', stdout: '', compileOutput: 'main.cpp:1: error' }));
    expect((await call({ milestoneId: 'm1', code: 'x' })).body).toMatchObject({ status: 'compile_error', compileOutput: 'main.cpp:1: error' });
    runCpp.mockResolvedValueOnce(ok({ stdout: 'a'.repeat(50000) }));
    const long = (await call({ milestoneId: 'm1', code: 'x' })).body.stdout;
    expect(long.length).toBeLessThan(10100);
    expect(long).toContain('output cut');
  });

  it('rejects missing or oversized code and input with 400, without counting a run', async () => {
    expect((await call({ milestoneId: 'm1' })).status).toBe(400);
    expect((await call({ milestoneId: 'm1', code: 'x', input: 'i'.repeat(10001) })).status).toBe(400);
    expect((await call({ milestoneId: 'm1', code: 'x', input: 5 })).status).toBe(400);
    expect(mockStore.size).toBe(0);
  });

  it('a runner failure is a 502 with a generic message (no internals)', async () => {
    runCpp.mockResolvedValueOnce(ok({ status: 'internal_error', message: 'arn:aws:lambda:secret-detail' }));
    const res = await call({ milestoneId: 'm1', code: 'x' });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('secret-detail');
  });
});

describe('sample tests', () => {
  it('runs only the visible tests and returns pass/fail with input, expected and actual output', async () => {
    const res = await call({ milestoneId: 'm1', code: 'x', sample: true, input: 'ignored' });
    expect(res.status).toBe(200);
    expect(runCppBatch.mock.calls[0][0].map(r => r.stdin)).toEqual(['5\n', '6\n']);
    expect(res.body).toMatchObject({ mode: 'sample', status: 'accepted', passed: 2, total: 2, runsLeft: 149 });
    expect(res.body.results[0]).toMatchObject({ index: 1, passed: true, input: '5\n', expectedOutput: '25\n', actualOutput: '25\n' });
  });

  it('with a wrong answer the status of that test is not accepted', async () => {
    runCppBatch.mockResolvedValueOnce([ok(), ok({ status: 'wrong_answer', stdout: '35\n' })]);
    const res = await call({ milestoneId: 'm1', code: 'x', sample: true });
    expect(res.body.results[1]).toMatchObject({ passed: false, status: 'wrong_answer', expectedOutput: '36\n', actualOutput: '35\n' });
  });

  it('never runs a hidden test and never returns its input or expected output', async () => {
    const res = await call({ milestoneId: 'm1', code: 'x', sample: true });
    expect(JSON.stringify(runCppBatch.mock.calls)).not.toContain('SECRET');
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
    expect(res.body.total).toBe(2);
  });

  it('a problem with only hidden tests has nothing to run (400, no run counted)', async () => {
    getTestCasesByMilestone.mockResolvedValue([tests[2]]);
    expect((await call({ milestoneId: 'm1', code: 'x', sample: true })).status).toBe(400);
    expect(runCppBatch).not.toHaveBeenCalled();
    expect(mockStore.size).toBe(0);
  });

  it('a compile error is reported once with the compiler output', async () => {
    runCppBatch.mockResolvedValueOnce([ok({ status: 'compile_error', compileOutput: 'bad' }), ok({ status: 'compile_error', compileOutput: 'bad' })]);
    const res = await call({ milestoneId: 'm1', code: 'x', sample: true });
    expect(res.body).toMatchObject({ status: 'compile_error', compileOutput: 'bad', results: [] });
  });
});

describe('limits', () => {
  it('refuses the 11th run in a minute with 429 and a clear message', async () => {
    for (let i = 0; i < 10; i++) expect((await call({ milestoneId: 'm1', code: 'x' })).status).toBe(200);
    const res = await call({ milestoneId: 'm1', code: 'x' });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/wait a minute/i);
    expect(runCpp).toHaveBeenCalledTimes(10);
  });

  it('refuses over the per-assessment limit with 429 and reports runs left near it', async () => {
    process.env.RUN_LIMIT_PER_ASSESSMENT = '3';
    const left = [];
    for (let i = 0; i < 3; i++) left.push((await call({ milestoneId: 'm1', code: 'x' })).body.runsLeft);
    expect(left).toEqual([2, 1, 0]);
    const res = await call({ milestoneId: 'm1', code: 'x' });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/run limit for this assessment/i);
  });

  it('a sample run counts as one run; limits are per student', async () => {
    process.env.RUN_LIMIT_PER_ASSESSMENT = '1';
    expect((await call({ milestoneId: 'm1', code: 'x', sample: true })).status).toBe(200);
    expect((await call({ milestoneId: 'm1', code: 'x', sample: true })).status).toBe(429);
    getUser.mockResolvedValue({ userId: 'u2', role: 'user', completedMilestones: [] });
    expect((await call({ milestoneId: 'm1', code: 'x' }, 'u2')).status).toBe(200);
  });
});

describe('who may run what', () => {
  it('refuses after the submission (403) without running or counting', async () => {
    getUser.mockResolvedValue({ userId: 'u1', role: 'user', completedMilestones: [{ milestoneId: 'm1' }] });
    const res = await call({ milestoneId: 'm1', code: 'x' });
    expect(res.status).toBe(403);
    expect(runCpp).not.toHaveBeenCalled();
    expect(mockStore.size).toBe(0);
  });

  it('a hidden problem the caller cannot see is a 404, like an unknown one', async () => {
    getMilestone.mockResolvedValue({ milestoneId: 'm1', language: 'cpp', isHidden: true, previewUserIds: ['someone-else'] });
    expect((await call({ milestoneId: 'm1', code: 'x' })).status).toBe(404);
    getMilestone.mockResolvedValue(null);
    expect((await call({ milestoneId: 'nope', code: 'x' })).status).toBe(404);
    expect(runCpp).not.toHaveBeenCalled();
  });

  it('a hidden problem on the caller preview list can be run', async () => {
    getMilestone.mockResolvedValue({ milestoneId: 'm1', language: 'cpp', isHidden: true, previewUserIds: ['u1'] });
    expect((await call({ milestoneId: 'm1', code: 'x' })).status).toBe(200);
  });

  it('only C++ problems', async () => {
    getMilestone.mockResolvedValue({ milestoneId: 'm1', language: 'python' });
    const res = await call({ milestoneId: 'm1', code: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/C\+\+/);
  });

  it('needs a signed-in user', async () => {
    const res = await handler({ httpMethod: 'POST', body: '{}', requestContext: {} }, {});
    expect(res.statusCode).toBe(401);
  });
});
