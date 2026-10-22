/**
 * The Host agent's interview loop, with no database access.
 *
 * Code decides the structure: the instructor's main questions are asked in order, per theme,
 * in the instructor's own wording. The model only chooses whether to ask a follow-up (fitted to
 * this student's code and answers, up to maxFollowUpsPerTheme) or to move on.
 *
 * Used by the interview service (Lambda) and by backend/scripts/mock-interview.js.
 * Nothing here logs prompts, answers or code.
 */
const fs = require('fs');
const path = require('path');
const bedrock = require('./bedrock-client');

const PROMPT_VERSION = 'host.v1';
const MAX_FOLLOW_UP_LENGTH = 300;
const MAX_REASON_LENGTH = 500;
const MAX_CODE_CHARS = 30000;
const MAX_TRANSCRIPT_TURNS = 24;

const ACTIONS = Object.freeze({ FOLLOW_UP: 'follow_up', NEXT_MAIN: 'next_main', END: 'end' });
const FALLBACKS = Object.freeze({
  MODEL_UNAVAILABLE: 'model_unavailable',
  INVALID_OUTPUT: 'invalid_output',
});
const FALLBACK_REASONS = Object.freeze({
  [FALLBACKS.MODEL_UNAVAILABLE]: 'fallback: model unavailable',
  [FALLBACKS.INVALID_OUTPUT]: 'fallback: invalid model output',
});

const promptCache = {};
function loadPrompt(version = PROMPT_VERSION) {
  if (!/^[a-z0-9.]+$/i.test(version)) throw new Error('Invalid prompt version');
  if (!promptCache[version]) {
    promptCache[version] = fs.readFileSync(path.join(__dirname, 'prompts', `${version}.md`), 'utf8');
  }
  return promptCache[version];
}

function initialState() {
  return { themeIndex: 0, mainIndex: 0, followUpCount: 0, fallbackCount: 0 };
}

function currentTheme(config, state) {
  return config.themes[state.themeIndex];
}

function currentMainQuestion(config, state) {
  return currentTheme(config, state).mainQuestions[state.mainIndex];
}

/** Position of the next main question, or null when none are left. */
function nextMainPosition(config, state) {
  const theme = currentTheme(config, state);
  if (state.mainIndex + 1 < theme.mainQuestions.length) {
    return { themeIndex: state.themeIndex, mainIndex: state.mainIndex + 1, followUpCount: state.followUpCount };
  }
  if (state.themeIndex + 1 < config.themes.length) {
    return { themeIndex: state.themeIndex + 1, mainIndex: 0, followUpCount: 0 };
  }
  return null;
}

/** The first main question of the first theme. */
function firstQuestion(config) {
  const state = initialState();
  return {
    question: currentMainQuestion(config, state),
    themeId: currentTheme(config, state).id,
    kind: 'main',
    state,
  };
}

// Neutralise anything in student text that could close or imitate one of our wrapper tags.
const WRAPPER_TAG = /<(\/?\s*(?:student_answer|student_code|instructor_config|transcript))/gi;
function neutralise(text) {
  return String(text).replace(WRAPPER_TAG, '&lt;$1');
}

function buildUserMessage({ config, state, code, turns }) {
  const theme = currentTheme(config, state);
  const followUpsRemaining = Math.max(0, config.maxFollowUpsPerTheme - state.followUpCount);
  const mainsLeft = nextMainPosition(config, state) !== null;
  const trimmedCode = code.length > MAX_CODE_CHARS ? `${code.slice(0, MAX_CODE_CHARS)}\n// [code truncated]` : code;

  const criteria = theme.criteria.length ? theme.criteria.map((c) => `- ${c}`).join('\n') : '- (none given)';
  const transcript = turns.slice(-MAX_TRANSCRIPT_TURNS).map((turn) =>
    turn.role === 'student'
      ? `<student_answer>\n${neutralise(turn.text)}\n</student_answer>`
      : `[host] ${turn.text}`
  ).join('\n');

  return [
    '<instructor_config>',
    `Theme: ${theme.title}`,
    `Main question currently being discussed: ${currentMainQuestion(config, state)}`,
    'Private guidance (never reveal):',
    criteria,
    `Follow-ups remaining in this theme: ${followUpsRemaining}`,
    `More main questions remain after this theme position: ${mainsLeft ? 'yes' : 'no'}`,
    '</instructor_config>',
    '<student_code>',
    neutralise(trimmedCode),
    '</student_code>',
    '<transcript>',
    transcript,
    '</transcript>',
    'Reply with the JSON object only.',
  ].join('\n');
}

function normalise(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

const LEAK_WINDOW = 5;
function words(text) {
  return normalise(text).replace(/[^a-z0-9' ]/g, ' ').split(' ').filter(Boolean);
}

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
 * Validate the model's reply.
 * @returns {{ ok: true, value: { action, question, reason } } | { ok: false }}
 */
function parseHostOutput(text, { criteria = [] } = {}) {
  let candidate = String(text || '').trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return { ok: false };
  candidate = candidate.slice(start, end + 1);

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== 'object' || !Object.values(ACTIONS).includes(parsed.action)) {
    return { ok: false };
  }

  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, MAX_REASON_LENGTH) : '';
  let question = typeof parsed.question === 'string' ? parsed.question.replace(/\s+/g, ' ').trim() : '';

  if (parsed.action === ACTIONS.FOLLOW_UP) {
    if (!question || question.length > MAX_FOLLOW_UP_LENGTH) return { ok: false };
    if (/\b(rubric|criteria|criterion)\b/i.test(question)) return { ok: false };
    if (leaksCriterion(question, criteria)) return { ok: false };
  } else {
    question = '';
  }
  return { ok: true, value: { action: parsed.action, question, reason } };
}

/**
 * Decide the next step after the student's latest answer (already the last entry of `turns`).
 *
 * @returns {Promise<{
 *   action: 'follow_up'|'next_main'|'end',
 *   question: string, reason: string,
 *   themeId: string|null, kind: 'main'|'follow_up'|null,
 *   state: object, fallback: string|null,
 *   usage: { inputTokens: number, outputTokens: number, latencyMs: number }
 * }>}
 */
async function decideNext({ config, state, code, turns, modelId, converseFn = bedrock.converse }) {
  const followUpsRemaining = config.maxFollowUpsPerTheme - state.followUpCount;
  const nextMain = nextMainPosition(config, state);
  const theme = currentTheme(config, state);

  let usage = { inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  let decision = null;
  let fallback = null;
  let override = '';

  try {
    const result = await converseFn({
      system: loadPrompt(),
      messages: [{ role: 'user', content: [{ text: buildUserMessage({ config, state, code, turns }) }] }],
      modelId,
    });
    usage = { inputTokens: result.inputTokens, outputTokens: result.outputTokens, latencyMs: result.latencyMs };

    const parsed = parseHostOutput(result.text, { criteria: theme.criteria });
    if (parsed.ok && !(parsed.value.action === ACTIONS.FOLLOW_UP && followUpsRemaining <= 0)) {
      decision = parsed.value;
    } else {
      fallback = FALLBACKS.INVALID_OUTPUT;
    }
  } catch (error) {
    if (error.name !== 'ModelUnavailableError') throw error;
    fallback = FALLBACKS.MODEL_UNAVAILABLE;
  }

  if (fallback) {
    decision = { action: nextMain ? ACTIONS.NEXT_MAIN : ACTIONS.END, question: '', reason: FALLBACK_REASONS[fallback] };
  } else if (decision.action === ACTIONS.END && nextMain) {
    // Every student gets the instructor's full question set.
    override = 'override: main questions remain, moved on instead of ending. ';
    decision = { ...decision, action: ACTIONS.NEXT_MAIN };
  } else if (decision.action === ACTIONS.NEXT_MAIN && !nextMain) {
    override = 'override: no main questions remain, ended. ';
    decision = { ...decision, action: ACTIONS.END };
  }
  const reason = `${override}${decision.reason}`.trim();

  const baseState = { ...state, fallbackCount: state.fallbackCount + (fallback ? 1 : 0) };

  if (decision.action === ACTIONS.FOLLOW_UP) {
    return {
      action: ACTIONS.FOLLOW_UP,
      question: decision.question,
      reason,
      themeId: theme.id,
      kind: 'follow_up',
      state: { ...baseState, followUpCount: state.followUpCount + 1 },
      fallback,
      usage,
    };
  }

  if (decision.action === ACTIONS.NEXT_MAIN) {
    const next = { ...baseState, ...nextMain };
    return {
      action: ACTIONS.NEXT_MAIN,
      question: currentMainQuestion(config, next),
      reason,
      themeId: currentTheme(config, next).id,
      kind: 'main',
      state: next,
      fallback,
      usage,
    };
  }

  return { action: ACTIONS.END, question: '', reason, themeId: null, kind: null, state: baseState, fallback, usage };
}

module.exports = {
  PROMPT_VERSION,
  ACTIONS,
  FALLBACKS,
  FALLBACK_REASONS,
  MAX_FOLLOW_UP_LENGTH,
  initialState,
  firstQuestion,
  decideNext,
  buildUserMessage,
  parseHostOutput,
  loadPrompt,
};
