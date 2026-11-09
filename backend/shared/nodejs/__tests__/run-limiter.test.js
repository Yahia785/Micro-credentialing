// Usage limits for Run: 10 per minute and 150 per assessment per student, agent runs counted separately (30 per interview).
// The counter table is replaced by an in-memory fake that behaves like the real transaction: check and add 1 in one step,
// all counters or none.
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockStore = new Map();
const mockFail = { next: null };
jest.mock('../db/run-usage', () => ({
  incrementCounters: jest.fn(async counters => {
    if (mockFail.next) { const e = mockFail.next; mockFail.next = null; throw e; }
    // synchronous section: nothing can interleave between the check and the increment (like DynamoDB's conditional update)
    const full = counters.find(c => (mockStore.get(c.key) || 0) >= c.limit);
    if (full) return { ok: false, failedKey: full.key };
    counters.forEach(c => mockStore.set(c.key, (mockStore.get(c.key) || 0) + 1));
    return { ok: true };
  })
}));

const { incrementCounters } = require('../db/run-usage');
const { checkAndCountRun, checkAndCountAgentRun } = require('../services/run-limiter');
const { RateLimitError, ValidationError } = require('../utils/errors');

const T0 = Date.UTC(2026, 0, 1, 12, 0, 5);
const run = (userId = 'u1', assessmentId = 'a1', now = T0) => checkAndCountRun({ userId, assessmentId, now });

beforeEach(() => {
  mockStore.clear();
  mockFail.next = null;
  incrementCounters.mockClear();
  delete process.env.RUN_LIMIT_PER_MINUTE;
  delete process.env.RUN_LIMIT_PER_ASSESSMENT;
  delete process.env.RUN_LIMIT_AGENT_PER_INTERVIEW;
});

describe('per minute (default 10)', () => {
  it('allows 10 runs in a minute and refuses the 11th with 429 and a clear message', async () => {
    for (let i = 0; i < 10; i++) await run();
    const error = await run().catch(e => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.statusCode).toBe(429);
    expect(error.kind).toBe('minute');
    expect(error.message).toBe('Too many runs, please wait a minute');
  });

  it('a new minute starts a new count', async () => {
    for (let i = 0; i < 10; i++) await run();
    await expect(run('u1', 'a1', T0 + 60 * 1000)).resolves.toBeUndefined();
  });

  it('is per student: another student is not affected', async () => {
    for (let i = 0; i < 10; i++) await run('u1');
    await expect(run('u2')).resolves.toBeUndefined();
  });

  it('the per-minute counter carries a TTL (about two minutes after its minute), the assessment counter does not', async () => {
    await run();
    const counters = incrementCounters.mock.calls[0][0];
    const minute = counters.find(c => c.key.startsWith('minute#'));
    const assessment = counters.find(c => c.key.startsWith('run#'));
    expect(minute.expiresAt).toBe((Math.floor(T0 / 60000) + 2) * 60);
    expect(assessment.expiresAt).toBeUndefined();
  });

  it('is configurable with RUN_LIMIT_PER_MINUTE', async () => {
    process.env.RUN_LIMIT_PER_MINUTE = '2';
    await run(); await run();
    await expect(run()).rejects.toMatchObject({ kind: 'minute' });
  });
});

describe('per assessment (default 150)', () => {
  it('refuses run 151 for the same assessment with the assessment message, whatever the minute', async () => {
    for (let i = 0; i < 150; i++) await run('u1', 'a1', T0 + i * 60 * 1000); // one per minute, never near the minute limit
    const error = await run('u1', 'a1', T0 + 151 * 60 * 1000).catch(e => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.statusCode).toBe(429);
    expect(error.kind).toBe('assessment');
    expect(error.message).toBe("You've reached the run limit for this assessment");
  });

  it('is per assessment: another assessment of the same student still works', async () => {
    process.env.RUN_LIMIT_PER_ASSESSMENT = '3';
    for (let i = 0; i < 3; i++) await run('u1', 'a1', T0 + i * 60 * 1000);
    await expect(run('u1', 'a1', T0 + 4 * 60 * 1000)).rejects.toMatchObject({ kind: 'assessment' });
    await expect(run('u1', 'a2', T0 + 4 * 60 * 1000)).resolves.toBeUndefined();
  });

  it('a refused run is not counted in the other counter (all counters or none)', async () => {
    process.env.RUN_LIMIT_PER_MINUTE = '2';
    await run(); await run();
    await expect(run()).rejects.toMatchObject({ kind: 'minute' });
    expect(mockStore.get('run#u1#a1')).toBe(2);
  });
});

describe('the increment is atomic', () => {
  it('30 simultaneous runs against a limit of 10: exactly 10 are allowed', async () => {
    const results = await Promise.allSettled(Array.from({ length: 30 }, () => run()));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(10);
    expect(results.filter(r => r.status === 'rejected' && r.reason.statusCode === 429)).toHaveLength(20);
    expect(mockStore.get('run#u1#a1')).toBe(10);
  });

  it('each run is one call that changes every counter together (no separate read)', async () => {
    await run();
    expect(incrementCounters).toHaveBeenCalledTimes(1);
    expect(incrementCounters.mock.calls[0][0]).toHaveLength(2);
  });
});

describe('agent runs', () => {
  it('have their own counter per interview (default 30) and do not use the student run limits', async () => {
    for (let i = 0; i < 30; i++) await checkAndCountAgentRun({ userId: 'u1', interviewId: 'i1' });
    const error = await checkAndCountAgentRun({ userId: 'u1', interviewId: 'i1' }).catch(e => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.statusCode).toBe(429);
    expect(error.kind).toBe('agent');
    expect(error.message).toMatch(/agent run limit/);
    // the student's own Run budget is untouched, and another interview has its own counter
    await expect(run()).resolves.toBeUndefined();
    await expect(checkAndCountAgentRun({ userId: 'u1', interviewId: 'i2' })).resolves.toBeUndefined();
  });

  it('student runs do not use up the agent counter; it is configurable with RUN_LIMIT_AGENT_PER_INTERVIEW', async () => {
    process.env.RUN_LIMIT_AGENT_PER_INTERVIEW = '1';
    for (let i = 0; i < 10; i++) await run();
    await checkAndCountAgentRun({ userId: 'u1', interviewId: 'i1' });
    await expect(checkAndCountAgentRun({ userId: 'u1', interviewId: 'i1' })).rejects.toMatchObject({ kind: 'agent' });
  });
});

describe('robustness', () => {
  it('lets the run through (and logs the failure) when the counter table itself fails', async () => {
    mockFail.next = new Error('DynamoDB down');
    await expect(run()).resolves.toBeUndefined();
    expect(require('../utils/logger').error).toHaveBeenCalled();
  });

  it('requires ids', async () => {
    await expect(checkAndCountRun({ userId: '', assessmentId: 'a' })).rejects.toBeInstanceOf(ValidationError);
    await expect(checkAndCountRun({ userId: 'u' })).rejects.toBeInstanceOf(ValidationError);
    await expect(checkAndCountAgentRun({ userId: 'u' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('logs only counts and ids, never code', async () => {
    process.env.RUN_LIMIT_PER_MINUTE = '1';
    await run();
    await run().catch(() => {});
    const logged = JSON.stringify(require('../utils/logger').info.mock.calls);
    expect(logged).toContain('limit');
    expect(logged).not.toMatch(/source|code|stdin/i);
  });
});

describe('submissions are never blocked by the run limits', () => {
  it('grading does not go through the limiter at all, even when every limit is reached', async () => {
    jest.resetModules();
    jest.doMock('../services/run-limiter', () => ({
      checkAndCountRun: jest.fn(async () => { throw new RateLimitError('blocked', 'minute'); }),
      checkAndCountAgentRun: jest.fn(async () => { throw new RateLimitError('blocked', 'agent'); })
    }));
    jest.doMock('../db/submissions'); jest.doMock('../db/testcases'); jest.doMock('../db/milestones'); jest.doMock('../db/users');
    jest.doMock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../utils/codeRunner', () => ({
      getCodeRunnerName: () => 'own',
      runCppBatch: jest.fn(async () => [{ status: 'accepted', statusText: 'Accepted', stdout: '25\n', stderr: '', compileOutput: '', timeMs: 5, memoryKb: 9, runId: 'r', message: null }])
    }));
    const { getMilestone } = require('../db/milestones');
    const { getUser, addCompletedMilestone, updateUser } = require('../db/users');
    const { getTestCasesByMilestone } = require('../db/testcases');
    const { createSubmission, updateSubmission } = require('../db/submissions');
    getMilestone.mockResolvedValue({ milestoneId: 'm1', timeLimit: 3000, memoryLimit: 128000 });
    getUser.mockResolvedValue({ userId: 'u1', role: 'user', credentialsCount: 0 });
    getTestCasesByMilestone.mockResolvedValue([{ testCaseId: 'a', includeInJudge0: true, input: '5\n', expectedOutput: '25\n', isHidden: false }]);
    createSubmission.mockResolvedValue({});
    updateSubmission.mockImplementation(async (id, updates) => ({ submissionId: id, ...updates }));
    addCompletedMilestone.mockResolvedValue({});
    updateUser.mockResolvedValue({});

    const limiter = require('../services/run-limiter');
    const { processSubmission } = require('../services/submission-service');
    const result = await processSubmission({ userId: 'u1', milestoneId: 'm1', code: 'int main(){}', language: 'cpp' });
    expect(result.status).toBe('passed');
    expect(limiter.checkAndCountRun).not.toHaveBeenCalled();
    expect(limiter.checkAndCountAgentRun).not.toHaveBeenCalled();
  });
});
