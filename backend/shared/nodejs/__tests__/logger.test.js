const log = require('../utils/logger');

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation();
  jest.spyOn(console, 'error').mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

function parseLastCall(mockFn) {
  const raw = mockFn.mock.calls[mockFn.mock.calls.length - 1][0];
  return JSON.parse(raw);
}

describe('logger', () => {
  it('log.info calls console.log with JSON containing level INFO', () => {
    log.info('Something happened');

    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
    const entry = parseLastCall(console.log);
    expect(entry.level).toBe('INFO');
    expect(entry.message).toBe('Something happened');
  });

  it('log.error calls console.error with JSON containing level ERROR', () => {
    log.error('Something broke');

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalled();
    const entry = parseLastCall(console.error);
    expect(entry.level).toBe('ERROR');
    expect(entry.message).toBe('Something broke');
  });

  it('log.warn calls console.error with JSON containing level WARN', () => {
    log.warn('Careful now');

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalled();
    const entry = parseLastCall(console.error);
    expect(entry.level).toBe('WARN');
    expect(entry.message).toBe('Careful now');
  });

  it('includes a timestamp on every log entry', () => {
    log.info('with timestamp');
    log.warn('with timestamp');
    log.error('with timestamp');

    const infoEntry = parseLastCall(console.log);
    expect(infoEntry.timestamp).toEqual(expect.any(String));
    expect(new Date(infoEntry.timestamp).toString()).not.toBe('Invalid Date');

    const errorEntry = parseLastCall(console.error);
    expect(errorEntry.timestamp).toEqual(expect.any(String));
    expect(new Date(errorEntry.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('includes custom data fields in the JSON output', () => {
    log.info('Submission created', { submissionId: 'sub_1', userId: 'user_1' });

    const entry = parseLastCall(console.log);
    expect(entry.submissionId).toBe('sub_1');
    expect(entry.userId).toBe('user_1');
  });
});
