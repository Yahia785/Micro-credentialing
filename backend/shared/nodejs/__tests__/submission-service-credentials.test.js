// The Judge0 credential check happens only when Judge0 will run the code: any non-C++ language, or C++ with
// CODE_RUNNER=judge0 (the default). With CODE_RUNNER=own, C++ goes to our own runner and the Judge0 key is never read.
// The real codeRunner is used (CODE_RUNNER decides); only the Judge0 HTTP calls, the providers and the db are mocked.
jest.mock('../db/submissions');
jest.mock('../db/testcases');
jest.mock('../db/milestones');
jest.mock('../db/users');
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/judge0', () => ({
  getLanguageId: jest.fn(() => 54),
  getJudge0Credentials: jest.fn(),
  submitBatch: jest.fn(),
  pollResults: jest.fn(),
  parseJudge0Result: jest.fn(),
  calculateMetrics: jest.fn()
}));
jest.mock('../utils/codeRunnerOwn', () => ({ runBatch: jest.fn() }));
jest.mock('../utils/codeRunnerJudge0', () => ({ runBatch: jest.fn() }));

const judge0 = require('../utils/judge0');
const own = require('../utils/codeRunnerOwn');
const judge0Provider = require('../utils/codeRunnerJudge0');
const { createSubmission, updateSubmission } = require('../db/submissions');
const { getTestCasesByMilestone } = require('../db/testcases');
const { getMilestone } = require('../db/milestones');
const { getUser, addCompletedMilestone, updateUser } = require('../db/users');
const { processSubmission } = require('../services/submission-service');

const accepted = { status: 'accepted', statusText: 'Accepted', stdout: '25\n', stderr: '', compileOutput: '', timeMs: 5, memoryKb: 900, runId: 'r', message: null };
const call = language => processSubmission({ userId: 'student-7', milestoneId: 'm1', code: 'int main(){}', language });
const savedGradingFailures = () => updateSubmission.mock.calls.filter(c => c[1].status === 'grading_failed').length
  + createSubmission.mock.calls.filter(c => c[0].status === 'grading_failed').length;

beforeEach(() => {
  jest.resetAllMocks();
  delete process.env.CODE_RUNNER;
  judge0.getLanguageId.mockReturnValue(54);
  judge0.getJudge0Credentials.mockResolvedValue({ apiKey: 'real-key', apiHost: 'host' });
  judge0.submitBatch.mockResolvedValue([{ token: 't' }]);
  judge0.pollResults.mockResolvedValue([{}]);
  judge0.parseJudge0Result.mockReturnValue({ testCaseId: 'a', passed: true, executionTime: 0.01, memory: 900 });
  judge0.calculateMetrics.mockReturnValue({ status: 'passed', passedTests: 1, totalTests: 1, score: 100, totalExecutionTime: 0.01, averageExecutionTime: 0.01, maxExecutionTime: 0.01, totalMemory: 900, averageMemory: 900, maxMemory: 900 });
  own.runBatch.mockResolvedValue([accepted]);
  getMilestone.mockResolvedValue({ milestoneId: 'm1', timeLimit: 3000, memoryLimit: 128000 });
  getUser.mockResolvedValue({ userId: 'student-7', role: 'user', credentialsCount: 0 });
  getTestCasesByMilestone.mockResolvedValue([{ testCaseId: 'a', includeInJudge0: true, input: '5\n', expectedOutput: '25\n', isHidden: false }]);
  createSubmission.mockResolvedValue({});
  updateSubmission.mockImplementation(async (id, updates) => ({ submissionId: id, ...updates }));
  addCompletedMilestone.mockResolvedValue({});
  updateUser.mockResolvedValue({});
});

afterAll(() => { delete process.env.CODE_RUNNER; });

describe('Judge0 credentials are checked only for Judge0', () => {
  it('CODE_RUNNER=own, C++: the Judge0 secret is never read and the own runner grades', async () => {
    process.env.CODE_RUNNER = 'own';
    judge0.getJudge0Credentials.mockRejectedValue(new Error('Judge0 secret must not be read'));
    const result = await call('cpp');
    expect(judge0.getJudge0Credentials).not.toHaveBeenCalled();
    expect(own.runBatch).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('passed');
    expect(savedGradingFailures()).toBe(0);
  });

  it('CODE_RUNNER=own, C++: a dummy or missing Judge0 key does not block grading', async () => {
    process.env.CODE_RUNNER = 'own';
    judge0.getJudge0Credentials.mockResolvedValue({ apiKey: 'dummy-key-for-testing', apiHost: 'host' });
    const result = await call('cpp');
    expect(result.status).toBe('passed');
    expect(result.message).toBeUndefined();
  });

  it('CODE_RUNNER=judge0, C++: the credentials are read, and a failure to read them is saved as grading_failed', async () => {
    process.env.CODE_RUNNER = 'judge0';
    judge0.getJudge0Credentials.mockRejectedValue(new Error('secret missing'));
    const result = await call('cpp');
    expect(judge0.getJudge0Credentials).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('grading_failed');
    expect(own.runBatch).not.toHaveBeenCalled();
  });

  it('default (CODE_RUNNER not set) behaves as judge0: credentials are read, a dummy key returns the mock response', async () => {
    judge0.getJudge0Credentials.mockResolvedValue({ apiKey: 'dummy-key-for-testing', apiHost: 'host' });
    const result = await call('cpp');
    expect(judge0.getJudge0Credentials).toHaveBeenCalledTimes(1);
    expect(result.message).toMatch(/Judge0 not configured/);
    expect(own.runBatch).not.toHaveBeenCalled();
    expect(judge0Provider.runBatch).not.toHaveBeenCalled();
  });

  it('CODE_RUNNER=own does not change other languages: they still use Judge0 and need its credentials', async () => {
    process.env.CODE_RUNNER = 'own';
    judge0.getLanguageId.mockReturnValue(71);
    const result = await call('python');
    expect(judge0.getJudge0Credentials).toHaveBeenCalledTimes(1);
    expect(judge0.submitBatch).toHaveBeenCalledTimes(1);
    expect(own.runBatch).not.toHaveBeenCalled();
    expect(result.status).toBe('passed');

    judge0.getJudge0Credentials.mockRejectedValue(new Error('secret missing'));
    const failed = await call('python');
    expect(failed.status).toBe('grading_failed');
  });
});
