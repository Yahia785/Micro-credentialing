/**
 * Scripted students. A case file has five profiles (strong, vague, wrong, short, idk), each with a
 * main answer and a follow-up answer per main question, and a label for each answer. The `mixed`
 * profile is a fixed list of labels, one per main question; its text comes from the profile that
 * matches each label, so it is identical across prompts and repeats.
 */
const LABELS = Object.freeze(['good', 'vague', 'wrong', 'short', 'idk']);
const BAD_LABELS = Object.freeze(['vague', 'wrong', 'short', 'idk']);
// The profile whose answers a label is taken from.
const PROFILE_FOR_LABEL = Object.freeze({ good: 'strong', vague: 'vague', wrong: 'wrong', short: 'short', idk: 'idk' });
const BASE_PROFILES = Object.freeze(['strong', 'vague', 'wrong', 'short', 'idk']);
const PROFILES = Object.freeze([...BASE_PROFILES, 'mixed']);
const MAX_ANSWER_LENGTH = 2000;

function checkAnswer(answer, where) {
  if (!answer || typeof answer.text !== 'string' || !answer.text.trim()) {
    throw new Error(`${where}: missing answer text`);
  }
  if (answer.text.length > MAX_ANSWER_LENGTH) throw new Error(`${where}: answer is over ${MAX_ANSWER_LENGTH} characters`);
  if (!LABELS.includes(answer.label)) throw new Error(`${where}: label must be one of ${LABELS.join(', ')}`);
}

/** Validate a scripted-student file against the number of main questions in the case. */
function validateStudents(raw, mainCount, caseId = 'case') {
  if (!raw || typeof raw !== 'object' || !raw.profiles) throw new Error(`${caseId}: students file has no profiles`);
  for (const name of BASE_PROFILES) {
    const entries = raw.profiles[name];
    if (!Array.isArray(entries) || entries.length !== mainCount) {
      throw new Error(`${caseId}: profile "${name}" needs ${mainCount} entries (one per main question)`);
    }
    entries.forEach((entry, i) => {
      checkAnswer(entry.main, `${caseId} ${name} Q${i + 1} main`);
      checkAnswer(entry.followUp, `${caseId} ${name} Q${i + 1} followUp`);
    });
  }
  if (!Array.isArray(raw.mixed) || raw.mixed.length !== mainCount) {
    throw new Error(`${caseId}: mixed needs ${mainCount} labels (one per main question)`);
  }
  raw.mixed.forEach((label, i) => {
    if (!LABELS.includes(label)) throw new Error(`${caseId}: mixed label ${i + 1} must be one of ${LABELS.join(', ')}`);
  });
  if (new Set(raw.mixed).size !== raw.mixed.length) {
    throw new Error(`${caseId}: mixed must use a different label for each main question`);
  }
  return raw;
}

/**
 * The answers for one profile: an array with one { main, followUp, source } per main question.
 * `source` is the profile the text came from (the profile itself, except for mixed).
 */
function buildProfile(raw, profileName) {
  if (!PROFILES.includes(profileName)) {
    throw new Error(`Unknown profile "${profileName}". Available: ${PROFILES.join(', ')}`);
  }
  if (profileName !== 'mixed') {
    return raw.profiles[profileName].map((entry) => ({ main: entry.main, followUp: entry.followUp, source: profileName }));
  }
  return raw.mixed.map((label, i) => {
    const source = PROFILE_FOR_LABEL[label];
    const entry = raw.profiles[source][i];
    return { main: entry.main, followUp: entry.followUp, source };
  });
}

module.exports = {
  LABELS, BAD_LABELS, BASE_PROFILES, PROFILES, PROFILE_FOR_LABEL, MAX_ANSWER_LENGTH,
  validateStudents, buildProfile,
};
