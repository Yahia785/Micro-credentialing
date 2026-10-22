/**
 * Optional `interview` setup on a coding assessment (C++ only for now).
 *
 * {
 *   enabled: boolean,
 *   timeLimitMinutes: 1-30 (default 10),
 *   maxFollowUpsPerTheme: 0-5 (default 2),
 *   themes: [{ id, title, mainQuestions: [string], criteria: [string] }]
 * }
 *
 * `criteria` are instructor-only guidance. They must never reach a student.
 */
const DEFAULTS = Object.freeze({ timeLimitMinutes: 10, maxFollowUpsPerTheme: 2 });

const LIMITS = Object.freeze({
  minTimeLimitMinutes: 1,
  maxTimeLimitMinutes: 30,
  maxFollowUps: 5,
  maxThemes: 10,
  maxMainQuestions: 8,
  maxCriteria: 10,
  maxIdLength: 40,
  maxTitleLength: 120,
  maxQuestionLength: 500,
  maxCriterionLength: 500,
});

const SUPPORTED_LANGUAGE = 'cpp';
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function cleanString(value, field, maxLength, errors) {
  if (typeof value !== 'string') {
    errors.push(`${field} must be a string`);
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    errors.push(`${field} must not be empty`);
    return null;
  }
  if (CONTROL_CHARS.test(trimmed)) {
    errors.push(`${field} contains invalid characters`);
    return null;
  }
  if (trimmed.length > maxLength) {
    errors.push(`${field} must not exceed ${maxLength} characters`);
    return null;
  }
  return trimmed;
}

function cleanStringList(raw, field, maxItems, maxLength, errors, { required }) {
  if (raw === undefined || raw === null) {
    if (required) errors.push(`${field} is required`);
    return [];
  }
  if (!Array.isArray(raw)) {
    errors.push(`${field} must be an array`);
    return [];
  }
  if (required && raw.length === 0) errors.push(`${field} must have at least one entry`);
  if (raw.length > maxItems) {
    errors.push(`${field} must not have more than ${maxItems} entries`);
    return [];
  }
  return raw.map((item, i) => cleanString(item, `${field}[${i}]`, maxLength, errors)).filter((s) => s !== null);
}

function cleanInteger(raw, field, min, max, fallback, errors) {
  if (raw === undefined || raw === null) return fallback;
  if (!Number.isInteger(raw) || raw < min || raw > max) {
    errors.push(`${field} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return raw;
}

/**
 * Parse the `interview` field of a request body.
 *
 * - undefined -> not provided; leave the stored value alone
 * - null      -> provided; clear the interview setup
 * - object    -> validated and normalised
 *
 * @param {*} raw
 * @param {{ language?: string, type?: string }} assessment the assessment the setup is for
 * @returns {{ provided: boolean, value: object|null, error: string|null }}
 */
function parseInterview(raw, assessment = {}) {
  if (raw === undefined) return { provided: false, value: null, error: null };
  if (raw === null) return { provided: true, value: null, error: null };

  const fail = (error) => ({ provided: true, value: null, error });

  if (assessment.type === 'embedded') {
    return fail('interview is only supported on coding assessments');
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('interview must be an object');
  }
  if (typeof raw.enabled !== 'boolean') {
    return fail('interview.enabled must be a boolean');
  }

  const errors = [];
  const timeLimitMinutes = cleanInteger(
    raw.timeLimitMinutes, 'interview.timeLimitMinutes',
    LIMITS.minTimeLimitMinutes, LIMITS.maxTimeLimitMinutes, DEFAULTS.timeLimitMinutes, errors
  );
  const maxFollowUpsPerTheme = cleanInteger(
    raw.maxFollowUpsPerTheme, 'interview.maxFollowUpsPerTheme',
    0, LIMITS.maxFollowUps, DEFAULTS.maxFollowUpsPerTheme, errors
  );

  let themes = [];
  if (raw.themes !== undefined && raw.themes !== null) {
    if (!Array.isArray(raw.themes)) {
      errors.push('interview.themes must be an array');
    } else if (raw.themes.length > LIMITS.maxThemes) {
      errors.push(`interview.themes must not have more than ${LIMITS.maxThemes} entries`);
    } else {
      const seen = new Set();
      themes = raw.themes.map((theme, i) => {
        const where = `interview.themes[${i}]`;
        if (!theme || typeof theme !== 'object' || Array.isArray(theme)) {
          errors.push(`${where} must be an object`);
          return null;
        }
        const id = cleanString(theme.id, `${where}.id`, LIMITS.maxIdLength, errors);
        if (id !== null) {
          if (!ID_PATTERN.test(id)) errors.push(`${where}.id may only contain letters, digits, "-" and "_"`);
          if (seen.has(id)) errors.push(`${where}.id "${id}" is used more than once`);
          seen.add(id);
        }
        return {
          id,
          title: cleanString(theme.title, `${where}.title`, LIMITS.maxTitleLength, errors),
          mainQuestions: cleanStringList(theme.mainQuestions, `${where}.mainQuestions`,
            LIMITS.maxMainQuestions, LIMITS.maxQuestionLength, errors, { required: true }),
          criteria: cleanStringList(theme.criteria, `${where}.criteria`,
            LIMITS.maxCriteria, LIMITS.maxCriterionLength, errors, { required: false }),
        };
      }).filter(Boolean);
    }
  }

  if (raw.enabled && themes.length === 0 && errors.length === 0) {
    errors.push('interview.themes must have at least one theme when the interview is enabled');
  }
  if (raw.enabled && assessment.language !== SUPPORTED_LANGUAGE) {
    errors.push('interviews are only supported for C++ assessments');
  }
  if (errors.length > 0) return fail(errors[0]);

  return {
    provided: true,
    value: { enabled: raw.enabled, timeLimitMinutes, maxFollowUpsPerTheme, themes },
    error: null,
  };
}

/** Copy of an object with the instructor-only interview setup removed (for logging). */
function redactInterview(obj) {
  if (!obj || typeof obj !== 'object' || !('interview' in obj)) return obj;
  const { interview, ...rest } = obj;
  return { ...rest, interview: interview ? '[redacted]' : interview };
}

module.exports = { parseInterview, redactInterview, DEFAULTS, LIMITS, SUPPORTED_LANGUAGE };
