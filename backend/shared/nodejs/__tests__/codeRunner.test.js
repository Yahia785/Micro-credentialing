jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/judge0', () => ({
  getLanguageId: jest.fn(() => 54),
  getJudge0Credentials: jest.fn(async () => ({ apiKey: 'mock-key', apiHost: 'mock-host' })),
  submitBatch: jest.fn(async () => [{ token: 'tok' }]),
  pollResults: jest.fn()
}));

const judge0 = require('../utils/judge0');
const { runCpp, runCppBatch } = require('../utils/codeRunner');

const opts = { source: 'int main(){}', stdin: '1', timeLimitMs: 2000, memoryLimitKb: 64000 };
const raw = (id, description, extra = {}) => ({
  token: 'tok', status: { id, description }, stdout: null, stderr: null, compile_output: null,
  time: '0.012', memory: 1024, ...extra
});
const SHAPE = ['status', 'stdout', 'stderr', 'compileOutput', 'timeMs', 'memoryKb'];

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.CODE_RUNNER;
});

describe('runCpp result shape', () => {
  const cases = [
    ['accepted', raw(3, 'Accepted', { stdout: '25\n' })],
    ['compile_error', raw(6, 'Compilation Error', { compile_output: 'error: x' })],
    ['runtime_error', raw(11, 'Runtime Error (SIGSEGV)', { stderr: 'segfault' })],
    ['time_limit', raw(5, 'Time Limit Exceeded', { time: '2.000' })],
    ['memory_limit', raw(11, 'Runtime Error (SIGSEGV)', { memory: 64000 })],
    ['internal_error', raw(13, 'Internal Error')],
    ['wrong_answer', raw(4, 'Wrong Answer', { stdout: '24\n' })]
  ];

  it.each(cases)('maps to %s with the fixed fields', async (status, result) => {
    judge0.pollResults.mockResolvedValueOnce([result]);
    const out = await runCpp(opts);
    expect(out.status).toBe(status);
    SHAPE.forEach(key => expect(out).toHaveProperty(key));
    expect(typeof out.stdout).toBe('string');
    expect(typeof out.timeMs).toBe('number');
  });

  it('converts values: seconds to ms, text fields default to empty strings', async () => {
    judge0.pollResults.mockResolvedValueOnce([raw(6, 'Compilation Error', { compile_output: 'bad', time: '0.003' })]);
    expect(await runCpp(opts)).toMatchObject({
      status: 'compile_error', stdout: '', stderr: '', compileOutput: 'bad', timeMs: 3, memoryKb: 1024
    });
  });

  it('sends the limits to Judge0 in its units (seconds, KB)', async () => {
    judge0.pollResults.mockResolvedValueOnce([raw(3, 'Accepted')]);
    await runCpp({ ...opts, expectedOutput: '25' });
    expect(judge0.submitBatch.mock.calls[0][0][0]).toMatchObject({
      source_code: 'int main(){}', stdin: '1', expected_output: '25', cpu_time_limit: 2, memory_limit: 64000, language_id: 54
    });
  });
});

describe('runCpp errors become internal_error and never throw', () => {
  it('Judge0 HTTP error', async () => {
    judge0.submitBatch.mockRejectedValueOnce(new Error('Judge0 API error: 429 - quota'));
    const out = await runCpp(opts);
    expect(out).toMatchObject({ status: 'internal_error', message: 'Judge0 API error: 429 - quota' });
    SHAPE.forEach(key => expect(out).toHaveProperty(key));
  });

  it('Judge0 polling timeout', async () => {
    judge0.pollResults.mockRejectedValueOnce(new Error('Judge0 polling stopped: approaching Lambda timeout.'));
    expect(await runCpp(opts)).toMatchObject({ status: 'internal_error', message: expect.stringContaining('Lambda timeout') });
  });

  it('credentials failure', async () => {
    judge0.getJudge0Credentials.mockRejectedValueOnce(new Error('secrets unavailable'));
    expect((await runCpp(opts)).status).toBe('internal_error');
  });
});

describe('provider switch', () => {
  it('defaults to judge0 and accepts CODE_RUNNER=judge0', async () => {
    judge0.pollResults.mockResolvedValue([raw(3, 'Accepted')]);
    expect((await runCpp(opts)).status).toBe('accepted');
    process.env.CODE_RUNNER = 'judge0';
    expect((await runCpp(opts)).status).toBe('accepted');
    expect(judge0.submitBatch).toHaveBeenCalledTimes(2);
  });

  it('an unknown provider is internal_error and Judge0 is not called', async () => {
    process.env.CODE_RUNNER = 'nope';
    expect(await runCpp(opts)).toMatchObject({ status: 'internal_error', message: 'Unknown code runner: nope' });
    expect(judge0.submitBatch).not.toHaveBeenCalled();
  });
});

describe('runCppBatch', () => {
  const runs = [opts, { ...opts, stdin: '2', expectedOutput: '4' }, { ...opts, stdin: '3' }];

  it('makes one submitBatch and one pollResults call and keeps the order', async () => {
    judge0.submitBatch.mockResolvedValueOnce([{ token: 't0' }, { token: 't1' }, { token: 't2' }]);
    judge0.pollResults.mockResolvedValueOnce([
      raw(3, 'Accepted', { token: 't0' }), raw(4, 'Wrong Answer', { token: 't1' }), raw(6, 'Compilation Error', { token: 't2' })
    ]);
    const out = await runCppBatch(runs, { deadlineMs: 9000 });

    expect(out.map(r => r.status)).toEqual(['accepted', 'wrong_answer', 'compile_error']);
    expect(out.map(r => r.runId)).toEqual(['t0', 't1', 't2']);
    expect(judge0.submitBatch).toHaveBeenCalledTimes(1);
    expect(judge0.submitBatch.mock.calls[0][0].map(s => s.stdin)).toEqual(['1', '2', '3']);
    expect(judge0.pollResults).toHaveBeenCalledTimes(1);
    expect(judge0.pollResults).toHaveBeenCalledWith(['t0', 't1', 't2'], 'mock-key', 'mock-host', 30, 1000, 9000);
  });

  it('a failed batch is internal_error for every run, never a throw', async () => {
    judge0.submitBatch.mockRejectedValueOnce(new Error('Judge0 API error: 429 - quota'));
    const out = await runCppBatch(runs);
    expect(out).toHaveLength(3);
    out.forEach(r => expect(r).toMatchObject({ status: 'internal_error', message: 'Judge0 API error: 429 - quota' }));
  });

  it('empty input and unknown provider', async () => {
    expect(await runCppBatch([])).toEqual([]);
    expect(judge0.submitBatch).not.toHaveBeenCalled();
    process.env.CODE_RUNNER = 'nope';
    expect((await runCppBatch(runs)).map(r => r.status)).toEqual(['internal_error', 'internal_error', 'internal_error']);
  });

  it('runCpp is a batch of one', async () => {
    judge0.pollResults.mockResolvedValueOnce([raw(3, 'Accepted')]);
    await runCpp({ ...opts, deadlineMs: 5000 });
    expect(judge0.pollResults).toHaveBeenCalledWith(['tok'], 'mock-key', 'mock-host', 30, 1000, 5000);
  });
});
