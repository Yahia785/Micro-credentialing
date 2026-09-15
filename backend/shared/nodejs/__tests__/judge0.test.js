const { parseJudge0Result, calculateMetrics, getLanguageId } = require('../utils/judge0');

describe('parseJudge0Result', () => {
  const baseTestCase = { testCaseId: 'tc1', input: '5\n', expectedOutput: '25\n', isHidden: false };

  it('correctly parses an accepted (status 3) result', () => {
    const judge0Result = {
      status: { id: 3, description: 'Accepted' },
      token: 'tok-1',
      stdout: '25\n',
      time: '0.012',
      memory: 1024,
      stderr: null,
      compile_output: null,
    };

    const result = parseJudge0Result(judge0Result, baseTestCase);

    expect(result).toEqual({
      testCaseId: 'tc1',
      judge0TokenId: 'tok-1',
      status: 'Accepted',
      passed: true,
      input: '5\n',
      expectedOutput: '25\n',
      actualOutput: '25\n',
      executionTime: 0.012,
      memory: 1024,
      isHidden: false,
      error: null,
    });
  });

  it('correctly parses a wrong answer (status 4) result', () => {
    const judge0Result = {
      status: { id: 4, description: 'Wrong Answer' },
      token: 'tok-2',
      stdout: '24\n',
      time: '0.010',
      memory: 900,
      stderr: null,
      compile_output: null,
    };

    const result = parseJudge0Result(judge0Result, baseTestCase);

    expect(result.passed).toBe(false);
    expect(result.status).toBe('Wrong Answer');
    expect(result.actualOutput).toBe('24\n');
    expect(result.error).toBeNull();
  });

  it('correctly parses a compile error (status 6) result', () => {
    const judge0Result = {
      status: { id: 6, description: 'Compilation Error' },
      token: 'tok-3',
      stdout: null,
      time: null,
      memory: null,
      stderr: null,
      compile_output: 'error: expected ; before }',
    };

    const result = parseJudge0Result(judge0Result, baseTestCase);

    expect(result.passed).toBe(false);
    expect(result.status).toBe('Compilation Error');
    expect(result.actualOutput).toBe('');
    expect(result.error).toBe('error: expected ; before }');
  });

  it('correctly parses a runtime error (status 11) result', () => {
    const judge0Result = {
      status: { id: 11, description: 'Runtime Error (NZEC)' },
      token: 'tok-4',
      stdout: '',
      time: '0.005',
      memory: 800,
      stderr: 'Segmentation fault',
      compile_output: null,
    };

    const result = parseJudge0Result(judge0Result, baseTestCase);

    expect(result.passed).toBe(false);
    expect(result.status).toBe('Runtime Error (NZEC)');
    expect(result.error).toBe('Segmentation fault');
  });

  it('handles null stdout/stderr gracefully', () => {
    const judge0Result = {
      status: { id: 3, description: 'Accepted' },
      token: 'tok-5',
      stdout: null,
      time: null,
      memory: null,
      stderr: null,
      compile_output: null,
    };

    const result = parseJudge0Result(judge0Result, baseTestCase);

    expect(result.actualOutput).toBe('');
    expect(result.executionTime).toBe(0);
    expect(result.memory).toBe(0);
    expect(result.error).toBeNull();
  });
});

describe('calculateMetrics', () => {
  it('calculates the correct passedTests count', () => {
    const results = [
      { passed: true, executionTime: 0.1, memory: 100 },
      { passed: false, executionTime: 0.2, memory: 200 },
      { passed: true, executionTime: 0.3, memory: 300 },
    ];

    expect(calculateMetrics(results).passedTests).toBe(2);
  });

  it('calculates the correct score percentage', () => {
    const results = [
      { passed: true, executionTime: 0.1, memory: 100 },
      { passed: true, executionTime: 0.1, memory: 100 },
      { passed: false, executionTime: 0.1, memory: 100 },
      { passed: false, executionTime: 0.1, memory: 100 },
    ];

    const metrics = calculateMetrics(results);
    expect(metrics.score).toBe(50);
    expect(metrics.status).toBe('failed');
  });

  it('calculates execution time metrics (total, avg, max)', () => {
    const results = [
      { passed: true, executionTime: 0.1, memory: 0 },
      { passed: true, executionTime: 0.2, memory: 0 },
      { passed: true, executionTime: 0.3, memory: 0 },
    ];

    const metrics = calculateMetrics(results);
    expect(metrics.totalExecutionTime).toBeCloseTo(0.6, 3);
    expect(metrics.averageExecutionTime).toBeCloseTo(0.2, 3);
    expect(metrics.maxExecutionTime).toBeCloseTo(0.3, 3);
    expect(metrics.status).toBe('passed');
  });

  it('calculates memory metrics (total, avg, max)', () => {
    const results = [
      { passed: true, executionTime: 0, memory: 100 },
      { passed: true, executionTime: 0, memory: 300 },
    ];

    const metrics = calculateMetrics(results);
    expect(metrics.totalMemory).toBe(400);
    expect(metrics.averageMemory).toBe(200);
    expect(metrics.maxMemory).toBe(300);
  });

  it('handles an empty results array', () => {
    // Documenting actual (edge-case) behavior of the real implementation:
    // 0/0 comparisons produce NaN/-Infinity rather than throwing.
    const metrics = calculateMetrics([]);

    expect(metrics.passedTests).toBe(0);
    expect(metrics.totalTests).toBe(0);
    expect(metrics.score).toBe(0);
    // passedTests (0) === totalTests (0) is true, so status is 'passed'
    expect(metrics.status).toBe('passed');
    expect(metrics.totalExecutionTime).toBe(0);
    expect(metrics.averageExecutionTime).toBeNaN();
    expect(metrics.maxExecutionTime).toBe(-Infinity);
    expect(metrics.totalMemory).toBe(0);
    expect(metrics.averageMemory).toBeNaN();
    expect(metrics.maxMemory).toBe(-Infinity);
  });
});

describe('getLanguageId', () => {
  it("returns the correct ID for 'python'", () => {
    expect(getLanguageId('python')).toBe(71);
  });

  it("returns the correct ID for 'c'", () => {
    expect(getLanguageId('c')).toBe(50);
  });

  it("returns the correct ID for 'cpp'", () => {
    expect(getLanguageId('cpp')).toBe(54);
  });

  it('throws for an unsupported language', () => {
    expect(() => getLanguageId('cobol')).toThrow('Unsupported language: cobol');
  });
});
