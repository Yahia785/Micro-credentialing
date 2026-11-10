// A C++ problem with the interview enabled is held for the instructor: until the submission is approved or rejected, a student's
// view of it has no score, no pass/fail, no tests, no output and no code, and a perfect score approves nothing.
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
    submitBatch: jest.fn(async (subs) => subs.map((s) => ({ token: `tok${s.stdin.trim()}` }))),
    pollResults: jest.fn(async (tokens) => tokens.map((t) => mockResults.current(t))),
  };
});

const judge0 = require('../utils/judge0');
const { createSubmission, updateSubmission, getSubmission } = require('../db/submissions');
const { getTestCasesByMilestone } = require('../db/testcases');
const { getMilestone } = require('../db/milestones');
const { getUser, addCompletedMilestone, updateUser } = require('../db/users');
const { processSubmission } = require('../services/submission-service');
const view = require('../utils/assessment-view');
const { handler: submissionGet } = require('../../../functions/submissions/get/index.js');
const { handler: userGet } = require('../../../functions/users/get/index.js');

const SECRET_CODE = 'int secretStudentCode = 7;';
const heldMilestone = { milestoneId: 'm1', language: 'cpp', interview: { enabled: true, themes: [] }, timeLimit: 3000, memoryLimit: 128000 };
const plainMilestone = { milestoneId: 'm2', language: 'cpp', timeLimit: 3000, memoryLimit: 128000 };

const testCases = [
  { testCaseId: 'a', includeInJudge0: true, input: '5\n', expectedOutput: '25\n', isHidden: false },
  { testCaseId: 'b', includeInJudge0: true, input: '6\n', expectedOutput: '36\n', isHidden: true },
];
const accepted = (token) => ({ token, status: { id: 3, description: 'Accepted' }, stdout: 'x', stderr: null, compile_output: null, time: '0.01', memory: 1000 });

// What a student must never receive about a submission that is under review.
const RESULT_WORDS = ['score', 'passedTests', 'totalTests', 'testResults', 'credentialAwarded', 'actualOutput', 'compile', 'stdout', 'code', 'secretStudentCode', 'passed', 'failed', 'gradingFailed', 'totalExecutionTime'];

const base = { userId: 'u1', milestoneId: 'm1', code: SECRET_CODE, language: 'cpp' };

beforeEach(() => {
  jest.resetAllMocks();
  mockResults.current = (t) => accepted(t);
  judge0.getJudge0Credentials.mockResolvedValue({ apiKey: 'mock-key', apiHost: 'mock-host' });
  judge0.submitBatch.mockImplementation(async (subs) => subs.map((s) => ({ token: `tok${s.stdin.trim()}` })));
  judge0.pollResults.mockImplementation(async (tokens) => tokens.map((t) => mockResults.current(t)));
  getMilestone.mockImplementation(async (id) => (id === 'm1' ? heldMilestone : plainMilestone));
  getUser.mockResolvedValue({ userId: 'u1', role: 'user', credentialsCount: 0, milestonesCompleted: 0 });
  getTestCasesByMilestone.mockResolvedValue(testCases);
  createSubmission.mockResolvedValue({});
  updateSubmission.mockImplementation(async (id, updates) => ({ submissionId: id, milestoneId: 'm1', submittedAt: '2026-01-01T10:00:00Z', code: SECRET_CODE, ...updates }));
  addCompletedMilestone.mockResolvedValue({});
  updateUser.mockResolvedValue({});
});

describe('submitting to a held problem', () => {
  it('returns only that it is under review, with no result of any kind', async () => {
    const result = await processSubmission(base);
    expect(result).toEqual({
      submissionId: expect.stringMatching(/^sub_/), milestoneId: 'm1', status: 'under_review', underReview: true,
      submittedAt: '2026-01-01T10:00:00Z', proctoringData: { reviewStatus: 'pending' },
    });
    const json = JSON.stringify(result);
    for (const word of RESULT_WORDS) expect(json).not.toContain(word);
  });

  it('does not auto-approve a perfect score: no credential is awarded and no count goes up', async () => {
    await processSubmission(base);
    expect(updateSubmission.mock.calls[0][1]).toMatchObject({ status: 'passed', score: 100, credentialAwarded: false });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('puts the submission in the review queue from the start and flags it, even if no recording is ever uploaded', async () => {
    await processSubmission(base);
    expect(createSubmission.mock.calls[0][0]).toMatchObject({ heldForReview: true, proctoringData: { reviewStatus: 'pending' } });
    expect(addCompletedMilestone.mock.calls[0][1]).toMatchObject({ heldForReview: true });
  });

  it('keeps a submission that was never graded just as hidden', async () => {
    judge0.submitBatch.mockRejectedValue(new Error('429 daily quota exceeded'));
    const result = await processSubmission(base);
    expect(result).toMatchObject({ status: 'under_review', underReview: true, gradingFailed: true });
    expect(JSON.stringify(result)).not.toContain('errorMessage');
    expect(addCompletedMilestone.mock.calls[0][1]).toMatchObject({ heldForReview: true, gradingFailed: true });
  });

  it('an admin who takes the problem still sees everything, but nothing is auto-approved for them either', async () => {
    getUser.mockResolvedValue({ userId: 'u1', role: 'admin' });
    const result = await processSubmission(base);
    expect(result).toMatchObject({ status: 'passed', score: 100, credentialAwarded: false });
    expect(result.testResults).toHaveLength(2);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('leaves other problems exactly as they were: the result is shown and a perfect score awards the credential', async () => {
    const result = await processSubmission({ ...base, milestoneId: 'm2' });
    expect(result).toMatchObject({ status: 'passed', score: 100, credentialAwarded: true });
    expect(updateUser).toHaveBeenCalled();
    expect(createSubmission.mock.calls[0][0]).not.toHaveProperty('heldForReview');
  });
});

describe('GET /submissions/{id}', () => {
  const stored = (over = {}) => ({
    submissionId: 'sub1', userId: 'u1', milestoneId: 'm1', code: SECRET_CODE, language: 'cpp', status: 'passed', score: 100,
    passedTests: 2, totalTests: 2, submittedAt: '2026-01-01T10:00:00Z', endedBy: 'submit_button',
    testResults: [{ passed: true, input: '1', expectedOutput: '2', actualOutput: '2', isHidden: false }],
    heldForReview: true, proctoringData: { reviewStatus: 'pending' }, ...over,
  });
  const ask = (userId) => submissionGet({
    httpMethod: 'GET', pathParameters: { submissionId: 'sub1' }, requestContext: { authorizer: { claims: { sub: userId } } },
  }, {});

  beforeEach(() => {
    getUser.mockImplementation(async (id) => ({ userId: id, role: id.startsWith('admin') ? 'admin' : 'user' }));
    getSubmission.mockResolvedValue(stored());
  });

  it('gives the student only the status and the submitted time while it is under review', async () => {
    const res = await ask('u1');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).submission).toEqual({
      submissionId: 'sub1', milestoneId: 'm1', status: 'under_review', underReview: true,
      submittedAt: '2026-01-01T10:00:00Z', proctoringData: { reviewStatus: 'pending' },
    });
    for (const word of RESULT_WORDS) expect(res.body).not.toContain(word);
  });

  it('still gives an admin everything', async () => {
    const res = await ask('admin-1');
    expect(JSON.parse(res.body).submission).toMatchObject({ code: SECRET_CODE, score: 100, passedTests: 2, endedBy: 'submit_button' });
  });

  it('shows the full submission once the instructor has approved or rejected it', async () => {
    for (const reviewStatus of ['approved', 'rejected']) {
      getSubmission.mockResolvedValue(stored({ proctoringData: { reviewStatus, reviewNotes: 'Well explained' } }));
      const sub = JSON.parse((await ask('u1')).body).submission;
      expect(sub).toMatchObject({ code: SECRET_CODE, score: 100, proctoringData: { reviewStatus, reviewNotes: 'Well explained' } });
      expect(sub.testResults).toHaveLength(1);
    }
  });

  it('holds a submission saved before the flag existed when its problem has the interview enabled', async () => {
    getSubmission.mockResolvedValue(stored({ heldForReview: undefined, proctoringData: undefined }));
    const res = await ask('u1');
    expect(JSON.parse(res.body).submission.underReview).toBe(true);
    expect(res.body).not.toContain(SECRET_CODE);
  });

  it('does not hold the submission of an ordinary problem', async () => {
    getSubmission.mockResolvedValue(stored({ milestoneId: 'm2', heldForReview: undefined }));
    expect(JSON.parse((await ask('u1')).body).submission).toMatchObject({ code: SECRET_CODE, score: 100 });
  });

  it("403s for someone else's submission, before anything is shown", async () => {
    const res = await ask('u2');
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(SECRET_CODE);
  });
});

describe('the completedMilestones entry in the profile', () => {
  const profile = {
    userId: 'u1', role: 'user', email: 'a@b.edu', credentialsCount: 0,
    completedMilestones: [
      { milestoneId: 'm1', score: 100, passedTests: 2, totalTests: 2, submissionId: 'sub1', completedAt: '2026-01-01T10:05:00Z', heldForReview: true, gradingFailed: true },
      { milestoneId: 'm2', score: 50, passedTests: 1, totalTests: 2, submissionId: 'sub2', completedAt: '2026-01-02T10:05:00Z' },
      { milestoneId: 'm3', score: 100, passedTests: 2, totalTests: 2, submissionId: 'sub3', completedAt: '2026-01-03T10:05:00Z', heldForReview: true, proctoringData: { reviewStatus: 'approved' } },
    ],
  };
  const ask = (userId) => userGet({ httpMethod: 'GET', pathParameters: null, requestContext: { authorizer: { claims: { sub: userId } } } }, {});

  beforeEach(() => {
    getUser.mockImplementation(async (id) => (id === 'u1' ? profile : { userId: id, role: 'admin' }));
  });

  it('keeps only the problem, the submission and the date for an entry that is under review', async () => {
    const { user } = JSON.parse((await ask('u1')).body);
    expect(user.completedMilestones[0]).toEqual({
      milestoneId: 'm1', submissionId: 'sub1', completedAt: '2026-01-01T10:05:00Z', heldForReview: true, underReview: true,
      proctoringData: { reviewStatus: 'pending' },
    });
  });

  it('leaves ordinary entries and reviewed entries as they were', async () => {
    const { user } = JSON.parse((await ask('u1')).body);
    expect(user.completedMilestones[1]).toEqual(profile.completedMilestones[1]);
    expect(user.completedMilestones[2]).toEqual(profile.completedMilestones[2]);
  });

  it('shows an admin the stored entry', () => {
    expect(view.toStudentUser(profile, { isAdmin: true })).toBe(profile);
  });

  it('never changes the stored profile', async () => {
    await ask('u1');
    expect(profile.completedMilestones[0].score).toBe(100);
  });
});

describe('helpers', () => {
  it('holds a C++ problem with the interview enabled, and nothing else', () => {
    expect(view.isHeldForReview(heldMilestone)).toBe(true);
    expect(view.isHeldForReview({ ...heldMilestone, interview: { enabled: false } })).toBe(false);
    expect(view.isHeldForReview({ ...heldMilestone, language: 'python' })).toBe(false);
    expect(view.isHeldForReview({ ...heldMilestone, type: 'embedded' })).toBe(false);
    expect(view.isHeldForReview(plainMilestone)).toBe(false);
    expect(view.isHeldForReview(undefined)).toBe(false);
  });
});
