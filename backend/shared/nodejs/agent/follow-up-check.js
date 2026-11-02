/**
 * Plain-text checks on a follow-up question, shared by the interview engine (the two-question guard)
 * and the evaluation scripts (metrics). Pure functions, no I/O.
 */
const YES_NO_STARTERS = ['is', 'are', 'does', 'do', 'did', 'can', 'could', 'will', 'would', 'should', 'has', 'have'];
const JOINED_QUESTIONS = /\band\b\s+(what|how|why|when|where|which|who|does|do|did|is|are|can|could|would|will|should)\b/i;

/** A follow-up that starts with Is/Are/Does/Do/Did/Can/Could/Will/Would/Should/Has/Have. */
function isYesNo(question) {
  const first = String(question).trim().split(/\s+/)[0] || '';
  return YES_NO_STARTERS.includes(first.toLowerCase().replace(/[^a-z']/g, ''));
}

/** More than one question mark, or two questions joined by "and" ("... and why ...", "... and what ..."). */
function isMultiPart(question) {
  const text = String(question);
  const marks = (text.match(/\?/g) || []).length;
  return marks > 1 || JOINED_QUESTIONS.test(text);
}

/**
 * Only the first question of a follow-up that asks several: up to the first question mark, or, when the
 * second question is joined with "and", the part before that "and".
 */
function firstQuestionOnly(question) {
  const text = String(question).replace(/\s+/g, ' ').trim();
  const mark = text.indexOf('?');
  if (mark !== -1 && text.slice(mark + 1).trim()) return text.slice(0, mark + 1);
  const joined = JOINED_QUESTIONS.exec(text);
  if (joined) {
    const head = text.slice(0, joined.index).replace(/[\s,;:]+$/, '');
    if (head) return `${head}?`;
  }
  return text;
}

module.exports = { isYesNo, isMultiPart, firstQuestionOnly };
