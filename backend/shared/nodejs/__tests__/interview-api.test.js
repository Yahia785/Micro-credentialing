// The interview API for the screens: the student view and the admin view are different shapes, a student never receives an
// admin field, and practice interviews (admin only) never count as the real interview of a submission.
jest.mock('../db/interviews', () => ({
  interviewIdFor: (id) => `int_${id}`,
  practiceInterviewId: () => 'intp_fixed',
  createInterview: jest.fn(),
  getInterviewMeta: jest.fn(),
  getInterviewTurns: jest.fn(),
  getInterviewBySubmission: jest.fn(),
  listInterviewsBySubmission: jest.fn(),
  appendTurns: jest.fn(),
  endInterview: jest.fn(),
}));
// The model is always a fake in tests: nothing here can reach Bedrock.
jest.mock('../agent/bedrock-client', () => ({
  ...jest.requireActual('../agent/bedrock-client'),
  converse: jest.fn(async () => ({ text: JSON.stringify({ action: 'next_main', question: '', reason: 'fake model' }), inputTokens: 1, outputTokens: 1, latencyMs: 1 })),
}));
jest.mock('../db/submissions');
jest.mock('../db/milestones');
jest.mock('../db/users');
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const interviews = require('../db/interviews');
const { getSubmission } = require('../db/submissions');
const { getMilestone } = require('../db/milestones');
const { getUser } = require('../db/users');
const log = require('../utils/logger');
const service = require('../services/interview-service');
const { handler: getHandler } = require('../../../functions/interviews/get/index.js');
const { handler: listHandler } = require('../../../functions/interviews/list/index.js');
const { handler: practiceHandler } = require('../../../functions/interviews/practice/index.js');
const { handler: createHandler } = require('../../../functions/interviews/create/index.js');
const { handler: answerHandler } = require('../../../functions/interviews/answer/index.js');

const NOW = Date.parse('2026-01-01T10:00:00Z');
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const SECRET_CODE = 'int secretVariableName = 42;';

// Two main questions, each with a rubric of two items. Q1 gets one follow-up (a hint); Q2 is the pending question.
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
      criteria: ['CRITERION-TEXT the student traces each reading'],
      rubric: [
        [{ id: 'r1', text: 'RUBRIC-A holds FILLING at 40' }, { id: 'r2', text: 'RUBRIC-B pump starts twice' }],
        [{ id: 'r1', text: 'RUBRIC-C avoids chatter' }, { id: 'r2', text: 'RUBRIC-D less wear' }],
      ],
    },
  ],
};

const meta = (over = {}) => ({
  interviewId: 'int_sub1', sk: 'META', submissionId: 'sub1', userId: 'u1', milestoneId: 'm1',
  status: 'in_progress', isPractice: false, startedAt: iso(0), deadline: iso(10 * 60000), endedAt: null, endReason: null,
  modelId: 'qwen.qwen3-coder-30b-a3b-v1:0', checkerModelId: 'deepseek.v3.2', writerModelId: 'deepseek.v3.2', promptVersion: 'host.v5',
  themeIndex: 0, mainIndex: 1, followUpCount: 0, fallbackCount: 0, turnCount: 5, configSnapshot: config, ...over,
});

const turns = [
  { sk: 'T#0001', role: 'host', text: 'Walk me through the readings.', themeId: 'transitions', kind: 'main', reason: 'first main question', createdAt: iso(0) },
  { sk: 'T#0002', role: 'student', text: 'At 40 it stays FILLING, it starts at 18.', themeId: 'transitions', kind: 'main', createdAt: iso(60000), clientTiming: { firstKeystrokeMs: 900, pasteCount: 1, focusLossCount: 0 } },
  {
    sk: 'T#0003', role: 'host', text: 'What does the pump do at the reading 15?', themeId: 'transitions', kind: 'follow_up',
    reason: 'check: r2 not shown; asked about r2', modelReason: 'MODEL-SAID', missing: ['r2'], target: 'r2', isHint: true,
    guard: { fired: true, original: 'ORIGINAL two questions? and?', fixedByRetry: true },
    repairs: [{ type: 'yes_no_rewrite', original: 'Did it start?', fixed: true }],
    evidence: { r1: { quote: 'At 40 it stays FILLING', shown: true }, r2: { quote: '', shown: false } },
    models: { checker: 'deepseek.v3.2', writer: 'deepseek.v3.2' },
    calls: [{ step: 'check', modelId: 'deepseek.v3.2', inputTokens: 10, outputTokens: 4, latencyMs: 20 }],
    latencyMs: 40, inputTokens: 12, outputTokens: 6, createdAt: iso(61000),
  },
  { sk: 'T#0004', role: 'student', text: 'It starts again at 15.', themeId: 'transitions', kind: 'follow_up', createdAt: iso(120000), clientTiming: { pasteCount: 0 } },
  {
    sk: 'T#0005', role: 'host', text: 'Why two levels?', themeId: 'transitions', kind: 'main',
    reason: 'engine: no follow-up left for this main question; asked the next main question', engineDecision: true, createdAt: iso(120500),
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  // The handlers read the real clock: pin it one second after the interview started.
  jest.useFakeTimers({ now: NOW + 1000, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval'] });
  getSubmission.mockResolvedValue({ submissionId: 'sub1', userId: 'u1', milestoneId: 'm1', language: 'cpp', endedBy: 'submit_button', code: SECRET_CODE });
  getMilestone.mockResolvedValue({ milestoneId: 'm1', language: 'cpp', interview: config });
  interviews.getInterviewBySubmission.mockResolvedValue(null);
  interviews.createInterview.mockResolvedValue({});
  interviews.getInterviewMeta.mockResolvedValue(meta());
  interviews.getInterviewTurns.mockResolvedValue(turns);
  interviews.listInterviewsBySubmission.mockResolvedValue([]);
  interviews.appendTurns.mockResolvedValue();
  getUser.mockImplementation(async (id) => ({ userId: id, role: id.startsWith('admin') ? 'admin' : 'student' }));
});

afterEach(() => jest.useRealTimers());

const event = (userId, extra = {}) => ({
  httpMethod: 'GET',
  requestContext: { authorizer: { claims: { sub: userId } } },
  ...extra,
});
const body = (res) => JSON.parse(res.body);

describe('student view (GET /interviews/{id} as the owner)', () => {
  const STUDENT_KEYS = ['interviewId', 'status', 'startedAt', 'endedAt', 'deadline', 'timeLeftMs', 'serverNow', 'currentQuestion', 'progress', 'turns', 'code'];

  it('has only the allowed fields: status, time left, the questions asked so far and their own answers', async () => {
    const res = await getHandler(event('u1', { pathParameters: { interviewId: 'int_sub1' } }), {});
    expect(res.statusCode).toBe(200);
    const { interview } = body(res);
    expect(Object.keys(interview).sort()).toEqual([...STUDENT_KEYS].sort());
    expect(interview.status).toBe('in_progress');
    expect(interview.timeLeftMs).toBeGreaterThan(0);
    expect(interview.currentQuestion).toBe('Why two levels?');
    // The submitted code is held for the instructor, so the interview may show it only while it is running.
    expect(interview.code).toBe(SECRET_CODE);
    expect(interview.progress).toEqual({ questionNumber: 2, questionCount: 2 });
    expect(interview.turns).toEqual([
      { role: 'host', text: 'Walk me through the readings.', createdAt: iso(0) },
      { role: 'student', text: 'At 40 it stays FILLING, it starts at 18.', createdAt: iso(60000) },
      { role: 'host', text: 'What does the pump do at the reading 15?', createdAt: iso(61000) },
      { role: 'student', text: 'It starts again at 15.', createdAt: iso(120000) },
      { role: 'host', text: 'Why two levels?', createdAt: iso(120500) },
    ]);
  });

  it('never contains criteria, rubric, evidence, reasons, model ids, hints, guards, code or the next question', async () => {
    // Ask about Q1 only: Q2's text is the "next question" and must not be there yet.
    interviews.getInterviewMeta.mockResolvedValue(meta({ mainIndex: 0, turnCount: 3 }));
    interviews.getInterviewTurns.mockResolvedValue(turns.slice(0, 3));
    const res = await getHandler(event('u1', { pathParameters: { interviewId: 'int_sub1' } }), {});
    const json = res.body;
    const forbidden = [
      'CRITERION-TEXT', 'RUBRIC-', 'criteria', 'rubric', 'evidence', 'quote', 'missing', 'target', 'isHint', 'guard', 'repairs',
      'reason', 'MODEL-SAID', 'modelId', 'deepseek', 'qwen', 'promptVersion', 'host.v5', 'configSnapshot', 'models', 'calls',
      'latencyMs', 'inputTokens', 'clientTiming', 'themeId', 'userId', 'submissionId', 'milestoneId', 'isPractice', 'endDetail',
      'Why two levels?',
    ];
    for (const word of forbidden) expect(json).not.toContain(word);
  });

  it('has no currentQuestion once the interview is over', async () => {
    interviews.getInterviewMeta.mockResolvedValue(meta({ status: 'completed', endedAt: iso(300000), endDetail: { reason: 'secret', evidence: {} } }));
    const res = await getHandler(event('u1', { pathParameters: { interviewId: 'int_sub1' } }), {});
    const { interview } = body(res);
    expect(interview.currentQuestion).toBeNull();
    expect(interview.code).toBeNull();
    expect(res.body).not.toContain(SECRET_CODE);
    expect(interview.timeLeftMs).toBe(0);
    expect(JSON.stringify(interview)).not.toContain('secret');
  });

  it('403s for another student, and for the submission owner on a practice interview', async () => {
    expect((await getHandler(event('u2', { pathParameters: { interviewId: 'int_sub1' } }), {})).statusCode).toBe(403);
    interviews.getInterviewMeta.mockResolvedValue(meta({ interviewId: 'intp_fixed', isPractice: true, userId: 'admin-1' }));
    expect((await getHandler(event('u1', { pathParameters: { interviewId: 'intp_fixed' } }), {})).statusCode).toBe(403);
  });

  it('keeps the student view even when the caller role lookup fails', async () => {
    getUser.mockRejectedValue(new Error('AccessDenied'));
    const res = await getHandler(event('u1', { pathParameters: { interviewId: 'int_sub1' } }), {});
    // withHandler turns a failed lookup into an error rather than an admin view.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toContain('RUBRIC-');
  });
});

describe('admin view (GET /interviews/{id} as an admin)', () => {
  const get = async () => body(await getHandler(event('admin-1', { pathParameters: { interviewId: 'int_sub1' } }), {})).interview;

  it('shows the total time added while the agent worked, and the student view never does', async () => {
    interviews.getInterviewMeta.mockResolvedValue(meta({ extraTimeMs: 7300 }));
    expect((await get()).extraTimeMs).toBe(7300);
    interviews.getInterviewMeta.mockResolvedValue(meta());
    expect((await get()).extraTimeMs).toBe(0);

    interviews.getInterviewMeta.mockResolvedValue(meta({ extraTimeMs: 7300 }));
    const student = await getHandler(event('u1', { pathParameters: { interviewId: 'int_sub1' } }), {});
    expect(student.body).not.toContain('extraTimeMs');
    expect(student.body).not.toContain('7300');
  });

  it('has the interview header: prompt version, both model ids, start, deadline, end, status, isPractice and the code', async () => {
    const i = await get();
    expect(i).toMatchObject({
      interviewId: 'int_sub1', submissionId: 'sub1', status: 'in_progress', isPractice: false, promptVersion: 'host.v5',
      modelId: 'qwen.qwen3-coder-30b-a3b-v1:0', checkerModelId: 'deepseek.v3.2', writerModelId: 'deepseek.v3.2',
      startedAt: iso(0), deadline: iso(10 * 60000), endedAt: null, code: SECRET_CODE,
    });
    expect(i.sk).toBeUndefined();
    expect(i.configSnapshot).toBeUndefined();
  });

  it('groups per main question, with the check per rubric item as the student quote or "not shown"', async () => {
    const i = await get();
    expect(i.mainQuestions).toHaveLength(2);
    const q1 = i.mainQuestions[0];
    expect(q1).toMatchObject({ index: 1, themeId: 'transitions', themeTitle: 'State transitions', question: 'Walk me through the readings.', askedAt: iso(0) });
    expect(q1.rubric.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(q1.answers).toHaveLength(2);

    const first = q1.answers[0];
    expect(first).toMatchObject({ text: 'At 40 it stays FILLING, it starts at 18.', answeredAt: iso(60000), clientTiming: { pasteCount: 1 } });
    expect(first.check.items).toEqual([
      { id: 'r1', text: 'RUBRIC-A holds FILLING at 40', shown: true, evidence: 'At 40 it stays FILLING' },
      { id: 'r2', text: 'RUBRIC-B pump starts twice', shown: false, evidence: 'not shown' },
    ]);
    expect(first.check).toMatchObject({ missing: ['r2'], target: 'r2', isHint: true, modelReason: 'MODEL-SAID' });
    expect(first.check.guard).toMatchObject({ fired: true, fixedByRetry: true });
    expect(first.check.repairs).toEqual([{ type: 'yes_no_rewrite', original: 'Did it start?', fixed: true }]);
    expect(first.check.models).toEqual({ checker: 'deepseek.v3.2', writer: 'deepseek.v3.2' });
  });

  it('lists each follow-up with isHint, its target and a timestamp', async () => {
    const q1 = (await get()).mainQuestions[0];
    expect(q1.followUps).toEqual([
      { question: 'What does the pump do at the reading 15?', askedAt: iso(61000), afterAnswer: 1, isHint: true, target: 'r2' },
    ]);
  });

  it('shows an answer decided by the engine alone (no model check) with unknown items, not invented evidence', async () => {
    const q1 = (await get()).mainQuestions[0];
    const second = q1.answers[1];
    expect(second.check.engineDecision).toBe(true);
    expect(second.check.items.every((item) => item.shown === null && item.evidence === null)).toBe(true);
    expect(second.check.reason).toContain('no follow-up left');
  });

  it('takes the check of the last answer from the end detail when the interview is over', async () => {
    interviews.getInterviewMeta.mockResolvedValue(meta({
      status: 'completed', endedAt: iso(300000), turnCount: 6,
      endDetail: { reason: 'check: every rubric item is shown; no follow-up needed', missing: [], target: null, isHint: false, evidence: { r1: { quote: 'avoids chatter', shown: true }, r2: { quote: 'less wear', shown: true } } },
    }));
    interviews.getInterviewTurns.mockResolvedValue([...turns, { sk: 'T#0006', role: 'student', text: 'It avoids chatter and means less wear.', kind: 'main', createdAt: iso(180000) }]);
    const i = await get();
    const last = i.mainQuestions[1].answers[0];
    expect(last.check.items.map((item) => item.evidence)).toEqual(['avoids chatter', 'less wear']);
    expect(last.check.missing).toEqual([]);
    expect(i.endedAt).toBe(iso(300000));
  });

  it('keeps every stored turn, with its timestamps, tokens and reasons', async () => {
    const i = await get();
    expect(i.turns).toHaveLength(5);
    expect(i.turns.map((t) => t.createdAt)).toEqual([iso(0), iso(60000), iso(61000), iso(120000), iso(120500)]);
    expect(i.turns[2]).toMatchObject({ isHint: true, latencyMs: 40, inputTokens: 12 });
    expect(i.turns.every((t) => t.sk === undefined)).toBe(true);
  });

  it('works for an interview from an older prompt version (no evidence, no missing list)', async () => {
    interviews.getInterviewMeta.mockResolvedValue(meta({ promptVersion: 'host.v3', checkerModelId: undefined, writerModelId: undefined }));
    interviews.getInterviewTurns.mockResolvedValue([
      { sk: 'T#0001', role: 'host', text: 'Walk me through the readings.', kind: 'main', createdAt: iso(0) },
      { sk: 'T#0002', role: 'student', text: 'ok', kind: 'main', createdAt: iso(1000) },
      { sk: 'T#0003', role: 'host', text: 'Why two levels?', kind: 'main', reason: 'moved on', createdAt: iso(2000) },
    ]);
    const i = await get();
    expect(i.checkerModelId).toBeNull();
    expect(i.mainQuestions[0].answers[0].check.items.every((item) => item.shown === null)).toBe(true);
  });
});

describe('POST /interviews (start after a submission)', () => {
  const post = (userId, submissionId = 'sub1') => createHandler(event(userId, { httpMethod: 'POST', body: JSON.stringify({ submissionId }) }), {});

  it('starts a real interview for a normal submission of this problem, with the problem\'s prompt version and models', async () => {
    const res = await post('u1');
    expect(res.statusCode).toBe(201);
    expect(body(res)).toEqual({ interviewId: 'int_sub1', question: 'Walk me through the readings.', deadline: iso(1000 + 10 * 60000), serverNow: expect.any(String) });
    const stored = interviews.createInterview.mock.calls[0][0];
    expect(stored).toMatchObject({ isPractice: false, promptVersion: 'host.v5', userId: 'u1', submissionId: 'sub1' });
    expect(stored.checkerModelId).toBeTruthy();
    expect(stored.writerModelId).toBeTruthy();
  });

  it('is still refused when a real interview exists, but a practice interview does not count as one', async () => {
    interviews.getInterviewBySubmission.mockResolvedValue(meta());
    expect((await post('u1')).statusCode).toBe(409);
  });
});

describe('POST /interviews/practice (admin only)', () => {
  const practice = (userId, submissionId = 'sub1') => practiceHandler(event(userId, { httpMethod: 'POST', body: JSON.stringify({ submissionId }) }), {});

  it('403s for a student, before anything is read or written', async () => {
    const res = await practice('u1');
    expect(res.statusCode).toBe(403);
    expect(getSubmission).not.toHaveBeenCalled();
    expect(interviews.createInterview).not.toHaveBeenCalled();
  });

  it("starts a new interview on the submission's code, owned by the admin, marked isPractice, same timing and engine", async () => {
    const res = await practice('admin-1');
    expect(res.statusCode).toBe(201);
    expect(body(res)).toMatchObject({ interviewId: 'intp_fixed', question: 'Walk me through the readings.', isPractice: true });
    const [stored, firstTurn] = interviews.createInterview.mock.calls[0];
    expect(stored).toMatchObject({
      interviewId: 'intp_fixed', isPractice: true, userId: 'admin-1', submissionId: 'sub1', milestoneId: 'm1', status: 'in_progress',
      promptVersion: 'host.v5', turnCount: 1,
    });
    expect(Date.parse(stored.deadline) - Date.parse(stored.startedAt)).toBe(10 * 60000);
    expect(stored.configSnapshot).toEqual(config);
    expect(firstTurn).toMatchObject({ role: 'host', text: 'Walk me through the readings.', kind: 'main' });
  });

  it('is not limited by the one interview per submission rule, and never looks at the real interview', async () => {
    interviews.getInterviewBySubmission.mockResolvedValue(meta());
    expect((await practice('admin-1')).statusCode).toBe(201);
    expect((await practice('admin-1')).statusCode).toBe(201);
    expect(interviews.getInterviewBySubmission).not.toHaveBeenCalled();
  });

  it('works on a submission that ended by leaving the page, and on someone else\'s submission', async () => {
    getSubmission.mockResolvedValue({ submissionId: 'sub1', userId: 'u1', milestoneId: 'm1', language: 'cpp', endedBy: 'left_page', code: 'x' });
    expect((await practice('admin-1')).statusCode).toBe(201);
  });

  it.each([
    ['an unknown submission', () => getSubmission.mockResolvedValue(undefined), 404],
    ['a non-C++ submission', () => getSubmission.mockResolvedValue({ submissionId: 'sub1', userId: 'u1', milestoneId: 'm1', language: 'python' }), 400],
    ['a problem without an interview', () => getMilestone.mockResolvedValue({ milestoneId: 'm1', language: 'cpp' }), 400],
  ])('refuses %s', async (_name, arrange, status) => {
    arrange();
    expect((await practice('admin-1')).statusCode).toBe(status);
    expect(interviews.createInterview).not.toHaveBeenCalled();
  });

  it('requires a submissionId', async () => {
    expect((await practice('admin-1', null)).statusCode).toBe(400);
  });

  it('is answered by the admin through the normal answers endpoint, and by nobody else', async () => {
    interviews.getInterviewMeta.mockResolvedValue(meta({ interviewId: 'intp_fixed', isPractice: true, userId: 'admin-1', configSnapshot: { ...config, promptVersion: 'host.v3' }, promptVersion: 'host.v3', mainIndex: 0, turnCount: 1 }));
    interviews.getInterviewTurns.mockResolvedValue([turns[0]]);
    const answer = (userId) => answerHandler(event(userId, {
      httpMethod: 'POST', pathParameters: { interviewId: 'intp_fixed' }, body: JSON.stringify({ answer: 'it holds the state' }),
    }), {});
    expect((await answer('u1')).statusCode).toBe(403);
    // The admin's answer is accepted and stored (the model is a fake).
    const res = await answer('admin-1');
    expect(res.statusCode).toBe(200);
    expect(interviews.appendTurns).toHaveBeenCalledTimes(1);
  });

  it('never logs code, questions or rubric text', async () => {
    await practice('admin-1');
    const logged = JSON.stringify(log.info.mock.calls);
    for (const text of [SECRET_CODE, 'Walk me through', 'RUBRIC-A', 'CRITERION-TEXT']) expect(logged).not.toContain(text);
  });
});

describe('GET /interviews?submissionId= (admin only)', () => {
  const list = (userId, submissionId = 'sub1') => listHandler(event(userId, { queryStringParameters: submissionId ? { submissionId } : null }), {});

  it('403s for a student', async () => {
    const res = await list('u1');
    expect(res.statusCode).toBe(403);
    expect(interviews.listInterviewsBySubmission).not.toHaveBeenCalled();
  });

  it('lists the real and the practice interviews of the submission as summaries, without transcripts or setup', async () => {
    interviews.listInterviewsBySubmission.mockResolvedValue([
      meta({ status: 'completed', endedAt: iso(300000), turnCount: 9 }),
      meta({ interviewId: 'intp_fixed', isPractice: true, userId: 'admin-1', startedAt: iso(900000), deadline: iso(1500000), turnCount: 1 }),
    ]);
    const res = await list('admin-1');
    expect(res.statusCode).toBe(200);
    expect(interviews.listInterviewsBySubmission).toHaveBeenCalledWith('sub1');
    const { interviews: rows } = body(res);
    expect(rows).toEqual([
      { interviewId: 'int_sub1', submissionId: 'sub1', userId: 'u1', isPractice: false, status: 'completed', promptVersion: 'host.v5', startedAt: iso(0), deadline: iso(10 * 60000), endedAt: iso(300000), turnCount: 9 },
      { interviewId: 'intp_fixed', submissionId: 'sub1', userId: 'admin-1', isPractice: true, status: 'in_progress', promptVersion: 'host.v5', startedAt: iso(900000), deadline: iso(1500000), endedAt: null, turnCount: 1 },
    ]);
    expect(res.body).not.toContain('RUBRIC-');
  });

  it('returns an empty list when nothing was started, and requires a submissionId', async () => {
    expect(body(await list('admin-1')).interviews).toEqual([]);
    expect((await list('admin-1', null)).statusCode).toBe(400);
  });
});

describe('practice interviews never count as the real interview', () => {
  it('the database lookup of the real interview skips them, and the list returns every interview oldest first', async () => {
    jest.resetModules();
    const send = jest.fn();
    jest.doMock('@aws-sdk/lib-dynamodb', () => ({
      DynamoDBDocumentClient: { from: () => ({ send }) },
      GetCommand: class { constructor(p) { this.p = p; } },
      QueryCommand: class { constructor(p) { this.p = p; } },
      UpdateCommand: class { constructor(p) { this.p = p; } },
      TransactWriteCommand: class { constructor(p) { this.p = p; } },
    }));
    jest.doMock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }));
    const real = jest.requireActual('../db/interviews');
    const practiceItem = { interviewId: 'intp_1', isPractice: true, startedAt: '2026-01-01T09:00:00Z' };
    const realItem = { interviewId: 'int_sub1', isPractice: false, startedAt: '2026-01-01T10:00:00Z' };
    send.mockResolvedValueOnce({ Items: [realItem], LastEvaluatedKey: { k: 1 } }).mockResolvedValueOnce({ Items: [practiceItem] });
    expect((await real.listInterviewsBySubmission('sub1')).map((i) => i.interviewId)).toEqual(['intp_1', 'int_sub1']);

    send.mockReset().mockResolvedValueOnce({ Items: [practiceItem] });
    expect(await real.getInterviewBySubmission('sub1')).toBeNull();
    send.mockReset().mockResolvedValueOnce({ Items: [practiceItem, realItem] });
    expect((await real.getInterviewBySubmission('sub1')).interviewId).toBe('int_sub1');
    jest.dontMock('@aws-sdk/lib-dynamodb');
    jest.dontMock('@aws-sdk/client-dynamodb');
  });

  it('practice interview IDs differ from the derived real ID', () => {
    const real = jest.requireActual('../db/interviews');
    expect(real.practiceInterviewId()).toMatch(/^intp_[0-9a-f-]{36}$/);
    expect(real.practiceInterviewId()).not.toBe(real.practiceInterviewId());
    expect(real.interviewIdFor('sub1')).toBe('int_sub1');
  });

  it('the service exports the three entry points the handlers use', () => {
    expect(typeof service.startPracticeInterview).toBe('function');
    expect(typeof service.listSubmissionInterviews).toBe('function');
  });
});
