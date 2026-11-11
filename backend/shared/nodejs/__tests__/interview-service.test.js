jest.mock('../db/interviews', () => ({
  interviewIdFor: (id) => `int_${id}`,
  practiceInterviewId: () => 'intp_fixed',
  listInterviewsBySubmission: jest.fn(),
  createInterview: jest.fn(),
  getInterviewMeta: jest.fn(),
  getInterviewTurns: jest.fn(),
  getInterviewBySubmission: jest.fn(),
  appendTurns: jest.fn(),
  endInterview: jest.fn(),
  startInterviewClock: jest.fn(),
}));
jest.mock('../db/submissions');
jest.mock('../db/milestones');
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const interviews = require('../db/interviews');
const { getSubmission } = require('../db/submissions');
const { getMilestone } = require('../db/milestones');
const log = require('../utils/logger');
const { ModelUnavailableError } = require('../agent/bedrock-client');
const {
  startInterview, submitAnswer, getInterview,
} = require('../services/interview-service');

const CRITERION = 'Student must mention that delete is paired with new';
const SECRET_CODE = 'int secretVariableName = 42;';
const SECRET_ANSWER = 'my private answer text';

const config = {
  enabled: true,
  timeLimitMinutes: 10,
  maxFollowUpsPerMainQuestion: 1,
  themes: [
    { id: 'ptr', title: 'Pointers', mainQuestions: ['Main A1?', 'Main A2?'], criteria: [CRITERION] },
  ],
};
const submission = (over = {}) => ({
  submissionId: 'sub1', userId: 'u1', milestoneId: 'm1', language: 'cpp', status: 'passed',
  endedBy: 'submit_button', code: SECRET_CODE, ...over,
});
const milestone = (over = {}) => ({ milestoneId: 'm1', language: 'cpp', interview: config, ...over });

const NOW = Date.parse('2026-01-01T10:00:00Z');
const meta = (over = {}) => ({
  interviewId: 'int_sub1', sk: 'META', submissionId: 'sub1', userId: 'u1', milestoneId: 'm1',
  status: 'in_progress', startedAt: new Date(NOW).toISOString(),
  deadline: new Date(NOW + 10 * 60000).toISOString(),
  modelId: 'qwen.qwen3-coder-30b-a3b-v1:0', promptVersion: 'host.v1',
  themeIndex: 0, mainIndex: 0, followUpCount: 0, fallbackCount: 0, turnCount: 1,
  configSnapshot: config, ...over,
});
const firstTurn = { sk: 'T#0001', role: 'host', text: 'Main A1?', themeId: 'ptr', kind: 'main', reason: 'first main question', createdAt: 'x' };

const reply = (obj) => async () => ({ text: JSON.stringify(obj), inputTokens: 10, outputTokens: 5, latencyMs: 30 });

beforeEach(() => {
  jest.clearAllMocks();
  getSubmission.mockResolvedValue(submission());
  getMilestone.mockResolvedValue(milestone());
  interviews.getInterviewBySubmission.mockResolvedValue(null);
  interviews.createInterview.mockResolvedValue({});
  interviews.getInterviewMeta.mockResolvedValue(meta());
  interviews.getInterviewTurns.mockResolvedValue([firstTurn]);
  interviews.appendTurns.mockResolvedValue();
  interviews.endInterview.mockResolvedValue(true);
});

describe('startInterview', () => {
  const start = (over = {}) => startInterview({ userId: 'u1', submissionId: 'sub1', now: NOW, ...over });

  it('creates the interview and returns the first question and deadline', async () => {
    const result = await start();
    // The clock does not start at create: it starts when the page first opens the interview.
    expect(result).toEqual({
      interviewId: 'int_sub1',
      question: 'Main A1?',
      deadline: null,
      timeLimitMinutes: 10,
      questionCount: 2,
      serverNow: new Date(NOW).toISOString(),
    });
    const [createdMeta, turn] = interviews.createInterview.mock.calls[0];
    expect(createdMeta).toMatchObject({
      submissionId: 'sub1', userId: 'u1', milestoneId: 'm1', status: 'in_progress',
      promptVersion: 'host.v3', modelId: 'qwen.qwen3-coder-30b-a3b-v1:0',
      themeIndex: 0, mainIndex: 0, followUpCount: 0, fallbackCount: 0, turnCount: 1,
    });
    expect(createdMeta.deadline).toBeNull();
    expect(createdMeta.configSnapshot).toEqual(config);
    expect(turn).toMatchObject({ role: 'host', text: 'Main A1?', kind: 'main', themeId: 'ptr' });
  });

  describe('prompt version and models', () => {
    afterEach(() => { delete process.env.AGENT_PROMPT_VERSION; delete process.env.AGENT_CHECKER_MODEL_ID; delete process.env.AGENT_WRITER_MODEL_ID; });

    it("uses the assessment's promptVersion and, for host.v5, stores the checker and writer ids from the environment", async () => {
      process.env.AGENT_CHECKER_MODEL_ID = 'deepseek.v3.2';
      process.env.AGENT_WRITER_MODEL_ID = 'deepseek.v3.2';
      getMilestone.mockResolvedValue(milestone({ interview: { ...config, promptVersion: 'host.v5' } }));
      await start();
      expect(interviews.createInterview.mock.calls[0][0]).toMatchObject({
        promptVersion: 'host.v5', checkerModelId: 'deepseek.v3.2', writerModelId: 'deepseek.v3.2', isPractice: false,
      });
    });

    it('lets the assessment win over AGENT_PROMPT_VERSION, and falls back to the environment, then host.v3', async () => {
      process.env.AGENT_PROMPT_VERSION = 'host.v4.1';
      await start();
      expect(interviews.createInterview.mock.calls[0][0].promptVersion).toBe('host.v4.1');
      getMilestone.mockResolvedValue(milestone({ interview: { ...config, promptVersion: 'host.v2' } }));
      await start();
      expect(interviews.createInterview.mock.calls[1][0].promptVersion).toBe('host.v2');
      delete process.env.AGENT_PROMPT_VERSION;
      getMilestone.mockResolvedValue(milestone());
      await start();
      expect(interviews.createInterview.mock.calls[2][0].promptVersion).toBe('host.v3');
    });

    it('stores no checker or writer id for a version that does not use them', async () => {
      await start();
      const stored = interviews.createInterview.mock.calls[0][0];
      expect(stored).not.toHaveProperty('checkerModelId');
      expect(stored).not.toHaveProperty('writerModelId');
    });
  });

  it('requires a submissionId', async () => {
    await expect(start({ submissionId: undefined })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('404s on an unknown submission', async () => {
    getSubmission.mockResolvedValue(undefined);
    await expect(start()).rejects.toMatchObject({ statusCode: 404 });
  });

  it("403s when the submission belongs to someone else, without revealing anything else", async () => {
    getSubmission.mockResolvedValue(submission({ userId: 'someone-else' }));
    await expect(start()).rejects.toMatchObject({ statusCode: 403 });
    expect(getMilestone).not.toHaveBeenCalled();
    expect(interviews.createInterview).not.toHaveBeenCalled();
  });

  describe('one interview per submission', () => {
    it('409s when one already exists', async () => {
      interviews.getInterviewBySubmission.mockResolvedValue(meta());
      await expect(start()).rejects.toMatchObject({ statusCode: 409 });
      expect(interviews.createInterview).not.toHaveBeenCalled();
    });

    it('409s when a concurrent start wins the conditional write', async () => {
      const { AppError } = require('../utils/errors');
      interviews.createInterview.mockRejectedValue(new AppError('An interview already exists for this submission', 409));
      await expect(start()).rejects.toMatchObject({ statusCode: 409 });
    });

    it('derives the interview ID from the submission so the write is atomic', async () => {
      await start();
      expect(interviews.createInterview.mock.calls[0][0].interviewId).toBe('int_sub1');
    });
  });

  describe('eligibility', () => {
    it('refuses a submission whose session ended by leaving the page', async () => {
      getSubmission.mockResolvedValue(submission({ endedBy: 'left_page' }));
      await expect(start()).rejects.toMatchObject({ statusCode: 400 });
      expect(interviews.createInterview).not.toHaveBeenCalled();
    });

    it.each([
      ['a non-C++ submission', () => getSubmission.mockResolvedValue(submission({ language: 'python' }))],
      ['an embedded submission', () => getSubmission.mockResolvedValue(submission({ type: 'embedded', language: 'cpp' }))],
      ['an assessment that is not C++', () => getMilestone.mockResolvedValue(milestone({ language: 'python' }))],
      ['an embedded assessment', () => getMilestone.mockResolvedValue(milestone({ type: 'embedded' }))],
    ])('refuses %s', async (_name, arrange) => {
      arrange();
      await expect(start()).rejects.toMatchObject({ statusCode: 400 });
      expect(interviews.createInterview).not.toHaveBeenCalled();
    });

    it.each([
      ['no interview setup', milestone({ interview: undefined })],
      ['a disabled interview', milestone({ interview: { ...config, enabled: false } })],
    ])('refuses an assessment with %s', async (_name, m) => {
      getMilestone.mockResolvedValue(m);
      await expect(start()).rejects.toMatchObject({ statusCode: 400 });
    });

    it('still runs the interview for a grading_failed submission', async () => {
      getSubmission.mockResolvedValue(submission({ status: 'grading_failed' }));
      await expect(start()).resolves.toMatchObject({ interviewId: 'int_sub1' });
      expect(interviews.createInterview).toHaveBeenCalled();
    });

    it('does not depend on whether the code passed', async () => {
      getSubmission.mockResolvedValue(submission({ status: 'failed' }));
      await expect(start()).resolves.toBeDefined();
    });
  });

  it('never logs code, questions or criteria', async () => {
    await start();
    const logged = JSON.stringify(log.info.mock.calls);
    expect(logged).not.toContain(CRITERION);
    expect(logged).not.toContain('Main A1?');
    expect(logged).not.toContain(SECRET_CODE);
  });
});

describe('submitAnswer', () => {
  const answer = (over = {}) => submitAnswer({
    userId: 'u1', interviewId: 'int_sub1', answer: SECRET_ANSWER, now: NOW + 60000,
    clientTiming: { firstKeystrokeMs: 1200, pasteCount: 1, focusLossCount: 0 },
    converseFn: reply({ action: 'follow_up', question: 'Why line 12?', reason: 'vague' }),
    clock: () => 0, // no time passes, so the deadline does not move
    ...over,
  });

  it('stores the answer and the follow-up, and returns the question with the deadline', async () => {
    const result = await answer();
    expect(result).toEqual({ question: 'Why line 12?', deadline: meta().deadline, serverNow: expect.any(String) });

    const call = interviews.appendTurns.mock.calls[0][0];
    expect(call.expectedTurnCount).toBe(1);
    const [student, host] = call.turns;
    expect(student).toMatchObject({
      role: 'student', text: SECRET_ANSWER, themeId: 'ptr', kind: 'main',
      clientTiming: { firstKeystrokeMs: 1200, pasteCount: 1, focusLossCount: 0 },
    });
    expect(host).toMatchObject({
      role: 'host', text: 'Why line 12?', kind: 'follow_up', reason: 'vague',
      latencyMs: 30, inputTokens: 10, outputTokens: 5,
    });
    expect(call.metaUpdates).toMatchObject({ followUpCount: 1, fallbackCount: 0 });
  });

  it('sends the model the code from the submission and no identifiers', async () => {
    let seen;
    await answer({ converseFn: async (req) => { seen = req; return reply({ action: 'next_main', question: '', reason: '' })(); } });
    const sent = JSON.stringify(seen);
    expect(sent).toContain('secretVariableName');
    expect(sent).toContain(SECRET_ANSWER);
    for (const identifier of ['u1', 'sub1', 'int_sub1', 'm1']) {
      expect(sent).not.toContain(`"${identifier}"`);
    }
    expect(sent).not.toMatch(/@|userId|submissionId|interviewId/);
  });

  it('bounds and sanitises client timing', async () => {
    await answer({ clientTiming: { firstKeystrokeMs: 'soon', pasteCount: -3, focusLossCount: 2.9, junk: 1 } });
    expect(interviews.appendTurns.mock.calls[0][0].turns[0].clientTiming)
      .toEqual({ firstKeystrokeMs: null, pasteCount: null, focusLossCount: 2 });
  });

  it('moves to the next main question and ends the interview after the last one', async () => {
    interviews.getInterviewMeta.mockResolvedValue(meta({ mainIndex: 1, turnCount: 3 }));
    interviews.getInterviewTurns.mockResolvedValue([
      firstTurn, { role: 'student', text: 'a' }, { role: 'host', text: 'Main A2?', themeId: 'ptr', kind: 'main' },
    ]);
    const result = await answer({ converseFn: reply({ action: 'next_main', question: '', reason: 'done' }) });
    expect(result).toEqual({ ended: true, status: 'completed' });
    const call = interviews.appendTurns.mock.calls[0][0];
    expect(call.turns).toHaveLength(1);
    expect(call.metaUpdates).toMatchObject({ status: 'completed', endReason: 'completed' });
  });

  it('records on the META item why and how the Host ended the interview', async () => {
    // Main A2 is the last main question and its follow-up budget is used up.
    interviews.getInterviewMeta.mockResolvedValue(meta({ mainIndex: 1, followUpCount: 1, turnCount: 3 }));
    interviews.getInterviewTurns.mockResolvedValue([
      firstTurn, { role: 'student', text: 'a' }, { role: 'host', text: 'Main A2?', themeId: 'ptr', kind: 'main' },
    ]);
    const converseFn = jest.fn(reply({ action: 'follow_up', question: 'More?', reason: 'wants more' }));
    await answer({ converseFn });
    // Only one action was allowed, so the engine decided alone: the model was not asked.
    expect(converseFn).not.toHaveBeenCalled();
    expect(interviews.appendTurns.mock.calls[0][0].metaUpdates.endDetail).toEqual({
      reason: 'engine: no follow-up left and no main question remains; ended',
      engineDecision: true,
    });
  });

  it('passes the stored checker and writer ids to host.v5', async () => {
    const seen = [];
    const rubricConfig = { ...config, themes: [{ ...config.themes[0], rubric: [[{ id: 'r1', text: 'Shows delete is paired with new' }]] }] };
    interviews.getInterviewMeta.mockResolvedValue(meta({ promptVersion: 'host.v5', checkerModelId: 'chk', writerModelId: 'wrt', configSnapshot: rubricConfig }));
    await answer({
      converseFn: async (req) => {
        seen.push(req.modelId);
        return { text: JSON.stringify({ evidence: { r1: { quote: '', shown: false } }, missing: ['r1'] }), inputTokens: 1, outputTokens: 1, latencyMs: 1 };
      },
    });
    expect(seen[0]).toBe('chk');
    expect(seen).toContain('wrt');
  });

  it('keeps using the prompt version the interview started with', async () => {
    const seen = [];
    interviews.getInterviewMeta.mockResolvedValue(meta({ promptVersion: 'host.v1' }));
    await answer({ converseFn: async (req) => { seen.push(req.system); return reply({ action: 'next_main', question: '', reason: '' })(); } });
    expect(seen[0]).toBe(require('../agent/interview-engine').loadPrompt('host.v1'));
  });

  describe('validation and ownership', () => {
    it.each([[undefined], [''], ['   '], [42]])('rejects answer %p', async (value) => {
      await expect(answer({ answer: value })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects an over-long answer', async () => {
      await expect(answer({ answer: 'x'.repeat(2001) })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('404s on an unknown interview', async () => {
      interviews.getInterviewMeta.mockResolvedValue(null);
      await expect(answer()).rejects.toMatchObject({ statusCode: 404 });
    });

    it('403s for anyone but the owner, before any model call', async () => {
      const converseFn = jest.fn();
      await expect(answer({ userId: 'intruder', converseFn })).rejects.toMatchObject({ statusCode: 403 });
      expect(converseFn).not.toHaveBeenCalled();
      expect(interviews.appendTurns).not.toHaveBeenCalled();
    });

    it.each(['completed', 'timed_out', 'abandoned'])('409s when the interview is %s', async (status) => {
      interviews.getInterviewMeta.mockResolvedValue(meta({ status }));
      await expect(answer()).rejects.toMatchObject({ statusCode: 409 });
    });

    it('propagates a 409 when another request appended first', async () => {
      const { AppError } = require('../utils/errors');
      interviews.appendTurns.mockRejectedValue(new AppError('updated by another request', 409));
      await expect(answer()).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('deadline', () => {
    it('marks the interview timed_out and stores nothing when the deadline has passed', async () => {
      const converseFn = jest.fn();
      const result = await answer({ now: NOW + 10 * 60000 + 1, converseFn });
      expect(result).toEqual({ ended: true, status: 'timed_out' });
      expect(interviews.endInterview).toHaveBeenCalledWith('int_sub1', expect.objectContaining({ status: 'timed_out' }));
      expect(converseFn).not.toHaveBeenCalled();
      expect(interviews.appendTurns).not.toHaveBeenCalled();
    });

    it('still accepts an answer exactly at the deadline', async () => {
      const result = await answer({ now: NOW + 10 * 60000 });
      expect(result.question).toBeDefined();
    });
  });

  describe('time the agent works does not count', () => {
    /** A clock that reads 1000 when the work starts and 1000 + workMs when it ends. */
    const clockFor = (workMs) => {
      const readings = [1000, 1000 + workMs];
      return jest.fn(() => readings.shift());
    };
    const original = () => Date.parse(meta().deadline);

    it('adds exactly the time spent producing the next question to the deadline, and returns the new one', async () => {
      const result = await answer({ clock: clockFor(4321) });
      expect(Date.parse(result.deadline)).toBe(original() + 4321);
      const { metaUpdates } = interviews.appendTurns.mock.calls[0][0];
      expect(metaUpdates).toMatchObject({ deadline: result.deadline, extraTimeMs: 4321 });
    });

    it('counts a slow model call: the clock covers the model calls themselves', async () => {
      const converseFn = jest.fn(async () => ({ text: JSON.stringify({ action: 'next_main', question: '', reason: 'ok' }), inputTokens: 1, outputTokens: 1, latencyMs: 1 }));
      const clock = clockFor(9000);
      const result = await answer({ converseFn, clock });
      expect(converseFn).toHaveBeenCalled();
      expect(clock).toHaveBeenCalledTimes(2);
      expect(Date.parse(result.deadline)).toBe(original() + 9000);
    });

    it('adds up over several answers and keeps the running total on the interview', async () => {
      interviews.getInterviewMeta.mockResolvedValue(meta({ extraTimeMs: 1500, deadline: new Date(original() + 1500).toISOString() }));
      const result = await answer({ clock: clockFor(2500) });
      expect(Date.parse(result.deadline)).toBe(original() + 4000);
      expect(interviews.appendTurns.mock.calls[0][0].metaUpdates.extraTimeMs).toBe(4000);
    });

    it('extends the deadline when the model failed and the engine fell back, since the student still waited', async () => {
      const result = await answer({
        clock: clockFor(20000),
        converseFn: async () => { throw new ModelUnavailableError('ThrottlingException'); },
      });
      expect(result.question).toBe('Main A2?');
      expect(Date.parse(result.deadline)).toBe(original() + 20000);
    });

    it('gives no extension to an answer that arrives after the deadline', async () => {
      const clock = jest.fn(() => 0);
      const result = await answer({ now: NOW + 10 * 60000 + 1, clock });
      expect(result).toEqual({ ended: true, status: 'timed_out' });
      expect(clock).not.toHaveBeenCalled();
      expect(interviews.appendTurns).not.toHaveBeenCalled();
    });

    it('checks the incoming answer against the deadline as it stood before this answer', async () => {
      // Time was added earlier, so the stored deadline is later: an answer between the original and the new deadline is on time.
      interviews.getInterviewMeta.mockResolvedValue(meta({ extraTimeMs: 60000, deadline: new Date(original() + 60000).toISOString() }));
      const result = await answer({ now: NOW + 10 * 60000 + 30000, clock: clockFor(100) });
      expect(result.question).toBeDefined();
    });

    it('adds nothing when the answer ends the interview', async () => {
      interviews.getInterviewMeta.mockResolvedValue(meta({ themeIndex: 0, mainIndex: 1, followUpCount: 1, turnCount: 1 }));
      const result = await answer({ clock: clockFor(5000), converseFn: reply({ action: 'end', question: '', reason: 'done' }) });
      expect(result).toEqual({ ended: true, status: 'completed' });
      expect(interviews.appendTurns.mock.calls[0][0].metaUpdates).not.toHaveProperty('deadline');
    });

    it('never moves the deadline backwards', async () => {
      const result = await answer({ clock: jest.fn().mockReturnValueOnce(5000).mockReturnValueOnce(1000) });
      expect(Date.parse(result.deadline)).toBe(original());
    });
  });

  describe('Bedrock failures', () => {
    it('stores the answer and a fallback question when the model is unavailable', async () => {
      const result = await answer({ converseFn: async () => { throw new ModelUnavailableError('ThrottlingException'); } });
      expect(result.question).toBe('Main A2?');

      const call = interviews.appendTurns.mock.calls[0][0];
      expect(call.turns[0]).toMatchObject({ role: 'student', text: SECRET_ANSWER });
      expect(call.turns[1]).toMatchObject({
        role: 'host', text: 'Main A2?', kind: 'main',
        reason: 'fallback: model unavailable; asked the next main question', fallback: 'model_unavailable',
      });
      expect(call.metaUpdates.fallbackCount).toBe(1);
    });

    it('stores a distinct reason for invalid model output and counts it', async () => {
      interviews.getInterviewMeta.mockResolvedValue(meta({ fallbackCount: 1 }));
      await answer({ converseFn: async () => ({ text: 'not json', inputTokens: 7, outputTokens: 3, latencyMs: 20 }) });
      const call = interviews.appendTurns.mock.calls[0][0];
      expect(call.turns[1]).toMatchObject({
        text: 'Main A2?', reason: 'fallback: invalid model output; asked the next main question',
        fallback: 'invalid_output', inputTokens: 7,
      });
      expect(call.metaUpdates.fallbackCount).toBe(2);
    });

    it('does not count a normal turn as a fallback', async () => {
      await answer();
      expect(interviews.appendTurns.mock.calls[0][0].turns[1].fallback).toBeUndefined();
    });
  });

  describe('follow-up cap', () => {
    it('moves on instead of asking a second follow-up on the same main question', async () => {
      interviews.getInterviewMeta.mockResolvedValue(meta({ followUpCount: 1, turnCount: 3 }));
      interviews.getInterviewTurns.mockResolvedValue([
        firstTurn, { role: 'student', text: 'a' }, { role: 'host', text: 'f1', themeId: 'ptr', kind: 'follow_up' },
      ]);
      const converseFn = jest.fn(reply({ action: 'follow_up', question: 'A second?', reason: 'probe more' }));
      await answer({ converseFn });
      expect(converseFn).not.toHaveBeenCalled(); // the only allowed action is the next main question
      const call = interviews.appendTurns.mock.calls[0][0];
      expect(call.turns[1]).toMatchObject({
        text: 'Main A2?',
        kind: 'main',
        reason: 'engine: no follow-up left for this main question; asked the next main question',
        engineDecision: true,
      });
      expect(call.turns[1].modelReason).toBeUndefined();
      expect(call.turns[1].fallback).toBeUndefined();
      // The next main question has a fresh budget, and an override is not counted as a fallback.
      expect(call.metaUpdates).toMatchObject({ followUpCount: 0, mainIndex: 1, fallbackCount: 0 });
    });

    it('gives the next main question its own follow-up', async () => {
      interviews.getInterviewMeta.mockResolvedValue(meta({ mainIndex: 1, followUpCount: 0, turnCount: 3 }));
      interviews.getInterviewTurns.mockResolvedValue([
        firstTurn, { role: 'student', text: 'a' }, { role: 'host', text: 'Main A2?', themeId: 'ptr', kind: 'main' },
      ]);
      await answer();
      expect(interviews.appendTurns.mock.calls[0][0].turns[1]).toMatchObject({ kind: 'follow_up', text: 'Why line 12?' });
    });

    it('still honours a legacy per-theme limit in an interview that started with one', async () => {
      const legacy = { ...config, maxFollowUpsPerTheme: 2 };
      delete legacy.maxFollowUpsPerMainQuestion;
      interviews.getInterviewMeta.mockResolvedValue(meta({ configSnapshot: legacy, followUpCount: 1, turnCount: 3 }));
      interviews.getInterviewTurns.mockResolvedValue([
        firstTurn, { role: 'student', text: 'a' }, { role: 'host', text: 'f1', themeId: 'ptr', kind: 'follow_up' },
      ]);
      await answer();
      expect(interviews.appendTurns.mock.calls[0][0].turns[1]).toMatchObject({ kind: 'follow_up' });
    });
  });

  it('never logs answers, questions, code or criteria', async () => {
    await answer();
    await answer({ converseFn: async () => { throw new ModelUnavailableError('Timeout'); } });
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]);
    for (const secret of [SECRET_ANSWER, SECRET_CODE, 'secretVariableName', CRITERION, 'Why line 12?', 'Main A2?', 'vague']) {
      expect(logged).not.toContain(secret);
    }
    expect(logged).toContain('inputTokens');
  });
});

describe('getInterview', () => {
  const turns = [
    { sk: 'T#0001', ...{ role: 'host', text: 'Main A1?', themeId: 'ptr', kind: 'main', reason: 'first main question', createdAt: 't1', latencyMs: 5, inputTokens: 9, outputTokens: 2 } },
    { sk: 'T#0002', role: 'student', text: 'ans', themeId: 'ptr', kind: 'main', createdAt: 't2', clientTiming: { pasteCount: 1 } },
  ];
  beforeEach(() => interviews.getInterviewTurns.mockResolvedValue(turns));

  it("gives the owner their transcript without reasons, criteria, timing or tokens", async () => {
    const { interview } = await getInterview({ userId: 'u1', interviewId: 'int_sub1', isAdmin: false, now: NOW + 1000 });
    expect(interview.turns).toEqual([
      { role: 'host', text: 'Main A1?', createdAt: 't1' },
      { role: 'student', text: 'ans', createdAt: 't2' },
    ]);
    expect(interview.timeLeftMs).toBe(10 * 60000 - 1000);
    expect(interview.currentQuestion).toBe(null);
    const json = JSON.stringify(interview);
    for (const hidden of ['reason', CRITERION, 'criteria', 'configSnapshot', 'latencyMs', 'inputTokens', 'clientTiming', 'themeId', 'modelId', 'userId', 'fallback']) {
      expect(json).not.toContain(hidden);
    }
    expect(interview.status).toBe('in_progress');
  });

  it('never shows a student the model reason or the end detail', async () => {
    interviews.getInterviewMeta.mockResolvedValue(meta({ endDetail: { reason: 'r', modelReason: 'MODEL SAID' } }));
    interviews.getInterviewTurns.mockResolvedValue([{ ...turns[0], modelReason: 'MODEL SAID' }, turns[1]]);
    const { interview } = await getInterview({ userId: 'u1', interviewId: 'int_sub1', isAdmin: false, now: NOW + 1000 });
    expect(JSON.stringify(interview)).not.toContain('MODEL SAID');
    expect(JSON.stringify(interview)).not.toContain('endDetail');

    const admin = await getInterview({ userId: 'admin1', interviewId: 'int_sub1', isAdmin: true, now: NOW + 1000 });
    expect(admin.interview.turns[0].modelReason).toBe('MODEL SAID');
    expect(admin.interview.endDetail.modelReason).toBe('MODEL SAID');
  });

  it('gives admins everything', async () => {
    const { interview } = await getInterview({ userId: 'admin1', interviewId: 'int_sub1', isAdmin: true, now: NOW + 1000 });
    expect(interview.turns[0]).toMatchObject({ reason: 'first main question', latencyMs: 5, inputTokens: 9 });
    expect(interview.turns[1].clientTiming).toEqual({ pasteCount: 1 });
    expect(interview.mainQuestions[0].rubric).toEqual([{ id: 'r1', text: CRITERION }]);
    expect(interview.code).toBe(SECRET_CODE);
    expect(interview.sk).toBeUndefined();
    expect(interview.turns[0].sk).toBeUndefined();
  });

  it("403s when a student asks for someone else's interview", async () => {
    await expect(getInterview({ userId: 'u2', interviewId: 'int_sub1', isAdmin: false })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('404s on an unknown interview', async () => {
    interviews.getInterviewMeta.mockResolvedValue(null);
    await expect(getInterview({ userId: 'u1', interviewId: 'nope', isAdmin: false })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('reports timed_out once the deadline has passed', async () => {
    const { interview } = await getInterview({ userId: 'u1', interviewId: 'int_sub1', isAdmin: false, now: NOW + 11 * 60000 });
    expect(interview.status).toBe('timed_out');
    expect(interviews.endInterview).toHaveBeenCalled();
  });
});
