const { runAllQuestions } = require('../services/interview-runs');
const { MARKER } = require('../services/harness-builder');
const engine = require('../agent/interview-engine');

const HEADER = '#include <vector>\nusing namespace std;\nint f(int x);\n';
const DRIVER = '#include "functions.h"\nint main() { return 0; }\n';
const harness = { header: HEADER, driver: DRIVER };
const CODE = '#include "functions.h"\nint f(int x) {\n    int y = x;\n    return y;\n}\n';

const ok = (over = {}) => ({ status: 'accepted', stdout: '3\n', stderr: '', compileOutput: '', timeMs: 5, ...over });
const plain = (stdin = 'a') => ({ label: stdin, stdin, program: { kind: 'plain' } });
const trace = (over = {}) => ({ label: 'trace', stdin: 'a', program: { kind: 'trace', pauseLine: 3, variables: ['y'], ...over } });
const whatIf = (over = {}) => ({ label: 'whatIf', stdin: 'a', program: { kind: 'whatIf', line: 3, find: 'x', replace: '7', ...over } });

const run = (questions, runBatch, over = {}) => {
  const counted = [];
  return runAllQuestions({
    code: CODE, questions, userId: 'u', interviewId: 'i', runBatch, harness, countRun: async () => { counted.push(1); }, ...over,
  }).then((out) => ({ out, counted: counted.length }));
};

describe('runAllQuestions with program specs', () => {
  test('without a program the submission code is sent as it is (the default is unchanged)', async () => {
    const runBatch = jest.fn(async (runs) => runs.map(() => ok()));
    const { out } = await run([[{ label: 'x', stdin: 'a' }]], runBatch);
    expect(runBatch.mock.calls[0][0][0].source).toBe(CODE);
    expect(out).toEqual([{ runs: [{ label: 'x', stdin: 'a', stdout: '3\n', status: 'accepted', timeMs: 5 }], note: null }]);
  });

  test('each program kind runs its own copy; runs that share a source are the same source string', async () => {
    const runBatch = jest.fn(async (runs) => runs.map((r) => ok({ stderr: r.source.includes('harness_trace::emit(') ? `${MARKER}\t1\ty=5\n${MARKER}\t2\ty=6\n` : '' })));
    const { out, counted } = await run([[plain('a'), plain('b')], [trace()], [whatIf()]], runBatch);
    const sent = runBatch.mock.calls[0][0];
    expect(sent).toHaveLength(4);
    expect(sent[0].source).toBe(sent[1].source); // plain + plain: one runner call
    expect(sent[2].source).toContain('harness_trace::emit("y", (y));');
    expect(sent[3].source).toContain('int y = 7;');
    expect(new Set(sent.map((r) => r.source)).size).toBe(3);
    expect(counted).toBe(4);
    expect(out[0].runs.map((r) => r.kind)).toEqual(['plain', 'plain']);
    expect(out[1].runs[0].trace).toEqual({ total: 2, stops: [expect.objectContaining({ stop: 1, text: 'y=5' }), expect.objectContaining({ stop: 2, text: 'y=6' })] });
    expect(out[2].runs[0]).toEqual(expect.objectContaining({ kind: 'whatIf', status: 'accepted' }));
    expect(out.every((q) => !q.errors)).toBe(true);
  });

  test('a copy that cannot be built is a system error for that question only, is never run and is not counted', async () => {
    const runBatch = jest.fn(async (runs) => runs.map(() => ok()));
    const { out, counted } = await run([[trace({ pauseLine: 1 })], [whatIf({ find: 'nothing' })], [plain()]], runBatch);
    expect(runBatch.mock.calls[0][0]).toHaveLength(1);
    expect(counted).toBe(1);
    expect(out[0].errors).toEqual([{ label: 'trace', kind: 'trace', stage: 'build', reason: 'line 1 is blank' }]);
    expect(out[1].errors).toEqual([{ label: 'whatIf', kind: 'whatIf', stage: 'build', reason: 'the text to change is not on line 3' }]);
    expect(out[2].runs).toHaveLength(1);
    expect(out[2].errors).toBeUndefined();
  });

  test('a compile error, a time limit or a crash of a trace or what-if copy is a system error for that question only', async () => {
    const results = [ok(), ok({ status: 'compile_error', stdout: '', compileOutput: 'harness_trace::put no matching function' }), ok({ status: 'time_limit' }), ok({ status: 'runtime_error' })];
    const runBatch = jest.fn(async () => results);
    const { out } = await run([[plain()], [trace()], [whatIf()], [whatIf({ replace: '8' })]], runBatch);
    expect(out[0].runs).toHaveLength(1);
    expect(out[1].errors).toEqual([{ label: 'trace', kind: 'trace', stage: 'compile', reason: 'trace: unsupported variable type' }]);
    expect(out[2].errors).toEqual([{ label: 'whatIf', kind: 'whatIf', stage: 'run', reason: 'time_limit' }]);
    expect(out[3].errors).toEqual([{ label: 'whatIf', kind: 'whatIf', stage: 'run', reason: 'runtime_error' }]);
    expect(out[1].note).toBeNull(); // a trace compile error is not the student's compile error
  });

  test('a trace copy that does not compile for another reason says so, without compiler text', async () => {
    const runBatch = jest.fn(async () => [ok({ status: 'compile_error', compileOutput: "functions.cpp:3:5: error: 'secret' was not declared" })]);
    const { out } = await run([[trace()]], runBatch);
    expect(out[0].errors[0].reason).toBe('trace copy did not compile');
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  test('a plain run that does not compile keeps the existing note', async () => {
    const runBatch = jest.fn(async () => [ok({ status: 'compile_error', stdout: '' })]);
    const { out } = await run([[plain()]], runBatch);
    expect(out[0].note).toBe('compile_error');
    expect(out[0].errors).toBeUndefined();
  });

  test('trace stdout that differs from the plain run is "instrumentation changed behavior"', async () => {
    const runBatch = jest.fn(async () => [ok({ stdout: 'changed\n', stderr: `${MARKER}\t1\ty=5\n` })]);
    const { out } = await run([[trace({ expectStdout: '3\n' })]], runBatch);
    expect(out[0].errors).toEqual([{ label: 'trace', kind: 'trace', stage: 'check', reason: 'instrumentation changed behavior' }]);
    expect(out[0].runs[0].trace.rejected).toBe(true);
    const same = await run([[trace({ expectStdout: '3\n' })]], async () => [ok({ stderr: `${MARKER}\t1\ty=5\n` })]);
    expect(same.out[0].errors).toBeUndefined();
  });

  test('a trace that never stops is still a result (total 0): the caller decides', async () => {
    const { out } = await run([[trace()]], async () => [ok()]);
    expect(out[0].runs[0].trace).toEqual({ total: 0, stops: [] });
  });

  test('one internal error fails only its own question when programs are used', async () => {
    const runBatch = jest.fn(async () => [ok(), { status: 'internal_error', message: 'Output too large for one response' }]);
    const { out } = await run([[plain()], [whatIf()]], runBatch);
    expect(out[0].runs).toHaveLength(1);
    expect(out[0].errors).toBeUndefined();
    expect(out[1].runs).toHaveLength(0);
    expect(out[1].errors).toEqual([{ label: 'whatIf', kind: 'whatIf', stage: 'runner', reason: expect.stringContaining('Output too large') }]);
  });

  test('a wholly failed batch still fails every question, with the existing note', async () => {
    const { out } = await run([[plain()], [whatIf()]], async () => { throw new Error('boom'); });
    expect(out[0].note).toContain('runner_failed');
    expect(out[1].note).toContain('runner_failed');
  });

  test('programs without a harness, or of an unknown kind, are system errors', async () => {
    const runBatch = jest.fn(async (runs) => runs.map(() => ok()));
    const a = await run([[plain()], [{ label: 'x', stdin: 'a', program: { kind: 'magic' } }]], runBatch, { harness: null });
    expect(a.out[0].errors[0].reason).toContain('no harness');
    const b = await run([[{ label: 'x', stdin: 'a', program: { kind: 'magic' } }, { label: 'y', stdin: 'a' }]], runBatch);
    expect(b.out[0].errors[0].reason).toBe('unknown program kind "magic"');
    expect(b.out[0].runs).toHaveLength(1); // the default run next to it still ran
  });

  test('the run limit still applies: runs after the first refusal are skipped, in order', async () => {
    let n = 0;
    const countRun = async () => { n += 1; if (n > 2) { const { RateLimitError } = require('../utils/errors'); throw new RateLimitError('limit'); } };
    const runBatch = jest.fn(async (runs) => runs.map(() => ok()));
    const { out } = await run([[plain('a'), plain('b')], [plain('c')]], runBatch, { countRun });
    expect(runBatch.mock.calls[0][0]).toHaveLength(2);
    expect(out[1].note).toBe('limit_reached');
  });
});

describe('runsAt keeps a program', () => {
  const config = { themes: [{ runs: [[{ label: 'a', stdin: 'x', program: { kind: 'trace', pauseLine: 3, variables: ['y'] } }, { label: 'b', stdin: 'y' }]] }] };
  test('passes the program on and leaves runs without one as they were', () => {
    expect(engine.runsAt(config, { themeIndex: 0, mainIndex: 0 })).toEqual([
      { label: 'a', stdin: 'x', program: { kind: 'trace', pauseLine: 3, variables: ['y'] } },
      { label: 'b', stdin: 'y' },
    ]);
  });
  test('ignores a program that is not a plain object', () => {
    const bad = { themes: [{ runs: [[{ label: 'a', stdin: 'x', program: 'trace' }, { label: 'b', stdin: 'y', program: ['x'] }]] }] };
    expect(engine.runsAt(bad, { themeIndex: 0, mainIndex: 0 })).toEqual([{ label: 'a', stdin: 'x' }, { label: 'b', stdin: 'y' }]);
  });
});
