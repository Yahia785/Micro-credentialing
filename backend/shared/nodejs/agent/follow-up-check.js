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

/**
 * The content words of a rubric item that carry its claim: numbers ("-5", "80"), ALL-CAPS names ("ALARM") and code identifiers
 * (snake_case, camelCase, name()). They are what a follow-up must not state.
 */
function claimTokens(text) {
  const found = String(text).match(/-?\b\d+(?:\.\d+)?\b|\b[A-Z][A-Z0-9_]{2,}\b|\b[A-Za-z]+_[A-Za-z0-9_]+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Za-z_]\w*(?=\(\))/g) || [];
  return [...new Set(found.map((t) => t.toLowerCase()))];
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** True when `token` (lower case) stands in the text as a word of its own ("-5" is not found inside "-50"). */
const hasToken = (text, token) => new RegExp(`(^|[^\\w.-])${escapeRegExp(token)}(?![\\w])`, 'i').test(String(text));

// Words that say what a controller or a function DOES with a state: a question that puts a claim token (a state name) right behind one of
// them says the outcome instead of asking for it ("goes to ALARM", "keep the state as FILLING", "stays FULL"). The verb counts only when the
// item itself uses a verb of the same kind: an item about "stays FILLING" is not stated by "after 18 the state moves to FILLING".
const VERB_FAMILIES = {
  hold: ['stay', 'stays', 'staying', 'remain', 'remains', 'remaining', 'keep', 'keeps', 'keeping', 'hold', 'holds', 'holding'],
  move: ['go', 'goes', 'going', 'went', 'move', 'moves', 'moving', 'moved', 'transition', 'transitions', 'become', 'becomes', 'becoming',
    'switch', 'switches', 'switching', 'change', 'changes', 'turn', 'turns', 'enter', 'enters', 'entering', 'set', 'sets'],
  give: ['return', 'returns'],
};
const OUTCOME_VERBS = Object.values(VERB_FAMILIES).flat();
const familyOf = (verb) => Object.keys(VERB_FAMILIES).find((name) => VERB_FAMILIES[name].includes(String(verb).toLowerCase()));
const OUTCOME_REACH = 30; // how many characters after the verb the claim token may stand
const OUTCOME_VERB_RX = new RegExp(`\\b(?:${OUTCOME_VERBS.join('|')})\\b`, 'gi');
const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'that', 'so', 'at', 'for', 'on', 'as', 'be', 'by', 'with', 'are', 'was', 'its', 'this', 'than', 'then', 'from', 'if']);
const REASON_WINDOW = 4;
// A copied window counts only when it carries the item's claim or reason, not a bare scenario ("readings go back and forth around 50").
const REASON_WORDS = new Set(['because', 'so', 'until', 'only', 'between', 'keeps', 'keep', 'stays', 'stay', 'every', 'always', 'never', 'instead', 'counted', 'cannot', 'returns']);

const BS = String.fromCharCode(92); // the backslash, for building the verb patterns
const sentencesOf = (text) => String(text).split(/(?<=[.?!])\s+/).map((part) => part.trim()).filter(Boolean);

/** True when, inside one sentence, an outcome verb of one of `families` is followed within a few characters by `token` (a claim token, lower case). */
function verbBeforeToken(sentence, token, families) {
  OUTCOME_VERB_RX.lastIndex = 0;
  let found;
  while ((found = OUTCOME_VERB_RX.exec(sentence)) !== null) {
    const after = sentence.slice(found.index + found[0].length, found.index + found[0].length + OUTCOME_REACH);
    // the claim token must come before the end of the clause (a comma or question mark ends it)
    const clause = after.split(/[,;?!]/)[0];
    if (hasToken(clause, token) && families.includes(familyOf(found[0]))) return true;
  }
  return false;
}

/**
 * Four words in a row that the question shares with the item (at least three of them real words, not numbers or small words), and that
 * are not already in the main question: the question copies the item's own statement, usually the reason.
 */
function copiesReason(question, item, mainQuestion) {
  const own = words(item);
  const asked = ` ${words(question).join(' ')} `;
  const main = ` ${words(mainQuestion).join(' ')} `;
  for (let i = 0; i + REASON_WINDOW <= own.length; i += 1) {
    const window = own.slice(i, i + REASON_WINDOW);
    if (window.filter((w) => !STOP_WORDS.has(w) && !/^\d+$/.test(w)).length < 3 || !window.some((w) => REASON_WORDS.has(w))) continue;
    const phrase = ` ${window.join(' ')} `;
    if (asked.includes(phrase) && !main.includes(phrase)) return true;
  }
  return false;
}

/**
 * host.v6 rule: a follow-up must never ASSERT the content of a rubric item the student has not shown. It is rejected only when it
 *   (a) says an outcome of the item: an outcome verb right before one of the item's claim tokens ("When the controller goes to ALARM
 *       for -5, ...", "what would you write to keep the state as FILLING?") with a second claim token of the same item in that sentence, or
 *   (b) copies four words of the item's own wording that are not in the main question ("...reading 40 is between low and high, ...").
 * Numbers and state names used as a scenario or as the thing asked about are allowed: "What state does step return for 40 when the state
 * is FILLING?", "What would happen for the readings 49, 51, 49, 51?".
 * Returns the id of the item, or null.
 */
function givesAwayItem(question, items, mainQuestion = '') {
  const sentences = sentencesOf(question);
  for (const item of items) {
    const tokens = claimTokens(item.text);
    const families = [...new Set((String(item.text).toLowerCase().match(new RegExp(BS + 'b(?:' + OUTCOME_VERBS.join('|') + ')' + BS + 'b', 'g')) || []).map(familyOf))];
    const states = (String(item.text).match(/\b[A-Z][A-Z0-9_]{2,}\b/g) || []).map((t) => t.toLowerCase());
    for (const sentence of sentences) {
      const inSentence = tokens.filter((token) => hasToken(sentence, token));
      // only a STATE name (ALARM, FILLING) behind the verb is an outcome; a number behind it is an input ("goes from 49 to 51")
      if (inSentence.length >= 2 && inSentence.some((token) => states.includes(token) && verbBeforeToken(sentence, token, families) && !hasToken(mainQuestion, token))) return item.id;
    }
    if (copiesReason(question, item.text, mainQuestion)) return item.id;
  }
  return null;
}


/**
 * Unfinished code: a follow-up must not ask what the program prints or what a function returns or does. The code is missing or does not
 * compile, so there is nothing to read; the student describes how they meant it to work. True for "What does step return for 40?",
 * "Your program printed ... Walk me through what step does", "What is the output for ...?". "What would you write ...?" and
 * "What should step return ...?" ask about the intended design and are fine.
 */
function asksAboutCode(question) {
  const text = String(question);
  if (/\b(should|would you|do you plan|did you plan|do you intend|did you intend|do you want|did you want|how would you)\b/i.test(text)) return false;
  return [
    /\b(does|did|do|will)\b[^?]{0,60}\b(return|returns|print|prints|output|outputs|produce|produces|display|displays)\b/i,
    /\b(printed|prints|printing)\b/i,
    /\bwhat (is|was) (the )?(output|result)\b/i,
    /\bwhat\b[^?]{0,40}\b(would|will) (it|step|isvalid|the function|the step function|your function|your step function|your program|the program)\b[^?]{0,30}\b(return|print|output|do)\b/i,
    /\bwhat (would|will) (it|step|isvalid|the function|your function|your step function) (need to )?do\b/i,
    /\bwhat (state )?(does|did) (your |the )?(step|isvalid|main|function|program|code)\b/i,
  ].some((rx) => rx.test(text));
}

module.exports = { asksAboutCode, isYesNo, isMultiPart, firstQuestionOnly, leaksCriterion, givesAwayItem, claimTokens };
