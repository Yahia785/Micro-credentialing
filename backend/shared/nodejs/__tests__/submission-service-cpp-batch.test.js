// C++ grading must hit Judge0 exactly like the old batch path (one POST, same polling) and store
// deep-equal results. Only global fetch and the secrets/db modules are mocked; judge0.js is real.
jest.mock('../db/submissions');
jest.mock('../db/testcases');
jest.mock('../db/milestones');
jest.mock('../db/users');
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/secrets', () => ({ getSecret: jest.fn(async () => 'mock-key') }));

const { getSecret } = require('../utils/secrets');
const { updateSubmission, createSubmission } = require('../db/submissions');
const { getTestCasesByMilestone } = require('../db/testcases');
const { getMilestone } = require('../db/milestones');
const { getUser, addCompletedMilestone, updateUser } = require('../db/users');
const { processSubmission } = require('../services/submission-service');

const b64 = s => (s == null ? null : Buffer.from(s, 'utf-8').toString('base64'));
const result = (id, description, extra = {}) => ({
  status: { id, description }, stdout: null, stderr: null, compile_output: null, time: '0.012', memory: 2048, ...extra
});

const SCENARIOS = {
  accepted: [result(3, 'Accepted', { stdout: '25\n' }), result(3, 'Accepted', { stdout: '36\n', time: '0.020' })],
  'wrong answer': [result(4, 'Wrong Answer', { stdout: '24\n' }), result(4, 'Wrong Answer', { stdout: '35\n' })],
  'compile error': [result(6, 'Compilation Error', { compile_output: 'error: x', time: null, memory: null }),
    result(6, 'Compilation Error', { compile_output: 'error: x', time: null, memory: null })],
  'runtime error': [result(11, 'Runtime Error (SIGSEGV)', { stderr: 'segfault', memory: 900 }),
    result(12, 'Runtime Error (SIGFPE)', { stderr: 'fpe' })],
  'time limit': [result(5, 'Time Limit Exceeded', { time: '3.000' }), result(5, 'Time Limit Exceeded', { time: '3.001' })],
  mix: [result(3, 'Accepted', { stdout: '25\n' }), result(5, 'Time Limit Exceeded', { time: '3.000' })]
};

const testCases = [
  { testCaseId: 'a', includeInJudge0: true, input: '5\n', expectedOutput: '25\n', isHidden: false },
  { testCaseId: 'b', includeInJudge0: true, input: '6\n', expectedOutput: '36\n', isHidden: true }
];
const base = { userId: 'u1', milestoneId: 'm1', code: 'int main(){}' };

/** Mock Judge0: POST returns tokens, GET returns the results (base64 text), optionally after `pending` not-done polls. */
function mockJudge0(results, { pending = 0 } = {}) {
  let polls = 0;
  global.fetch = jest.fn(async (url, init) => {
    if (init.method === 'POST') {
      const subs = JSON.parse(init.body).submissions;
      return { ok: true, json: async () => subs.map((s, i) => ({ token: `tok${i}` })) };
    }
    polls++;
    const done = polls > pending;
    const submissions = results.map((r, i) => (done
      ? { ...r, token: `tok${i}`, stdout: b64(r.stdout), stderr: b64(r.stderr), compile_output: b64(r.compile_output) }
      : { token: `tok${i}`, status: { id: 2, description: 'Processing' } }));
    return { ok: true, json: async () => ({ submissions }) };
  });
}

const stored = () => {
  const call = updateSubmission.mock.calls.find(c => c[1].testResults && c[1].status !== 'grading_failed');
  const { testResults, score, status, passedTests, totalTests, credentialAwarded } = call[1];
  return { testResults, score, status, passedTests, totalTests, credentialAwarded };
};
const requests = () => global.fetch.mock.calls.map(c => c[1].method);

let realFetch;
beforeAll(() => { realFetch = global.fetch; });
afterAll(() => { global.fetch = realFetch; });

beforeEach(() => {
  jest.resetAllMocks();
  getSecret.mockResolvedValue('mock-key');
  getMilestone.mockResolvedValue({ milestoneId: 'm1', timeLimit: 3000, memoryLimit: 128000 });
  getUser.mockResolvedValue({ userId: 'u1', role: 'user', credentialsCount: 0 });
  getTestCasesByMilestone.mockResolvedValue(testCases);
  createSubmission.mockResolvedValue({});
  updateSubmission.mockImplementation(async (id, updates) => ({ submissionId: id, ...updates }));
  addCompletedMilestone.mockResolvedValue({});
  updateUser.mockResolvedValue({});
});

describe('Judge0 request count', () => {
  it('N test cases: exactly 1 batch POST and 1 poll when done at once, same as the old path', async () => {
    mockJudge0(SCENARIOS.accepted);
    await processSubmission({ ...base, language: 'cpp' });
    const cppRequests = requests();

    global.fetch = undefined;
    jest.clearAllMocks();
    mockJudge0(SCENARIOS.accepted);
    await processSubmission({ ...base, language: 'python' }); // old path
    expect(cppRequests).toEqual(['POST', 'GET']);
    expect(cppRequests).toEqual(requests());
  });

  it('same number of polls as the old path when results are not ready at first', async () => {
    jest.spyOn(global, 'setTimeout').mockImplementation(fn => { fn(); return 0; });

    mockJudge0(SCENARIOS.mix, { pending: 2 });
    await processSubmission({ ...base, language: 'cpp' });
    const cppRequests = requests();

    jest.clearAllMocks();
    mockJudge0(SCENARIOS.mix, { pending: 2 });
    await processSubmission({ ...base, language: 'python' });

    expect(cppRequests).toEqual(['POST', 'GET', 'GET', 'GET']);
    expect(requests()).toEqual(cppRequests);
    global.setTimeout.mockRestore();
  });

  it('the single POST carries every test case', async () => {
    mockJudge0(SCENARIOS.accepted);
    await processSubmission({ ...base, language: 'cpp' });
    const post = global.fetch.mock.calls.find(c => c[1].method === 'POST');
    expect(JSON.parse(post[1].body).submissions).toHaveLength(testCases.length);
  });
});

describe('equivalence with the old parseJudge0Result path', () => {
  it.each(Object.keys(SCENARIOS))('%s: stored results are deep-equal', async name => {
    mockJudge0(SCENARIOS[name]);
    await processSubmission({ ...base, language: 'python' });
    const old = stored();

    jest.clearAllMocks();
    updateSubmission.mockImplementation(async (id, updates) => ({ submissionId: id, ...updates }));
    mockJudge0(SCENARIOS[name]);
    await processSubmission({ ...base, language: 'cpp' });

    expect(stored()).toEqual(old);
    stored().testResults.forEach((r, i) => expect(r.judge0TokenId).toBe(`tok${i}`));
  });
});

describe('deadlineMs', () => {
  it('reaches the polling loop: it stops before polling when too little time is left', async () => {
    mockJudge0(SCENARIOS.accepted);
    const result = await processSubmission({ ...base, language: 'cpp', deadlineMs: 100 });
    // 1000ms poll interval + 5000ms cleanup margin exceeds the 100ms budget, so no poll is made
    expect(requests()).toEqual(['POST']);
    expect(result.status).toBe('grading_failed');
    expect(updateSubmission).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ gradingFailureReason: 'timeout' }));
  });
});
