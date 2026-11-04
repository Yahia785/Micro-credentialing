// C++ grading hands the student's user id to the code runner, which (for the own runner) turns it into a tenant id so that
// different students never share an execution environment. Only the code runner and the db modules are mocked.
jest.mock('../db/submissions');
jest.mock('../db/testcases');
jest.mock('../db/milestones');
jest.mock('../db/users');
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/secrets', () => ({ getSecret: jest.fn(async () => 'mock-key') }));
jest.mock('../utils/codeRunner', () => ({ runCppBatch: jest.fn() }));

const { getSecret } = require('../utils/secrets');
const { runCppBatch } = require('../utils/codeRunner');
const { updateSubmission, createSubmission } = require('../db/submissions');
const { getTestCasesByMilestone } = require('../db/testcases');
const { getMilestone } = require('../db/milestones');
const { getUser, addCompletedMilestone, updateUser } = require('../db/users');
const { processSubmission } = require('../services/submission-service');

const accepted = { status: 'accepted', statusText: 'Accepted', stdout: '25\n', stderr: '', compileOutput: '', timeMs: 5, memoryKb: 900, runId: 'r', message: null };

beforeEach(() => {
  jest.resetAllMocks();
  getSecret.mockResolvedValue('mock-key');
  getMilestone.mockResolvedValue({ milestoneId: 'm1', timeLimit: 3000, memoryLimit: 128000 });
  getUser.mockResolvedValue({ userId: 'student-7', role: 'user', credentialsCount: 0 });
  getTestCasesByMilestone.mockResolvedValue([{ testCaseId: 'a', includeInJudge0: true, input: '5\n', expectedOutput: '25\n', isHidden: false }]);
  createSubmission.mockResolvedValue({});
  updateSubmission.mockImplementation(async (id, updates) => ({ submissionId: id, ...updates }));
  addCompletedMilestone.mockResolvedValue({});
  updateUser.mockResolvedValue({});
  runCppBatch.mockResolvedValue([accepted]);
});

describe('C++ grading and the tenant', () => {
  it('passes the submitting user id (and the deadline) to the code runner', async () => {
    await processSubmission({ userId: 'student-7', milestoneId: 'm1', code: 'int main(){}', language: 'cpp', deadlineMs: 20000 });
    expect(runCppBatch).toHaveBeenCalledTimes(1);
    expect(runCppBatch.mock.calls[0][1]).toEqual({ deadlineMs: 20000, userId: 'student-7' });
  });

  it('a different student is a different user id', async () => {
    await processSubmission({ userId: 'student-7', milestoneId: 'm1', code: 'x', language: 'cpp' });
    await processSubmission({ userId: 'student-8', milestoneId: 'm1', code: 'x', language: 'cpp' });
    expect(runCppBatch.mock.calls.map(call => call[1].userId)).toEqual(['student-7', 'student-8']);
  });
});
