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

describe('rubric', () => {
  const rubric = (n = 1) => Array.from({ length: n }, () => [{ id: 'r1', text: 'Shows X' }, { id: 'r2', text: 'Shows Y' }]);
  const withRubric = (r, mq = ['Q1?']) => valid({ themes: [theme({ mainQuestions: mq, rubric: r })] });

  it('keeps the rubric per main question in the shape the engine and the eval cases use', () => {
    const { value, error } = parseInterview(withRubric(rubric(2), ['Q1?', 'Q2?']), cpp);
    expect(error).toBeNull();
    expect(value.themes[0].rubric).toEqual(rubric(2));
  });

  it('adds no rubric key when the theme has none', () => {
    expect(parseInterview(valid(), cpp).value.themes[0]).not.toHaveProperty('rubric');
  });

  it('trims ids and text, and allows an empty list (the criteria are used instead)', () => {
    const { value, error } = parseInterview(withRubric([[{ id: ' r1 ', text: ' Shows X ' }]]), cpp);
    expect(error).toBeNull();
    expect(value.themes[0].rubric).toEqual([[{ id: 'r1', text: 'Shows X' }]]);
    expect(parseInterview(withRubric([[]]), cpp).error).toBeNull();
  });

  it.each([
    ['not an array', 'x', 'rubric must be an array'],
    ['a different length from mainQuestions', rubric(2), 'one list per main question (1)'],
    ['a list that is not an array', ['x'], 'rubric[0] must be an array'],
    ['an item that is not an object', [['x']], 'rubric[0][0] must be an object'],
    ['a missing id', [[{ text: 'T' }]], 'rubric[0][0].id'],
    ['a bad id', [[{ id: 'r 1', text: 'T' }]], 'letters, digits'],
    ['an id over 20 characters', [[{ id: 'a'.repeat(21), text: 'T' }]], 'exceed 20'],
    ['a repeated id', [[{ id: 'r1', text: 'A' }, { id: 'R1', text: 'B' }]], 'used more than once'],
    ['empty text', [[{ id: 'r1', text: '  ' }]], 'must not be empty'],
    ['text over 500 characters', [[{ id: 'r1', text: 'x'.repeat(501) }]], 'exceed 500'],
    ['more than 8 items', [Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, text: 'T' }))], 'more than 8 items'],
  ])('rejects a rubric with %s', (_name, input, message) => {
    expect(parseInterview(withRubric(input), cpp).error).toContain(message);
  });
});

describe('promptVersion', () => {
  it('is kept when it is a known version', () => {
    const { value, error } = parseInterview(valid({ promptVersion: 'host.v5' }), cpp);
    expect(error).toBeNull();
    expect(value.promptVersion).toBe('host.v5');
  });

  it('is absent when not given (the engine default applies)', () => {
    expect(parseInterview(valid(), cpp).value).not.toHaveProperty('promptVersion');
    expect(parseInterview(valid({ promptVersion: null }), cpp).value).not.toHaveProperty('promptVersion');
  });

  it.each(['host.v9', 'v5', '', 5])('rejects %p', (v) => {
    expect(parseInterview(valid({ promptVersion: v }), cpp).error).toContain('promptVersion');
  });
});

describe('redactInterview', () => {
  it('hides the setup for logging without mutating the input', () => {
    const input = { title: 'T', interview: valid() };
    expect(redactInterview(input)).toEqual({ title: 'T', interview: '[redacted]' });
    expect(input.interview.themes).toBeDefined();
  });
});
