// The runner takes the time that is LEFT (a duration). The interview code holds an absolute deadline and must convert it at the moment of
// each call. Before the fix the absolute epoch time went straight to the runner, which set a timer of "now + 60 s" milliseconds: Node clamps
// that to 1 ms and every run was cut off ("TimeoutOverflowWarning: ... Timeout duration was set to 1").
const { runAllQuestions, remainingMs } = require('../services/interview-runs');

const NOW = Date.parse('2026-11-12T10:00:00Z');
const questions = [[{ label: 'a', stdin: '1' }]];
const run = (over = {}) => {
  const runBatch = jest.fn(async (list) => list.map(() => ({ status: 'accepted', stdout: 'x', timeMs: 1 })));
  return runAllQuestions({ code: 'int main(){}', questions, userId: 'u', interviewId: 'i', runBatch, countRun: async () => {}, ...over }).then((out) => ({ out, runBatch }));
};

describe('the deadline given to the runner is a duration, never an absolute time', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());

  it('remainingMs is deadline - now, never negative, null without a deadline', () => {
    expect(remainingMs(NOW + 60000)).toBe(60000);
    expect(remainingMs(NOW - 5000)).toBe(0);
    expect(remainingMs(null)).toBeNull();
  });

  it('the runner gets the time left (60 s), not the epoch time (about 1.8 trillion)', async () => {
    const { runBatch } = await run({ deadlineAt: NOW + 60000 });
    const { deadlineMs } = runBatch.mock.calls[0][1];
    expect(deadlineMs).toBe(60000);
    expect(deadlineMs).toBeLessThan(2 ** 31); // fits a timer
  });

  it('is worked out at the moment of the call: a deadline already past gives 0, not a negative number', async () => {
    const { runBatch } = await run({ deadlineAt: NOW - 1 });
    expect(runBatch.mock.calls[0][1].deadlineMs).toBe(0);
  });

  it('no deadline: null', async () => {
    const { runBatch } = await run();
    expect(runBatch.mock.calls[0][1].deadlineMs).toBeNull();
  });

  it('the prepare step passes an absolute time of its own through the same conversion', async () => {
    // through the service with the default budget (now + 100 s): the runner must see 100000, not NOW + 100000
    jest.resetModules();
    jest.doMock('../db/interviews', () => ({ getInterviewMeta: jest.fn(), finishPrepare: jest.fn().mockResolvedValue(true) }));
    jest.doMock('../db/submissions', () => ({ getSubmission: jest.fn().mockResolvedValue({ code: 'int main(){}', userId: 'u' }) }));
    jest.doMock('../db/milestones', () => ({ getMilestone: jest.fn() }));
    jest.doMock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const interviews = require('../db/interviews');
    const { prepareInterview } = require('../services/interview-service');
    interviews.getInterviewMeta.mockResolvedValue({
      interviewId: 'i', submissionId: 's', userId: 'u', milestoneId: 'm', status: 'in_progress', prepareStatus: 'preparing', promptVersion: 'host.v6',
      configSnapshot: { timeLimitMinutes: 10, themes: [{ id: 't', mainQuestions: ['Q?'], criteria: ['c'], runs: [[{ label: 'a', stdin: '1' }]] }] },
    });
    const runBatch = jest.fn(async (list) => list.map(() => ({ status: 'accepted', stdout: 'x', timeMs: 1 })));
    await prepareInterview({ interviewId: 'i', runBatch, countRun: async () => {} });
    expect(runBatch.mock.calls[0][1].deadlineMs).toBe(100000);
  });
});
