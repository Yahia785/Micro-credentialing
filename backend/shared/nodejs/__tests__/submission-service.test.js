jest.mock('../db/submissions');
jest.mock('../db/testcases');
jest.mock('../db/milestones');
jest.mock('../db/users');
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/judge0', () => ({
  getLanguageId: jest.fn(() => 71),
  getJudge0Credentials: jest.fn(async () => ({ apiKey: 'real-key', apiHost: 'host' })),
  submitBatch: jest.fn(async () => [{ token: 't1' }]),
  pollResults: jest.fn(async () => [{}]),
  parseJudge0Result: jest.fn(() => ({ passed: true, isHidden: false })),
  calculateMetrics: jest.fn(() => ({
    status: 'passed', passedTests: 1, totalTests: 1, score: 100,
    totalExecutionTime: 0, averageExecutionTime: 0, maxExecutionTime: 0,
    totalMemory: 0, averageMemory: 0, maxMemory: 0
  }))
}));

const { createSubmission, updateSubmission } = require('../db/submissions');
const judge0 = require('../utils/judge0');
const { getTestCasesByMilestone } = require('../db/testcases');
const { getMilestone } = require('../db/milestones');
const { getUser, updateUser, addCompletedMilestone } = require('../db/users');
const { processSubmission } = require('../services/submission-service');

beforeEach(() => {
  jest.clearAllMocks();
  getMilestone.mockResolvedValue({ milestoneId: 'm1' });
  getUser.mockResolvedValue({ userId: 'u1', email: 'a@b.c', name: 'A', role: 'user', credentialsCount: 0 });
  getTestCasesByMilestone.mockResolvedValue([{ includeInJudge0: true, input: '', expectedOutput: '' }]);
  createSubmission.mockResolvedValue({});
  updateSubmission.mockImplementation(async (id, updates) => ({ submissionId: id, ...updates }));
  addCompletedMilestone.mockResolvedValue({});
  updateUser.mockResolvedValue({});
});

const base = { userId: 'u1', milestoneId: 'm1', code: 'print(1)', language: 'python' };

describe('processSubmission endedBy', () => {
  it('a request with no endedBy (older frontend) is exactly submit_button', async () => {
    await processSubmission(base);
    expect(createSubmission.mock.calls[0][0].endedBy).toBe('submit_button');
  });

  it('normal submit: records submit_button and awards credential counters when passed', async () => {
    const result = await processSubmission(base);

    expect(createSubmission.mock.calls[0][0].endedBy).toBe('submit_button');
    expect(createSubmission.mock.calls[0][0].proctoringData).toBeUndefined();
    expect(updateSubmission.mock.calls[0][1].credentialAwarded).toBe(true);
    expect(updateUser).toHaveBeenCalledWith('u1', expect.objectContaining({ credentialsCount: 1 }));
    expect(result.credentialAwarded).toBe(true);
  });

  it('left_page: forces pending review, never awards credential or counters, even at 100%', async () => {
    const result = await processSubmission({ ...base, endedBy: 'left_page' });

    const created = createSubmission.mock.calls[0][0];
    expect(created.endedBy).toBe('left_page');
    expect(created.proctoringData).toEqual({ reviewStatus: 'pending' });
    expect(updateSubmission.mock.calls[0][1].credentialAwarded).toBe(false);
    expect(updateUser).not.toHaveBeenCalled();
    expect(result.credentialAwarded).toBe(false);
    // Still recorded as completed so the student cannot retake
    expect(addCompletedMilestone).toHaveBeenCalledTimes(1);
    expect(addCompletedMilestone.mock.calls[0][1]).not.toHaveProperty('endedBy');
  });

  it('rejects a second submission for a milestone already in completedMilestones', async () => {
    getUser.mockResolvedValue({ userId: 'u1', completedMilestones: [{ milestoneId: 'm1' }] });

    await expect(processSubmission(base)).rejects.toMatchObject({
      statusCode: 400,
      message: 'You have already submitted this problem. Only one submission is allowed.'
    });
    expect(createSubmission).not.toHaveBeenCalled();
    expect(judge0.submitBatch).not.toHaveBeenCalled();
    expect(addCompletedMilestone).not.toHaveBeenCalled();
  });

  it('still accepts a first submission when other milestones are completed', async () => {
    getUser.mockResolvedValue({ userId: 'u1', completedMilestones: [{ milestoneId: 'other' }] });
    const result = await processSubmission(base);
    expect(result.status).toBe('passed');
  });

  it('rejects an unknown endedBy value before touching the database', async () => {
    await expect(processSubmission({ ...base, endedBy: 'cheated' })).rejects.toThrow(/endedBy/);
    expect(createSubmission).not.toHaveBeenCalled();
  });
});

describe('processSubmission when grading fails', () => {
  const expectSavedForReview = (result, reason) => {
    // Saved, not lost: a submissionId comes back with status grading_failed and no credential
    expect(result).toMatchObject({
      status: 'grading_failed',
      gradingFailed: true,
      credentialAwarded: false,
      score: 0,
      passedTests: 0,
      totalTests: 1,
      testResults: []
    });
    expect(result.submissionId).toMatch(/^sub_/);
    expect(updateSubmission).toHaveBeenCalledWith(
      result.submissionId,
      expect.objectContaining({
        status: 'grading_failed',
        gradingFailureReason: reason,
        proctoringData: { reviewStatus: 'pending' },
        credentialAwarded: false
      })
    );
    // One attempt only, and no counters
    expect(addCompletedMilestone).toHaveBeenCalledWith('u1', expect.objectContaining({
      milestoneId: 'm1', score: 0, submissionId: result.submissionId, gradingFailed: true
    }));
    expect(updateUser).not.toHaveBeenCalled();
  };

  it('Judge0 error or quota: saves the submission for review instead of throwing', async () => {
    judge0.submitBatch.mockRejectedValueOnce(new Error('429 daily quota exceeded'));
    const result = await processSubmission(base);
    expectSavedForReview(result, 'error');
    expect(createSubmission.mock.calls[0][0].code).toBe('print(1)');
    expect(createSubmission.mock.calls[0][0].endedBy).toBe('submit_button');
  });

  it('Judge0 polling timeout: saved with reason timeout', async () => {
    judge0.pollResults.mockRejectedValueOnce(new Error('Lambda timeout approaching'));
    expectSavedForReview(await processSubmission(base), 'timeout');
  });

  it('a scoring/parse error after Judge0 returns is also saved for review', async () => {
    judge0.calculateMetrics.mockImplementationOnce(() => { throw new Error('bad result'); });
    expectSavedForReview(await processSubmission(base), 'error');
  });

  it('credentials failure (before any record exists): the record is created as grading_failed', async () => {
    judge0.getJudge0Credentials.mockRejectedValueOnce(new Error('secrets unavailable'));
    const result = await processSubmission({ ...base, endedBy: 'left_page' });

    expect(createSubmission).toHaveBeenCalledTimes(1);
    expect(createSubmission.mock.calls[0][0]).toMatchObject({
      status: 'grading_failed',
      code: 'print(1)',
      endedBy: 'left_page',
      proctoringData: { reviewStatus: 'pending' }
    });
    expect(result.status).toBe('grading_failed');
    expect(result.gradingFailed).toBe(true);
    expect(addCompletedMilestone).toHaveBeenCalledTimes(1);
  });
});
