// The instructor's review of an interview: overrides of the agent's rubric checks, an overall grade and a note. Admin only,
// validated against the interview's own rubric, stored next to (never over) the agent's recorded checks.
jest.mock('../db/interviews', () => ({
  getInterviewMeta: jest.fn(),
  getInterviewTurns: jest.fn(),
  saveInterviewReview: jest.fn(),
  endInterview: jest.fn(),
}));
jest.mock('../db/submissions');
jest.mock('../db/milestones');
jest.mock('../db/users');
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const interviews = require('../db/interviews');
const { getSubmission } = require('../db/submissions');
const { getUser } = require('../db/users');
const { handler: reviewHandler } = require('../../../functions/interviews/review/index.js');
const { handler: getHandler } = require('../../../functions/interviews/get/index.js');

const NOW = Date.parse('2026-01-01T10:00:00Z');
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

const config = {
  enabled: true,
  timeLimitMinutes: 10,
  maxFollowUpsPerMainQuestion: 1,
  promptVersion: 'host.v5',
  themes: [
    {
      id: 'transitions',
      title: 'State transitions',
      mainQuestions: ['Walk me through the readings.', 'Why two levels?'],
      criteria: ['c'],
      rubric: [
        [{ id: 'r1', text: 'holds FILLING at 40' }, { id: 'r2', text: 'pump starts twice' }],
        [{ id: 'r1', text: 'avoids chatter' }],
      ],
    },
  ],
};

const meta = (over = {}) => ({
  interviewId: 'int_sub1', sk: 'META', submissionId: 'sub1', userId: 'u1', status: 'completed', isPractice: false,
  startedAt: iso(0), deadline: iso(600000), endedAt: iso(300000), promptVersion: 'host.v5', turnCount: 5, configSnapshot: config, ...over,
});

const turns = [
  { sk: 'T#0001', role: 'host', text: 'Q1?', kind: 'main', createdAt: iso(0) },
  { sk: 'T#0002', role: 'student', text: 'At 40 it stays FILLING.', createdAt: iso(1000) },
  {
    sk: 'T#0003', role: 'host', text: 'And the pump?', kind: 'follow_up', reason: 'r2 not shown', missing: ['r2'], target: 'r2',
    evidence: { r1: { quote: 'At 40 it stays FILLING', shown: true }, r2: { quote: '', shown: false } }, createdAt: iso(2000),
  },
  { sk: 'T#0004', role: 'student', text: 'No idea.', createdAt: iso(3000) },
  { sk: 'T#0005', role: 'host', text: 'Q2?', kind: 'main', reason: 'engine', engineDecision: true, createdAt: iso(4000) },
];

const event = (userId, body, id = 'int_sub1') => ({
  httpMethod: 'PUT',
  pathParameters: { interviewId: id },
  body: JSON.stringify(body),
  requestContext: { authorizer: { claims: { sub: userId } } },
});
const parse = (res) => JSON.parse(res.body);

beforeEach(() => {
  jest.clearAllMocks();
  interviews.getInterviewMeta.mockResolvedValue(meta());
  interviews.getInterviewTurns.mockResolvedValue(turns);
  interviews.saveInterviewReview.mockResolvedValue();
  getSubmission.mockResolvedValue({ submissionId: 'sub1', code: 'x' });
  getUser.mockImplementation(async (id) => ({ userId: id, role: id.startsWith('admin') ? 'admin' : 'student' }));
});

describe('PUT /interviews/{id}/review', () => {
  it('403s for a student and writes nothing', async () => {
    const res = await reviewHandler(event('u1', { grade: 90 }), {});
    expect(res.statusCode).toBe(403);
    expect(interviews.saveInterviewReview).not.toHaveBeenCalled();
  });

  it('stores the overrides, grade and note with who saved it and when', async () => {
    const res = await reviewHandler(event('admin-1', { overrides: { 1: { r2: true } }, grade: 72.5, note: '  Good on Q1.  ' }), {});
    expect(res.statusCode).toBe(200);
    const stored = interviews.saveInterviewReview.mock.calls[0];
    expect(stored[0]).toBe('int_sub1');
    expect(stored[1]).toMatchObject({ overrides: { 1: { r2: true } }, grade: 72.5, note: 'Good on Q1.', reviewedBy: 'admin-1' });
    expect(typeof stored[1].reviewedAt).toBe('string');
    expect(parse(res).review.grade).toBe(72.5);
  });

  it('accepts an empty review (no overrides, no grade) to clear it', async () => {
    const res = await reviewHandler(event('admin-1', {}), {});
    expect(res.statusCode).toBe(200);
    expect(interviews.saveInterviewReview.mock.calls[0][1]).toMatchObject({ overrides: {}, grade: null, note: '' });
  });

  it.each([
    ['a grade above 100', { grade: 101 }],
    ['a negative grade', { grade: -1 }],
    ['a grade that is not a number', { grade: 'A' }],
    ['a note that is not text', { note: 5 }],
    ['an unknown main question', { overrides: { 3: { r1: true } } }],
    ['an unknown rubric item', { overrides: { 1: { r9: true } } }],
    ['an item of another question', { overrides: { 2: { r2: true } } }],
    ['an override that is not true or false', { overrides: { 1: { r1: 'yes' } } }],
    ['overrides that are not an object', { overrides: [] }],
  ])('refuses %s', async (_name, body) => {
    const res = await reviewHandler(event('admin-1', body), {});
    expect(res.statusCode).toBe(400);
    expect(interviews.saveInterviewReview).not.toHaveBeenCalled();
  });

  it('404s for an unknown interview', async () => {
    interviews.getInterviewMeta.mockResolvedValue(null);
    expect((await reviewHandler(event('admin-1', { grade: 50 }, 'nope'), {})).statusCode).toBe(404);
    expect(interviews.saveInterviewReview).not.toHaveBeenCalled();
  });
});

describe('admin GET with a review', () => {
  const get = async (over) => {
    interviews.getInterviewMeta.mockResolvedValue(meta(over));
    const res = await getHandler({
      httpMethod: 'GET', pathParameters: { interviewId: 'int_sub1' }, requestContext: { authorizer: { claims: { sub: 'admin-1' } } },
    }, {});
    return parse(res).interview;
  };

  it('has review null and no overrides applied before the instructor saves anything', async () => {
    const i = await get();
    expect(i.review).toBeNull();
    expect(i.mainQuestions[0].rubricSummary).toEqual([
      expect.objectContaining({ id: 'r1', agentShown: true, instructorShown: null, changed: false, shown: true, evidence: 'At 40 it stays FILLING' }),
      expect.objectContaining({ id: 'r2', agentShown: false, instructorShown: null, changed: false, shown: false }),
    ]);
  });

  it("keeps the agent's check as recorded and puts the instructor's decision next to it", async () => {
    const i = await get({ review: { overrides: { 1: { r2: true, r1: true } }, grade: 80, note: 'ok', reviewedBy: 'admin-1', reviewedAt: iso(9) } });
    expect(i.review).toMatchObject({ grade: 80, note: 'ok' });
    const [r1, r2] = i.mainQuestions[0].rubricSummary;
    expect(r1).toMatchObject({ agentShown: true, instructorShown: true, changed: false, shown: true });
    expect(r2).toMatchObject({ agentShown: false, instructorShown: true, changed: true, shown: true });
    // The agent's own check on the answer is untouched.
    const check = i.mainQuestions[0].answers[0].check;
    expect(check.items.find((x) => x.id === 'r2').shown).toBe(false);
  });

  it('reports an item the agent never checked as unknown until the instructor decides', async () => {
    const i = await get({ review: { overrides: { 2: { r1: false } } } });
    expect(i.mainQuestions[1].rubricSummary[0]).toMatchObject({ agentShown: null, instructorShown: false, changed: true, shown: false });
  });

  it('never gives a student the review', async () => {
    interviews.getInterviewMeta.mockResolvedValue(meta({ review: { grade: 10, note: 'SECRET-NOTE', overrides: {} } }));
    const res = await getHandler({
      httpMethod: 'GET', pathParameters: { interviewId: 'int_sub1' }, requestContext: { authorizer: { claims: { sub: 'u1' } } },
    }, {});
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('SECRET-NOTE');
  });
});
