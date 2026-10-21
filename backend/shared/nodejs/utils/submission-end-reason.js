/**
 * Why a proctored submission ended.
 *
 * - submit_button: the student pressed Submit in the editor (the default).
 * - left_page: the student left mid-session and the client auto-submitted their current code.
 *   These must ALWAYS go to instructor review and never be auto-credentialed.
 */
const END_REASONS = Object.freeze({
  SUBMIT_BUTTON: 'submit_button',
  LEFT_PAGE: 'left_page'
});

const VALID_END_REASONS = Object.values(END_REASONS);

/**
 * Validate the optional `endedBy` field from a request body.
 * Missing/empty values default to 'submit_button' so older clients keep working.
 * @returns {{ value: string, error: string|null }}
 */
function parseEndedBy(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { value: END_REASONS.SUBMIT_BUTTON, error: null };
  }
  if (!VALID_END_REASONS.includes(raw)) {
    return { value: END_REASONS.SUBMIT_BUTTON, error: `endedBy must be one of: ${VALID_END_REASONS.join(', ')}` };
  }
  return { value: raw, error: null };
}

module.exports = { END_REASONS, VALID_END_REASONS, parseEndedBy };
