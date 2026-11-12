/**
 * Optional `interview` setup on a coding assessment (C++ only for now).
 *
 * {
 *   enabled: boolean,
 *   timeLimitMinutes: 1-30 (default 10),
 *   maxFollowUpsPerMainQuestion: 0-3 (default 1),
 *   promptVersion: optional, one of the known Host prompt versions (absent = the engine's default),
 *   themes: [{ id, title, mainQuestions: [string], criteria: [string],
 *              rubric?: [[{ id, text }]],     // rubric[i] belongs to mainQuestions[i]; ids like "r1"
 *              runs?: [[{ label, stdin }]] }] // runs[i] belongs to mainQuestions[i]: inputs the engine runs the student's code on
 *                                             // when that question is asked (host.v6 shows the output to the agent, never to the student)
 * }
 *
 * `fixedFollowUps` (optional): one follow-up question per main question, in the order the main questions are asked. The Host (v6 and v7)
 * asks it when the follow-up it wrote was rejected even after one rewrite. Instructor-only until it is asked.
 *
 * Older configs may carry `maxFollowUpsPerTheme` (0-5) instead. It still validates and is kept
 * as written; the interview engine converts it when it runs.
 *
 * `criteria` and `rubric` are instructor-only guidance. They must never reach a student.
 * `rubric` has one list per main question (an empty list falls back to the criteria); it is the shape the
 * rubric prompts (host.v4, host.v4.1, host.v5) and the eval case files use.
 */
const { PROMPT_VERSIONS } = require('../agent/prompt-versions');

const DEFAULTS = Object.freeze({ timeLimitMinutes: 10, maxFollowUpsPerMainQuestion: 1 });

const LIMITS = Object.freeze({
  minTimeLimitMinutes: 1,
  maxTimeLimitMinutes: 30,
  maxFollowUpsPerMainQuestion: 3,
  maxFollowUpsPerTheme: 5,
  maxThemes: 10,
  maxMainQuestions: 8,
  maxCriteria: 10,
  maxIdLength: 40,
  maxTitleLength: 120,
  maxQuestionLength: 500,
  maxCriterionLength: 500,
  maxRubricItems: 8,
  maxRubricIdLength: 20,
  maxRubricTextLength: 500,
  maxRunsPerQuestion: 3,
  maxRunLabelLength: 60,
  maxRunStdinLength: 2000,
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

/**
 * theme.rubric: one list of { id, text } per main question, same order and length as mainQuestions.
 * Returns undefined when the theme has none.
 */
function cleanRubric(raw, where, mainQuestionCount, errors) {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    errors.push(`${where}.rubric must be an array`);
    return undefined;
  }
  if (raw.length !== mainQuestionCount) {
    errors.push(`${where}.rubric must have one list per main question (${mainQuestionCount})`);
    return undefined;
  }
  return raw.map((items, q) => {
    const at = `${where}.rubric[${q}]`;
    if (!Array.isArray(items)) {
      errors.push(`${at} must be an array`);
      return [];
    }
    if (items.length > LIMITS.maxRubricItems) {
      errors.push(`${at} must not have more than ${LIMITS.maxRubricItems} items`);
      return [];
    }
    const seen = new Set();
    return items.map((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`${at}[${i}] must be an object`);
        return null;
      }
      const id = cleanString(item.id, `${at}[${i}].id`, LIMITS.maxRubricIdLength, errors);
      if (id !== null) {
        if (!ID_PATTERN.test(id)) errors.push(`${at}[${i}].id may only contain letters, digits, "-" and "_"`);
        if (seen.has(id.toLowerCase())) errors.push(`${at}[${i}].id "${id}" is used more than once`);
        seen.add(id.toLowerCase());
      }
      return { id, text: cleanString(item.text, `${at}[${i}].text`, LIMITS.maxRubricTextLength, errors) };
    }).filter(Boolean);
  });
}

/**
 * theme.runs: one list per main question, same order and length as mainQuestions; each run is { label, stdin }
 * (stdin may be empty). Returns undefined when the theme has none.
 */
function cleanRuns(raw, where, mainQuestionCount, errors) {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    errors.push(`${where}.runs must be an array`);
    return undefined;
  }
  if (raw.length !== mainQuestionCount) {
    errors.push(`${where}.runs must have one list per main question (${mainQuestionCount})`);
    return undefined;
  }
  return raw.map((items, q) => {
    const at = `${where}.runs[${q}]`;
    if (!Array.isArray(items)) {
      errors.push(`${at} must be an array`);
      return [];
    }
    if (items.length > LIMITS.maxRunsPerQuestion) {
      errors.push(`${at} must not have more than ${LIMITS.maxRunsPerQuestion} runs`);
      return [];
    }
    return items.map((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`${at}[${i}] must be an object`);
        return null;
      }
      const label = cleanString(item.label, `${at}[${i}].label`, LIMITS.maxRunLabelLength, errors);
      if (typeof item.stdin !== 'string') {
        errors.push(`${at}[${i}].stdin must be a string`);
        return null;
      }
      if (item.stdin.length > LIMITS.maxRunStdinLength) {
        errors.push(`${at}[${i}].stdin must not exceed ${LIMITS.maxRunStdinLength} characters`);
        return null;
      }
      return { label, stdin: item.stdin };
    }).filter(Boolean);
  });
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
  // The per-main-question limit wins. A legacy per-theme limit is kept as written when it is the
  // only one given; with neither, the default applies.
  const hasNewLimit = raw.maxFollowUpsPerMainQuestion !== undefined && raw.maxFollowUpsPerMainQuestion !== null;
  const hasLegacyLimit = raw.maxFollowUpsPerTheme !== undefined && raw.maxFollowUpsPerTheme !== null;
  const followUpLimit = {};
  if (hasNewLimit || !hasLegacyLimit) {
    followUpLimit.maxFollowUpsPerMainQuestion = cleanInteger(
      raw.maxFollowUpsPerMainQuestion, 'interview.maxFollowUpsPerMainQuestion',
      0, LIMITS.maxFollowUpsPerMainQuestion, DEFAULTS.maxFollowUpsPerMainQuestion, errors
    );
  } else {
    followUpLimit.maxFollowUpsPerTheme = cleanInteger(
      raw.maxFollowUpsPerTheme, 'interview.maxFollowUpsPerTheme',
      0, LIMITS.maxFollowUpsPerTheme, 0, errors
    );
  }

  let promptVersion;
  if (raw.promptVersion !== undefined && raw.promptVersion !== null) {
    if (typeof raw.promptVersion !== 'string' || !PROMPT_VERSIONS.includes(raw.promptVersion)) {
      errors.push(`interview.promptVersion must be one of: ${PROMPT_VERSIONS.join(', ')}`);
    } else {
      promptVersion = raw.promptVersion;
    }
  }

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
        const mainQuestions = cleanStringList(theme.mainQuestions, `${where}.mainQuestions`,
          LIMITS.maxMainQuestions, LIMITS.maxQuestionLength, errors, { required: true });
        const rubric = cleanRubric(theme.rubric, where, Array.isArray(theme.mainQuestions) ? theme.mainQuestions.length : 0, errors);
        const runs = cleanRuns(theme.runs, where, Array.isArray(theme.mainQuestions) ? theme.mainQuestions.length : 0, errors);
        return {
          id,
          title: cleanString(theme.title, `${where}.title`, LIMITS.maxTitleLength, errors),
          mainQuestions,
          criteria: cleanStringList(theme.criteria, `${where}.criteria`,
            LIMITS.maxCriteria, LIMITS.maxCriterionLength, errors, { required: false }),
          ...(rubric && { rubric }),
          ...(runs && { runs }),
        };
      }).filter(Boolean);
    }
  }

  let fixedFollowUps;
  if (raw.fixedFollowUps !== undefined && raw.fixedFollowUps !== null) {
    const total = themes.reduce((n, theme) => n + theme.mainQuestions.length, 0);
    const list = cleanStringList(raw.fixedFollowUps, 'interview.fixedFollowUps', Math.max(total, 1), LIMITS.maxQuestionLength, errors, { required: false });
    if (Array.isArray(raw.fixedFollowUps) && list.length !== raw.fixedFollowUps.length && errors.length === 0) errors.push('interview.fixedFollowUps entries must not be empty');
    if (list.length) fixedFollowUps = list;
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
    value: { enabled: raw.enabled, timeLimitMinutes, ...followUpLimit, ...(promptVersion && { promptVersion }), themes, ...(fixedFollowUps && { fixedFollowUps }) },
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
