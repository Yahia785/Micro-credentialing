// C++ grading through codeRunner must give the same stored results as the old direct Judge0 path.
// Only the Judge0 HTTP layer (submitBatch/pollResults) is mocked; the rest is real code.
jest.mock('../db/submissions');
jest.mock('../db/testcases');
jest.mock('../db/milestones');
jest.mock('../db/users');
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/secrets', () => ({ getSecret: jest.fn(async () => 'mock-key') }));

const mockResults = { current: null };
jest.mock('../utils/judge0', () => {
  const actual = jest.requireActual('../utils/judge0');
  return {
    ...actual,
    getJudge0Credentials: jest.fn(async () => ({ apiKey: 'mock-key', apiHost: 'mock-host' })),
    submitBatch: jest.fn(async subs => subs.map(s => ({ token: `tok${s.stdin.trim()}` }))),
    pollResults: jest.fn(async tokens => tokens.map(t => mockResults.current(t)))
  };
});

const judge0 = require('../utils/judge0');
const { createSubmission, updateSubmission } = require('../db/submissions');
const { getTestCasesByMilestone } = require('../db/testcases');
const { getMilestone } = require('../db/milestones');
const { getUser, addCompletedMilestone, updateUser } = require('../db/users');
const { processSubmission } = require('../services/submission-service');

const testCases = [
  { testCaseId: 'a', includeInJudge0: true, input: '5\n', expectedOutput: '25\n', isHidden: false },
  { testCaseId: 'b', includeInJudge0: true, input: '6\n', expectedOutput: '36\n', isHidden: true }
];
const rawResult = (token, id, description, extra = {}) => ({
  token, status: { id, description }, stdout: null, stderr: null, compile_output: null, time: '0.012', memory: 2048, ...extra
});
const base = { userId: 'u1', milestoneId: 'm1', code: 'int main(){}', language: 'cpp' };

beforeEach(() => {
  jest.resetAllMocks();
  judge0.getJudge0Credentials.mockResolvedValue({ apiKey: 'mock-key', apiHost: 'mock-host' });
  judge0.submitBatch.mockImplementation(async subs => subs.map(s => ({ token: `tok${s.stdin.trim()}` })));
  judge0.pollResults.mockImplementation(async tokens => tokens.map(t => mockResults.current(t)));
  getMilestone.mockResolvedValue({ milestoneId: 'm1', timeLimit: 3000, memoryLimit: 128000 });
  getUser.mockResolvedValue({ userId: 'u1', role: 'user', credentialsCount: 0 });
  getTestCasesByMilestone.mockResolvedValue(testCases);
  createSubmission.mockResolvedValue({});
  updateSubmission.mockImplementation(async (id, updates) => ({ submissionId: id, ...updates }));
  addCompletedMilestone.mockResolvedValue({});
  updateUser.mockResolvedValue({});
});

it('stores exactly the results the Judge0 path produced (pass, wrong answer)', async () => {
  const results = {
    tok5: rawResult('tok5', 3, 'Accepted', { stdout: '25\n' }),
    tok6: rawResult('tok6', 4, 'Wrong Answer', { stdout: '35\n', stderr: 'warn', time: '0.010', memory: 900 })
  };
  mockResults.current = t => results[t];

  const result = await processSubmission(base);

  const stored = updateSubmission.mock.calls[0][1];
  expect(stored.testResults).toEqual([
    { testCaseId: 'a', judge0TokenId: 'tok5', status: 'Accepted', passed: true, input: '5\n', expectedOutput: '25\n',
      actualOutput: '25\n', executionTime: 0.012, memory: 2048, isHidden: false, error: null },
    { testCaseId: 'b', judge0TokenId: 'tok6', status: 'Wrong Answer', passed: false, input: '6\n', expectedOutput: '36\n',
      actualOutput: '35\n', executionTime: 0.01, memory: 900, isHidden: true, error: 'warn' }
  ]);
  expect(stored).toMatchObject({ status: 'failed', passedTests: 1, totalTests: 2, score: 50, credentialAwarded: false });
  expect(result.testResults[1]).toMatchObject({ input: '[Hidden]', actualOutput: '[Hidden]' });
});

it('sends Judge0 the same per-test values as before (limits in seconds and KB, expected output)', async () => {
  mockResults.current = t => rawResult(t, 3, 'Accepted');
  await processSubmission(base);
  expect(judge0.submitBatch).toHaveBeenCalledTimes(1);
  expect(judge0.pollResults).toHaveBeenCalledTimes(1);
  const sent = judge0.submitBatch.mock.calls[0][0];
  expect(sent).toEqual([
    expect.objectContaining({ source_code: 'int main(){}', stdin: '5\n', expected_output: '25\n', cpu_time_limit: 3, memory_limit: 128000, language_id: 54 }),
    expect.objectContaining({ stdin: '6\n', expected_output: '36\n', cpu_time_limit: 3, memory_limit: 128000 })
  ]);
});

it('compile error: the error field carries the compile output', async () => {
  mockResults.current = t => rawResult(t, 6, 'Compilation Error', { compile_output: 'error: x' });
  await processSubmission(base);
  expect(updateSubmission.mock.calls[0][1].testResults[0]).toMatchObject({
    status: 'Compilation Error', passed: false, error: 'error: x'
  });
});

it('all pass: credential awarded as before', async () => {
  mockResults.current = t => rawResult(t, 3, 'Accepted', { stdout: 'x' });
  const result = await processSubmission(base);
  expect(result).toMatchObject({ status: 'passed', score: 100, credentialAwarded: true });
  expect(updateUser).toHaveBeenCalled();
});

it('Judge0 error: saved as grading_failed, reason error', async () => {
  judge0.submitBatch.mockRejectedValue(new Error('429 daily quota exceeded'));
  const result = await processSubmission(base);
  expect(result.status).toBe('grading_failed');
  expect(updateSubmission).toHaveBeenCalledWith(expect.stringMatching(/^sub_/), expect.objectContaining({
    gradingFailureReason: 'error', errorMessage: '429 daily quota exceeded'
  }));
});

it('polling stops near the Lambda deadline: grading_failed with reason timeout', async () => {
  judge0.pollResults.mockRejectedValue(new Error('Judge0 polling stopped: approaching Lambda timeout.'));
  await processSubmission({ ...base, deadlineMs: 10000 });
  expect(updateSubmission).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ gradingFailureReason: 'timeout' }));
  expect(judge0.pollResults.mock.calls[0][5]).toBe(10000);
});
