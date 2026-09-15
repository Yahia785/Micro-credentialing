const { validateRequired, validateEnum, validateMaxLength } = require('../utils/validation');

describe('validateRequired', () => {
  it('returns null when all required fields are present', () => {
    expect(validateRequired({ name: 'Alice', email: 'a@b.com' }, ['name', 'email'])).toBeNull();
  });

  it('returns an error message naming the missing field', () => {
    expect(validateRequired({ name: 'Alice' }, ['name', 'email'])).toBe('email is required');
  });

  it('treats an empty string as missing', () => {
    expect(validateRequired({ name: '' }, ['name'])).toBe('name is required');
  });

  it('treats null as missing', () => {
    expect(validateRequired({ name: null }, ['name'])).toBe('name is required');
  });

  it('treats undefined as missing', () => {
    expect(validateRequired({ name: undefined }, ['name'])).toBe('name is required');
  });
});

describe('validateEnum', () => {
  it('returns null for a valid value', () => {
    expect(validateEnum('easy', 'difficulty', ['easy', 'medium', 'hard'])).toBeNull();
  });

  it('returns an error message listing allowed values for an invalid value', () => {
    expect(validateEnum('impossible', 'difficulty', ['easy', 'medium', 'hard']))
      .toBe('difficulty must be one of: easy, medium, hard');
  });
});

describe('validateMaxLength', () => {
  it('returns null for a string under the limit', () => {
    expect(validateMaxLength('hello', 'name', 10)).toBeNull();
  });

  it('returns an error message for a string over the limit', () => {
    expect(validateMaxLength('this string is too long', 'name', 5))
      .toBe('name must not exceed 5 characters');
  });

  it('returns null for non-string values', () => {
    expect(validateMaxLength(12345, 'code', 3)).toBeNull();
  });
});
