/**
 * Optional "course" label on an assessment (coding or embedded). It is only a plain-text label used
 * to group assessments, not an entity of its own.
 */
const MAX_COURSE_LENGTH = 80;

// Control characters, plus angle brackets so a label can never carry markup.
const DISALLOWED = /[\u0000-\u001f\u007f<>]/;

/**
 * Parse the `course` field of a request body.
 *
 * - undefined      -> not provided; leave the stored value alone
 * - null / '' / '  ' -> provided; clear the course (stored as null, shown as "No course")
 * - string         -> trimmed, inner whitespace collapsed, validated
 *
 * @returns {{ provided: boolean, value: string|null, error: string|null }}
 */
function parseCourse(raw) {
  if (raw === undefined) {
    return { provided: false, value: null, error: null };
  }
  if (raw === null) {
    return { provided: true, value: null, error: null };
  }
  if (typeof raw !== 'string') {
    return { provided: true, value: null, error: 'course must be a string' };
  }

  const value = raw.replace(/\s+/g, ' ').trim();
  if (value === '') {
    return { provided: true, value: null, error: null };
  }
  if (DISALLOWED.test(value)) {
    return { provided: true, value: null, error: 'course must be plain text' };
  }
  if (value.length > MAX_COURSE_LENGTH) {
    return { provided: true, value: null, error: `course must not exceed ${MAX_COURSE_LENGTH} characters` };
  }
  return { provided: true, value, error: null };
}

module.exports = { parseCourse, MAX_COURSE_LENGTH };
