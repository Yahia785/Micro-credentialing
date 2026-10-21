const { END_REASONS, parseEndedBy } = require('../utils/submission-end-reason');

describe('parseEndedBy', () => {
  it('defaults to submit_button when missing', () => {
    expect(parseEndedBy(undefined)).toEqual({ value: 'submit_button', error: null });
    expect(parseEndedBy(null)).toEqual({ value: 'submit_button', error: null });
    expect(parseEndedBy('')).toEqual({ value: 'submit_button', error: null });
  });

  it('accepts the two known reasons', () => {
    expect(parseEndedBy(END_REASONS.SUBMIT_BUTTON).value).toBe('submit_button');
    expect(parseEndedBy(END_REASONS.LEFT_PAGE).value).toBe('left_page');
  });

  it('rejects anything else with a message', () => {
    const result = parseEndedBy('timeout');
    expect(result.error).toMatch(/endedBy must be one of/);
  });
});
