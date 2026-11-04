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
const { runCpp, runCppBatch: runBatchRaw } = require('../utils/codeRunner');
const { tenantIdFor } = require('../utils/codeRunnerOwn');
const crypto = require('crypto');

// Every grading call knows the student: the own runner needs the user id for its tenant id.
const runCppBatch = (runs, options) => runBatchRaw(runs, { userId: 'user-1', ...options });

const run = (extra = {}) => ({ source: 'int main(){}', stdin: '1', expectedOutput: '1', timeLimitMs: 2000, memoryLimitKb: 64000, userId: 'user-1', ...extra });
const result = (status, extra = {}) => ({
  status, statusText: status, stdout: '1', stderr: '', compileOutput: '', timeMs: 5, memoryKb: 900, runId: null, message: null, ...extra
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
    mockSend.mockResolvedValueOnce(reply([result('accepted', { stdout: '1' }), result('accepted', { stdout: '2' }), result('time_limit')]));
    const out = await runCppBatch([run({ stdin: 'a' }), run({ stdin: 'b' }), run({ stdin: 'c' })], { deadlineMs: 60000 });

    expect(out.map(r => r.status)).toEqual(['accepted', 'wrong_answer', 'time_limit']);
    expect(out[0]).toMatchObject({ stdout: '1', timeMs: 5, memoryKb: 900 });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const input = mockSend.mock.calls[0][0].input;
    expect(input).toMatchObject({ FunctionName: 'micro-credentialing-runner-dev', InvocationType: 'RequestResponse' });
    expect(JSON.parse(input.Payload)).toEqual({
      source: 'int main(){}',
      runs: [{ stdin: 'a' }, { stdin: 'b' }, { stdin: 'c' }], // the expected output is never sent
      timeLimitMs: 2000,
      memoryLimitKb: 64000
    });
  });

  it('keeps the fixed result shape for every status', async () => {
    // The runner answers accepted for a program that ran fine; the stdout '9' does not match the expected '1'.
    const statuses = ['accepted', 'wrong_answer', 'compile_error', 'runtime_error', 'time_limit', 'memory_limit', 'internal_error'];
    const fromRunner = ['accepted', 'accepted', 'compile_error', 'runtime_error', 'time_limit', 'memory_limit', 'internal_error'];
    mockSend.mockResolvedValueOnce(reply(fromRunner.map((s, i) => result(s, {
      compileOutput: s === 'compile_error' ? 'bad' : '', stdout: i === 1 ? '9' : '1'
    }))));
    const out = await runCppBatch(statuses.map(() => run()));
    out.forEach((r, i) => {
      expect(r.status).toBe(statuses[i]);
      ['stdout', 'stderr', 'compileOutput', 'timeMs', 'memoryKb'].forEach(key => expect(r).toHaveProperty(key));
    });
    expect(out[2].compileOutput).toBe('bad');
  });

  describe('the expected output stays out of the runner and the verdict is decided here', () => {
    const only = async (runnerResult, runExtra) => {
      mockSend.mockResolvedValueOnce(reply([runnerResult]));
      return (await runCppBatch([run(runExtra)]))[0];
    };

    it('the payload never contains expectedOutput, even when every run has one', async () => {
      mockSend.mockResolvedValueOnce(reply([result('accepted', { stdout: '1' }), result('accepted', { stdout: '1' })]));
      await runCppBatch([run({ expectedOutput: 'secret-answer-1' }), run({ stdin: '2', expectedOutput: 'secret-answer-2' })]);
      const payload = mockSend.mock.calls[0][0].input.Payload;
      expect(payload).not.toContain('expectedOutput');
      expect(payload).not.toContain('secret-answer');
    });

    it('accepted + matching output (Judge0 rules: trailing whitespace and blank lines ignored) stays accepted', async () => {
      const out = await only(result('accepted', { stdout: '1  \r\n\n', statusText: null }), { expectedOutput: '1' });
      expect(out).toMatchObject({ status: 'accepted', statusText: 'Accepted' });
      expect(out).not.toHaveProperty('stdoutInvalidUtf8');
    });

    it('accepted + different output becomes wrong_answer with Judge0 wording', async () => {
      const out = await only(result('accepted', { stdout: '2' }), { expectedOutput: '1' });
      expect(out).toMatchObject({ status: 'wrong_answer', statusText: 'Wrong Answer', stdout: '2' });
    });

    it('leading whitespace, case and inner blank lines still count', async () => {
      expect((await only(result('accepted', { stdout: ' x' }), { expectedOutput: 'x' })).status).toBe('wrong_answer');
      expect((await only(result('accepted', { stdout: 'Yes' }), { expectedOutput: 'yes' })).status).toBe('wrong_answer');
      expect((await only(result('accepted', { stdout: 'a\n\nb' }), { expectedOutput: 'a\nb' })).status).toBe('wrong_answer');
    });

    it('no expected output (undefined, null or empty) is accepted whatever the program printed', async () => {
      for (const expectedOutput of [undefined, null, '']) {
        expect((await only(result('accepted', { stdout: 'anything' }), { expectedOutput })).status).toBe('accepted');
      }
    });

    it('empty stdout only matches when there is no expected output', async () => {
      expect((await only(result('accepted', { stdout: '' }), { expectedOutput: 'x' })).status).toBe('wrong_answer');
      expect((await only(result('accepted', { stdout: '' }), { expectedOutput: undefined })).status).toBe('accepted');
    });

    it('output that is not valid UTF-8 never matches a text answer', async () => {
      const bad = result('accepted', { stdout: '\ufffd\ufffd\n', stdoutInvalidUtf8: true });
      expect((await only(bad, { expectedOutput: '\ufffd\ufffd' })).status).toBe('wrong_answer');
      expect((await only(bad, { expectedOutput: undefined })).status).toBe('accepted');
    });

    it('other statuses are never turned into wrong_answer, whatever the output', async () => {
      for (const status of ['compile_error', 'runtime_error', 'time_limit', 'memory_limit', 'internal_error']) {
        expect((await only(result(status, { stdout: 'zzz' }), { expectedOutput: '1' })).status).toBe(status);
      }
    });

    it('runs that share a group are judged against their own expected output', async () => {
      mockSend.mockResolvedValueOnce(reply([result('accepted', { stdout: 'A' }), result('accepted', { stdout: 'A' })]));
      const out = await runCppBatch([run({ expectedOutput: 'A' }), run({ stdin: '2', expectedOutput: 'B' })]);
      expect(out.map(r => r.status)).toEqual(['accepted', 'wrong_answer']);
    });
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

describe('tenant isolation: every invocation carries a hash of the user id', () => {
  const hash = id => crypto.createHash('sha256').update(id).digest('hex');
  const okReply = () => reply([result('accepted')]);

  afterEach(() => { delete process.env.CODE_RUNNER_TENANT_ISOLATION; });

  it('sends TenantId = SHA-256(user id) as 64 lowercase hex characters', async () => {
    mockSend.mockResolvedValueOnce(okReply());
    await runCppBatch([run()], { userId: 'student-42' });
    const input = mockSend.mock.calls[0][0].input;
    expect(input.TenantId).toBe(hash('student-42'));
    expect(input.TenantId).toMatch(/^[0-9a-f]{64}$/);
    expect(tenantIdFor('student-42')).toBe(hash('student-42'));
  });

  it('never sends the raw user id, neither as tenant id nor in the payload', async () => {
    mockSend.mockResolvedValueOnce(okReply());
    await runCppBatch([run()], { userId: 'student-42-raw' });
    const input = mockSend.mock.calls[0][0].input;
    expect(JSON.stringify(input)).not.toContain('student-42-raw');
  });

  it('the same user always gets the same tenant id, different users get different ones', async () => {
    mockSend.mockResolvedValue(okReply());
    await runCppBatch([run()], { userId: 'a' });
    await runCppBatch([run()], { userId: 'a' });
    await runCppBatch([run()], { userId: 'b' });
    const ids = mockSend.mock.calls.map(call => call[0].input.TenantId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).not.toBe(ids[2]);
  });

  it('numeric user ids are hashed as their string form', async () => {
    mockSend.mockResolvedValueOnce(okReply());
    await runCppBatch([run()], { userId: 12345 });
    expect(mockSend.mock.calls[0][0].input.TenantId).toBe(hash('12345'));
  });

  it('runCpp forwards the user id too', async () => {
    mockSend.mockResolvedValueOnce(okReply());
    await runCpp(run({ userId: 'solo' }));
    expect(mockSend.mock.calls[0][0].input.TenantId).toBe(hash('solo'));
  });

  it('all groups of one batch use the same tenant id', async () => {
    mockSend.mockResolvedValue(okReply());
    await runCppBatch([run(), run({ source: 'other' })], { userId: 'g' });
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(new Set(mockSend.mock.calls.map(call => call[0].input.TenantId)).size).toBe(1);
  });

  it.each([undefined, null, ''])('refuses a call without a user id (%p): nothing is invoked, the result is internal_error', async userId => {
    const out = await runBatchRaw([run()], { userId });
    expect(mockSend).not.toHaveBeenCalled();
    expect(out[0]).toMatchObject({ status: 'internal_error', message: expect.stringContaining('user id') });
  });

  it('CODE_RUNNER_TENANT_ISOLATION=off (fallback deployment) sends no tenant id and needs no user id', async () => {
    process.env.CODE_RUNNER_TENANT_ISOLATION = 'off';
    mockSend.mockResolvedValueOnce(okReply());
    const out = await runBatchRaw([run()], {});
    expect(out[0].status).toBe('accepted');
    expect(mockSend.mock.calls[0][0].input).not.toHaveProperty('TenantId');
  });

  it('the Judge0 provider ignores the user id', async () => {
    process.env.CODE_RUNNER = 'judge0';
    judge0.submitBatch.mockResolvedValueOnce([{ token: 't' }]);
    judge0.pollResults.mockResolvedValueOnce([{ token: 't', status: { id: 3, description: 'Accepted' }, stdout: '1', time: '0.01', memory: 100 }]);
    await runCppBatch([run()], { userId: 'someone' });
    expect(mockSend).not.toHaveBeenCalled();
    expect(JSON.stringify(judge0.submitBatch.mock.calls)).not.toContain('someone');
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
