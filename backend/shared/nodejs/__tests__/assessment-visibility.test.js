jest.mock('../db/users');
jest.mock('../db/milestones');
jest.mock('../db/embedded-assessments');
jest.mock('../db/submissions');
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { getUser } = require('../db/users');
const { getMilestone, getAllMilestones, createMilestone, updateMilestone } = require('../db/milestones');
const { getEmbeddedAssessment, getAllEmbeddedAssessments } = require('../db/embedded-assessments');
const { getSubmission } = require('../db/submissions');

const milestonesGet = require('../../../functions/milestones/get/index').handler;
const milestonesCreate = require('../../../functions/milestones/create/index').handler;
const milestonesUpdate = require('../../../functions/milestones/update/index').handler;
const embeddedGet = require('../../../functions/embedded-assessments/get/index').handler;
const embeddedCreate = require('../../../functions/embedded-assessments/create/index').handler;
const embeddedUpdate = require('../../../functions/embedded-assessments/update/index').handler;
const submissionsGet = require('../../../functions/submissions/get/index').handler;

const RUBRIC = ['Uses volatile for the register', 'Masks the interrupt before reading'];
const INTERVIEW = {
  enabled: true,
  timeLimitMinutes: 12,
  maxFollowUpsPerTheme: 2,
  themes: [{ id: 't1', title: 'Pointers', mainQuestions: ['Explain?'], criteria: ['SECRET CRITERION'] }],
};
const coding = { milestoneId: 'm1', title: 'List', language: 'cpp', interview: INTERVIEW, sampleTestCases: [] };
const embedded = { milestoneId: 'e1', type: 'embedded', title: 'Registers', rubric: RUBRIC };

const as = (sub, extra = {}) => ({
  httpMethod: extra.method || 'GET',
  headers: {},
  pathParameters: extra.path || null,
  body: extra.body ? JSON.stringify(extra.body) : null,
  requestContext: { authorizer: { claims: { sub } } },
});
const json = (res) => JSON.parse(res.body);

beforeEach(() => {
  jest.resetAllMocks();
  getUser.mockImplementation(async (id) => ({ userId: id, role: id === 'admin1' ? 'admin' : 'user' }));
  getAllMilestones.mockResolvedValue([coding, embedded]);
  getMilestone.mockImplementation(async (id) => [coding, embedded].find((m) => m.milestoneId === id));
  getAllEmbeddedAssessments.mockResolvedValue([embedded]);
  getEmbeddedAssessment.mockResolvedValue(embedded);
});

describe('GET /milestones', () => {
  it('gives a student criteriaCount and interview flags, never the criteria or questions', async () => {
    const res = await milestonesGet(as('u1'));
    expect(res.statusCode).toBe(200);
    const text = res.body;
    expect(text).not.toContain('SECRET CRITERION');
    expect(text).not.toContain('Uses volatile');
    expect(text).not.toContain('Explain?');
    const { milestones } = json(res);
    const e = milestones.find((m) => m.milestoneId === 'e1');
    expect(e.criteriaCount).toBe(2);
    expect(e.rubric).toBeUndefined();
    const c = milestones.find((m) => m.milestoneId === 'm1');
    expect(c.interview).toBeUndefined();
    expect(c.interviewEnabled).toBe(true);
    expect(c.interviewTimeLimitMinutes).toBe(12);
  });

  it('strips the same fields on the single-milestone route', async () => {
    const res = await milestonesGet(as('u1', { path: { milestoneId: 'm1' } }));
    expect(res.body).not.toContain('SECRET CRITERION');
    const res2 = await milestonesGet(as('u1', { path: { milestoneId: 'e1' } }));
    expect(res2.body).not.toContain('Uses volatile');
    expect(json(res2).milestone.criteriaCount).toBe(2);
  });

  it('gives an admin the rubric and the interview setup', async () => {
    const { milestones } = json(await milestonesGet(as('admin1')));
    expect(milestones.find((m) => m.milestoneId === 'e1').rubric).toEqual(RUBRIC);
    expect(milestones.find((m) => m.milestoneId === 'e1').criteriaCount).toBe(2);
    expect(milestones.find((m) => m.milestoneId === 'm1').interview.themes[0].criteria).toEqual(['SECRET CRITERION']);
  });

  it('treats an unknown user as a student', async () => {
    getUser.mockResolvedValue(undefined);
    expect(json(await milestonesGet(as('ghost'))).milestones.every((m) => !m.rubric && !m.interview)).toBe(true);
  });
});

describe('GET /embedded-assessments', () => {
  it('gives a student criteriaCount only, on both routes', async () => {
    const list = await embeddedGet(as('u1'));
    expect(list.body).not.toContain('Uses volatile');
    expect(json(list).assessments[0]).toMatchObject({ criteriaCount: 2 });

    const one = await embeddedGet(as('u1', { path: { assessmentId: 'e1' } }));
    expect(one.body).not.toContain('Masks the interrupt');
    expect(json(one).assessment.criteriaCount).toBe(2);
  });

  it('gives an admin the rubric', async () => {
    expect(json(await embeddedGet(as('admin1'))).assessments[0].rubric).toEqual(RUBRIC);
    expect(json(await embeddedGet(as('admin1', { path: { assessmentId: 'e1' } }))).assessment.rubric).toEqual(RUBRIC);
  });
});

describe('GET /submissions/{id}', () => {
  const sub = (reviewStatus) => ({
    submissionId: 's1', userId: 'u1', milestoneId: 'e1', type: 'embedded', status: 'manual_review',
    passedCriteria: 1, totalCriteria: 2, score: 50,
    proctoringData: { reviewStatus },
    rubricResults: RUBRIC.map((criterion, i) => ({ criterion, passed: i === 0, feedback: `feedback ${i}` })),
  });
  const get = (sub1, user) => { getSubmission.mockResolvedValue(sub1); return submissionsGet(as(user, { path: { submissionId: 's1' } })); };

  it('does not leak the criteria through the placeholder rows before review', async () => {
    const res = await get(sub('pending'), 'u1');
    expect(res.body).not.toContain('Uses volatile');
    expect(json(res).submission.rubricResults).toBeUndefined();
    expect(json(res).submission.totalCriteria).toBe(2);
  });

  it.each(['approved', 'rejected'])('shows the student criteria and feedback on their own %s submission', async (status) => {
    const { submission } = json(await get(sub(status), 'u1'));
    expect(submission.rubricResults).toEqual([
      { criterion: RUBRIC[0], passed: true, feedback: 'feedback 0' },
      { criterion: RUBRIC[1], passed: false, feedback: 'feedback 1' },
    ]);
  });

  it("still refuses another student's submission", async () => {
    expect((await get(sub('approved'), 'u2')).statusCode).toBe(403);
  });

  it('gives an admin the criteria at any stage', async () => {
    expect(json(await get(sub('pending'), 'admin1')).submission.rubricResults).toHaveLength(2);
  });

  it('leaves coding submissions untouched', async () => {
    const coding1 = { submissionId: 's1', userId: 'u1', type: undefined, testResults: [], proctoringData: { reviewStatus: 'pending' } };
    expect(json(await get(coding1, 'u1')).submission.proctoringData.reviewStatus).toBe('pending');
  });
});

describe('creating and updating interview setups', () => {
  const admin = (method, body, path) => as('admin1', { method, body, path });

  it('stores a validated interview on create and does not log the criteria', async () => {
    createMilestone.mockImplementation(async (d) => ({ milestoneId: 'new', ...d }));
    const res = await milestonesCreate(admin('POST', { title: 'T', description: 'D', language: 'cpp', interview: INTERVIEW }));
    expect(res.statusCode).toBe(201);
    expect(createMilestone.mock.calls[0][0].interview.timeLimitMinutes).toBe(12);
    const log = require('../utils/logger');
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('SECRET CRITERION');
  });

  it('rejects an invalid interview, and an interview on a non-C++ problem', async () => {
    const bad = await milestonesCreate(admin('POST', { title: 'T', description: 'D', language: 'cpp', interview: { enabled: true, themes: [] } }));
    expect(bad.statusCode).toBe(400);
    const wrongLang = await milestonesCreate(admin('POST', { title: 'T', description: 'D', language: 'python', interview: INTERVIEW }));
    expect(wrongLang.statusCode).toBe(400);
    expect(createMilestone).not.toHaveBeenCalled();
  });

  it('students cannot create or update anything', async () => {
    const res = await milestonesCreate(as('u1', { method: 'POST', body: { title: 'T', description: 'D', interview: INTERVIEW } }));
    expect(res.statusCode).toBe(403);
    expect(createMilestone).not.toHaveBeenCalled();
  });

  it('update stores only the validated interview and can clear it', async () => {
    updateMilestone.mockImplementation(async (id, u) => ({ milestoneId: id, ...u }));
    await milestonesUpdate(admin('PUT', { title: 'New', interview: { ...INTERVIEW, unknownKey: 'x' } }, { milestoneId: 'm1' }));
    expect(updateMilestone.mock.calls[0][1].interview.unknownKey).toBeUndefined();

    await milestonesUpdate(admin('PUT', { interview: null }, { milestoneId: 'm1' }));
    expect(updateMilestone.mock.calls[1][1].interview).toBeNull();
  });

  it('update keeps an existing interview consistent with the language', async () => {
    const res = await milestonesUpdate(admin('PUT', { title: 'T', language: 'python' }, { milestoneId: 'm1' }));
    expect(res.statusCode).toBe(400);
  });

  it('is rejected on embedded assessments', async () => {
    const created = await embeddedCreate(admin('POST', { title: 'T', rubric: ['a'], interview: INTERVIEW }));
    expect(created.statusCode).toBe(400);
    const updated = await embeddedUpdate(admin('PUT', { title: 'T', interview: INTERVIEW }, { assessmentId: 'e1' }));
    expect(updated.statusCode).toBe(400);
    const viaMilestones = await milestonesUpdate(admin('PUT', { interview: INTERVIEW }, { milestoneId: 'e1' }));
    expect(viaMilestones.statusCode).toBe(400);
  });
});
