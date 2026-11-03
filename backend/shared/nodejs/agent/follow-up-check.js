/**
 * Plain-text checks on a follow-up question, shared by the interview engine (the two-question guard)
 * and the evaluation scripts (metrics). Pure functions, no I/O.
 */
const YES_NO_STARTERS = ['is', 'are', 'does', 'do', 'did', 'can', 'could', 'will', 'would', 'should', 'has', 'have'];
const JOINED_QUESTIONS = /\band\b\s+(what|how|why|when|where|which|who|does|do|did|is|are|can|could|would|will|should)\b/i;

const starterOf = (text) => (String(text).trim().split(/\s+/)[0] || '').toLowerCase().replace(/[^a-z']/g, '');

/**
 * A yes/no question: it starts with Is/Are/Does/Do/Did/Can/Could/Will/Would/Should/Has/Have, or its last clause does
 * ("When X, does the pump turn on again?"). A clause ends at a comma, semicolon, colon, dash or sentence end; a question
 * that opens with a wh-word and has no such break ("When does the pump actually start?") is not flagged.
 */
function isYesNo(question) {
  const text = String(question).trim();
  if (YES_NO_STARTERS.includes(starterOf(text))) return true;
  const clauses = text.replace(/[?!]+$/, '').split(/[,;:]|[.!?](?=\s)|\s[-–—]\s/).map((c) => c.trim()).filter(Boolean);
  const last = clauses[clauses.length - 1];
  return !!last && YES_NO_STARTERS.includes(starterOf(last));
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

const LEAK_WINDOW = 5;
const normalise = (text) => String(text).toLowerCase().replace(/\s+/g, ' ').trim();
const words = (text) => normalise(text).replace(/[^a-z0-9' ]/g, ' ').split(' ').filter(Boolean);

/** True if the question repeats a criterion, or any run of five consecutive words of one. */
function leaksCriterion(question, criteria) {
  const questionText = ` ${words(question).join(' ')} `;
  return criteria.some((criterion) => {
    const w = words(criterion);
    if (w.length === 0) return false;
    const size = Math.min(LEAK_WINDOW, w.length);
    if (size < 3) return false;
    for (let i = 0; i + size <= w.length; i += 1) {
      if (questionText.includes(` ${w.slice(i, i + size).join(' ')} `)) return true;
    }
    return false;
  });
}

module.exports = { isYesNo, isMultiPart, firstQuestionOnly, leaksCriterion };
