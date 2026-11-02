jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/judge0', () => ({
  getLanguageId: jest.fn(() => 54),
  getJudge0Credentials: jest.fn(async () => ({ apiKey: 'mock-key', apiHost: 'mock-host' })),
  submitBatch: jest.fn(),
  pollResults: jest.fn()
}));

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: mockSend })),
  InvokeCommand: jest.fn(function InvokeCommand(input) { this.input = input; })
}));

const judge0 = require('../utils/judge0');
const { runCpp, runCppBatch } = require('../utils/codeRunner');

const run = (extra = {}) => ({ source: 'int main(){}', stdin: '1', expectedOutput: '1', timeLimitMs: 2000, memoryLimitKb: 64000, ...extra });
const result = (status, extra = {}) => ({
  status, statusText: status, stdout: '', stderr: '', compileOutput: '', timeMs: 5, memoryKb: 900, runId: null, message: null, ...extra
});
const reply = (results, extra = {}) => ({ Payload: Buffer.from(JSON.stringify({ results })), ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockReset();
  process.env.CODE_RUNNER = 'own';
  process.env.CODE_RUNNER_FUNCTION = 'micro-credentialing-runner-dev';
});
afterEach(() => {
  delete process.env.CODE_RUNNER;
  delete process.env.CODE_RUNNER_FUNCTION;
});

describe('own provider', () => {
  it('sends one invocation with the runner payload and returns results in order', async () => {
    mockSend.mockResolvedValueOnce(reply([result('accepted', { stdout: 'a' }), result('wrong_answer'), result('time_limit')]));
    const out = await runCppBatch([run({ stdin: 'a' }), run({ stdin: 'b' }), run({ stdin: 'c' })], { deadlineMs: 60000 });

    expect(out.map(r => r.status)).toEqual(['accepted', 'wrong_answer', 'time_limit']);
    expect(out[0]).toMatchObject({ stdout: 'a', timeMs: 5, memoryKb: 900 });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const input = mockSend.mock.calls[0][0].input;
    expect(input).toMatchObject({ FunctionName: 'micro-credentialing-runner-dev', InvocationType: 'RequestResponse' });
    expect(JSON.parse(input.Payload)).toEqual({
      source: 'int main(){}',
      runs: [{ stdin: 'a', expectedOutput: '1' }, { stdin: 'b', expectedOutput: '1' }, { stdin: 'c', expectedOutput: '1' }],
      timeLimitMs: 2000,
      memoryLimitKb: 64000
    });
  });

  it('keeps the fixed result shape for every status', async () => {
    const statuses = ['accepted', 'wrong_answer', 'compile_error', 'runtime_error', 'time_limit', 'memory_limit', 'internal_error'];
    mockSend.mockResolvedValueOnce(reply(statuses.map(s => result(s, { compileOutput: s === 'compile_error' ? 'bad' : '' }))));
    const out = await runCppBatch(statuses.map(() => run()));
    out.forEach((r, i) => {
      expect(r.status).toBe(statuses[i]);
      ['stdout', 'stderr', 'compileOutput', 'timeMs', 'memoryKb'].forEach(key => expect(r).toHaveProperty(key));
    });
    expect(out[2].compileOutput).toBe('bad');
  });

  it('runs with different source or limits go out as separate invocations, results stay in order', async () => {
    mockSend
      .mockResolvedValueOnce(reply([result('accepted'), result('accepted')]))
      .mockResolvedValueOnce(reply([result('compile_error')]));
    const out = await runCppBatch([run(), run({ source: 'other' }), run({ stdin: '2' })]);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(out.map(r => r.status)).toEqual(['accepted', 'compile_error', 'accepted']);
  });

  it('runCpp works through the same provider', async () => {
    mockSend.mockResolvedValueOnce(reply([result('accepted')]));
    expect((await runCpp(run())).status).toBe('accepted');
  });

  it('never calls Judge0', async () => {
    mockSend.mockResolvedValueOnce(reply([result('accepted')]));
    await runCpp(run());
    expect(judge0.submitBatch).not.toHaveBeenCalled();
    expect(judge0.pollResults).not.toHaveBeenCalled();
    expect(judge0.getJudge0Credentials).not.toHaveBeenCalled();
  });
});

describe('own provider errors become internal_error', () => {
  const expectInternal = (out, text) => {
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: 'internal_error', message: expect.stringContaining(text), stdout: '', timeMs: 0 });
  };

  it('Lambda invoke fails (throttle, network)', async () => {
    mockSend.mockRejectedValueOnce(new Error('TooManyRequestsException'));
    expectInternal(await runCppBatch([run()]), 'TooManyRequestsException');
  });

  it('the runner function itself errors', async () => {
    mockSend.mockResolvedValueOnce({ FunctionError: 'Unhandled', Payload: Buffer.from('{"errorType":"Runtime.ExitError"}') });
    expectInternal(await runCppBatch([run()]), 'Code runner function error: Unhandled');
  });

  it('the runner rejects the input', async () => {
    mockSend.mockResolvedValueOnce({ Payload: Buffer.from(JSON.stringify({ results: [], error: 'source is too large' })) });
    expectInternal(await runCppBatch([run()]), 'source is too large');
  });

  it('wrong number of results', async () => {
    mockSend.mockResolvedValueOnce(reply([result('accepted'), result('accepted')]));
    expectInternal(await runCppBatch([run()]), 'unexpected number of results');
  });

  it('missing CODE_RUNNER_FUNCTION', async () => {
    delete process.env.CODE_RUNNER_FUNCTION;
    expectInternal(await runCppBatch([run()]), 'CODE_RUNNER_FUNCTION is not set');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('too little time left: nothing is invoked and the message keeps the "Lambda timeout" wording grading looks for', async () => {
    expectInternal(await runCppBatch([run()], { deadlineMs: 3000 }), 'Lambda timeout');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('the deadline passes while waiting: the call is aborted as a timeout', async () => {
    jest.useFakeTimers();
    mockSend.mockImplementationOnce((cmd, { abortSignal }) => new Promise((resolve, reject) => {
      abortSignal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const pending = runCppBatch([run()], { deadlineMs: 5100 });
    await jest.advanceTimersByTimeAsync(200);
    expectInternal(await pending, 'Lambda timeout');
    jest.useRealTimers();
  });
});

describe('provider switch', () => {
  it('the default stays judge0', async () => {
    delete process.env.CODE_RUNNER;
    judge0.submitBatch.mockResolvedValueOnce([{ token: 't' }]);
    judge0.pollResults.mockResolvedValueOnce([{ token: 't', status: { id: 3, description: 'Accepted' }, stdout: 'x', time: '0.01', memory: 100 }]);
    expect((await runCpp(run())).status).toBe('accepted');
    expect(judge0.submitBatch).toHaveBeenCalledTimes(1);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('CODE_RUNNER=judge0 still selects judge0', async () => {
    process.env.CODE_RUNNER = 'judge0';
    judge0.submitBatch.mockResolvedValueOnce([{ token: 't' }]);
    judge0.pollResults.mockResolvedValueOnce([{ token: 't', status: { id: 3, description: 'Accepted' }, time: '0.01', memory: 100 }]);
    await runCpp(run());
    expect(mockSend).not.toHaveBeenCalled();
  });
});
