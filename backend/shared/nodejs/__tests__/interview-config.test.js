const { parseInterview, redactInterview, DEFAULTS } = require('../utils/interview-config');

const theme = (over = {}) => ({
  id: 'pointers',
  title: 'Pointers',
  mainQuestions: ['Explain your list.'],
  criteria: ['Describes next pointers'],
  ...over,
});
const valid = (over = {}) => ({ enabled: true, themes: [theme()], ...over });
const cpp = { language: 'cpp' };

describe('parseInterview', () => {
  it('leaves the stored value alone when the field is absent', () => {
    expect(parseInterview(undefined, cpp)).toEqual({ provided: false, value: null, error: null });
  });

  it('clears the interview with null', () => {
    expect(parseInterview(null, cpp)).toEqual({ provided: true, value: null, error: null });
  });

  it('applies defaults for the time limit and follow-up cap', () => {
    const { value, error } = parseInterview(valid(), cpp);
    expect(error).toBeNull();
    expect(value.timeLimitMinutes).toBe(DEFAULTS.timeLimitMinutes);
    expect(value.maxFollowUpsPerMainQuestion).toBe(DEFAULTS.maxFollowUpsPerMainQuestion);
    expect(value.maxFollowUpsPerMainQuestion).toBe(1);
    expect(value.maxFollowUpsPerTheme).toBeUndefined();
    expect(value.themes[0]).toEqual(theme());
  });

  describe('follow-up limit', () => {
    it.each([0, 1, 2, 3])('accepts maxFollowUpsPerMainQuestion %p', (n) => {
      const { value, error } = parseInterview(valid({ maxFollowUpsPerMainQuestion: n }), cpp);
      expect(error).toBeNull();
      expect(value.maxFollowUpsPerMainQuestion).toBe(n);
    });

    it.each([-1, 4, 1.5, '1'])('rejects maxFollowUpsPerMainQuestion %p', (n) => {
      expect(parseInterview(valid({ maxFollowUpsPerMainQuestion: n }), cpp).error).toContain('maxFollowUpsPerMainQuestion');
    });

    it('still validates a legacy maxFollowUpsPerTheme and keeps it as written', () => {
      const { value, error } = parseInterview(valid({ maxFollowUpsPerTheme: 4 }), cpp);
      expect(error).toBeNull();
      expect(value.maxFollowUpsPerTheme).toBe(4);
      expect(value.maxFollowUpsPerMainQuestion).toBeUndefined();
    });

    it('still range-checks the legacy field', () => {
      expect(parseInterview(valid({ maxFollowUpsPerTheme: 6 }), cpp).error).toContain('maxFollowUpsPerTheme');
    });

    it('lets the new field win when both are sent, and drops the legacy one', () => {
      const { value } = parseInterview(valid({ maxFollowUpsPerTheme: 4, maxFollowUpsPerMainQuestion: 2 }), cpp);
      expect(value.maxFollowUpsPerMainQuestion).toBe(2);
      expect(value.maxFollowUpsPerTheme).toBeUndefined();
    });

    it('a stored legacy config survives a re-save unchanged', () => {
      const stored = parseInterview(valid({ maxFollowUpsPerTheme: 2 }), cpp).value;
      expect(parseInterview(stored, cpp).value).toEqual(stored);
    });
  });

  it('trims strings and drops unknown keys', () => {
    const { value } = parseInterview(valid({ extra: 1, themes: [theme({ title: '  Pointers  ', other: 'x' })] }), cpp);
    expect(value.extra).toBeUndefined();
    expect(value.themes[0].title).toBe('Pointers');
    expect(value.themes[0].other).toBeUndefined();
  });

  it.each([
    ['not an object', 'yes', 'interview must be an object'],
    ['enabled missing', { themes: [theme()] }, 'interview.enabled must be a boolean'],
    ['no themes while enabled', { enabled: true, themes: [] }, 'at least one theme'],
    ['time limit out of range', valid({ timeLimitMinutes: 99 }), 'timeLimitMinutes'],
    ['time limit not an integer', valid({ timeLimitMinutes: 2.5 }), 'timeLimitMinutes'],
    ['negative follow-ups', valid({ maxFollowUpsPerMainQuestion: -1 }), 'maxFollowUpsPerMainQuestion'],
    ['theme without id', valid({ themes: [theme({ id: '' })] }), 'themes[0].id'],
    ['theme id with spaces', valid({ themes: [theme({ id: 'a b' })] }), 'letters, digits'],
    ['duplicate ids', valid({ themes: [theme(), theme()] }), 'used more than once'],
    ['no main questions', valid({ themes: [theme({ mainQuestions: [] })] }), 'mainQuestions'],
    ['blank main question', valid({ themes: [theme({ mainQuestions: ['  '] })] }), 'must not be empty'],
    ['criteria not an array', valid({ themes: [theme({ criteria: 'x' })] }), 'criteria must be an array'],
    ['too many themes', valid({ themes: Array.from({ length: 11 }, (_, i) => theme({ id: `t${i}` })) }), 'more than 10'],
  ])('rejects %s', (_name, input, message) => {
    const { error } = parseInterview(input, cpp);
    expect(error).toContain(message);
  });

  it('rejects an enabled interview on a non-C++ assessment', () => {
    expect(parseInterview(valid(), { language: 'python' }).error).toContain('C++');
  });

  it('rejects the interview on embedded assessments', () => {
    expect(parseInterview(valid(), { type: 'embedded', language: 'cpp' }).error)
      .toBe('interview is only supported on coding assessments');
  });

  it('allows a disabled interview with no themes', () => {
    const { value, error } = parseInterview({ enabled: false }, { language: 'python' });
    expect(error).toBeNull();
    expect(value.enabled).toBe(false);
  });
});

describe('redactInterview', () => {
  it('hides the setup for logging without mutating the input', () => {
    const input = { title: 'T', interview: valid() };
    expect(redactInterview(input)).toEqual({ title: 'T', interview: '[redacted]' });
    expect(input.interview.themes).toBeDefined();
  });
});
