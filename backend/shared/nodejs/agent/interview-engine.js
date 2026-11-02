/**
 * The Host agent's interview loop, with no database access.
 *
 * Code decides the structure: the instructor's main questions are asked in order, per theme,
 * in the instructor's own wording. The model only chooses whether to ask a follow-up (fitted to
 * this student's code and answers, up to maxFollowUpsPerMainQuestion for each main question)
 * or to move on. When the engine overrides the model, the stored reason describes what the
 * engine did and the model's own reason is kept as modelReason.
 *
 * Used by the interview service (Lambda) and by backend/scripts/mock-interview.js.
 * Nothing here logs prompts, answers or code.
 */
const fs = require('fs');
const path = require('path');
const bedrock = require('./bedrock-client');
const { isMultiPart, firstQuestionOnly } = require('./follow-up-check');

const PROMPT_VERSIONS = Object.freeze(['host.v1', 'host.v2', 'host.v3', 'host.v4']);
// The prompt versions that receive the instructor's rubric (a list of items r1, r2, ... per main question) and reply with
// the rubric ids the answer did not show ("missing"), the id a follow-up aims at ("target") and "isHint".
const RUBRIC_PROMPTS = Object.freeze(['host.v4']);
const PROMPT_VERSION = 'host.v3'; // default; AGENT_PROMPT_VERSION or an explicit version overrides it
const DEFAULT_FOLLOW_UPS_PER_MAIN = 1;
const MAX_FOLLOW_UPS_PER_MAIN = 3;
const MAX_FOLLOW_UP_LENGTH = 300;
const MAX_REASON_LENGTH = 500;
// host.v4 replies carry more fields (missing, target, isHint) than the other versions; the client default of 300 tokens could cut one off.
const RUBRIC_MAX_TOKENS = 500;
const MAX_CODE_CHARS = 30000;
const MAX_TRANSCRIPT_TURNS = 24;

const ACTIONS = Object.freeze({ FOLLOW_UP: 'follow_up', NEXT_MAIN: 'next_main', END: 'end' });
const REWRITE_REQUEST = 'Your follow-up asks more than one question. Rewrite it as ONE question about the same point, with a single question mark and no second request. Reply with the same JSON object only.';
const FALLBACKS = Object.freeze({
  MODEL_UNAVAILABLE: 'model_unavailable',
  INVALID_OUTPUT: 'invalid_output',
});
const FALLBACK_REASONS = Object.freeze({
  [FALLBACKS.MODEL_UNAVAILABLE]: 'fallback: model unavailable',
  [FALLBACKS.INVALID_OUTPUT]: 'fallback: invalid model output',
});

/** The prompt version for new interviews: an explicit value, else AGENT_PROMPT_VERSION, else the default. */
function resolvePromptVersion(version = process.env.AGENT_PROMPT_VERSION || PROMPT_VERSION) {
  if (!PROMPT_VERSIONS.includes(version)) {
    throw new Error(`Unknown prompt version "${version}". Available: ${PROMPT_VERSIONS.join(', ')}`);
  }
  return version;
}

/**
 * Follow-ups allowed per main question. Older configs only have maxFollowUpsPerTheme; that number
 * is carried over as the per-main-question limit (capped at the new maximum).
 */
function followUpBudget(config) {
  if (Number.isInteger(config.maxFollowUpsPerMainQuestion)) return config.maxFollowUpsPerMainQuestion;
  if (Number.isInteger(config.maxFollowUpsPerTheme)) {
    return Math.min(config.maxFollowUpsPerTheme, MAX_FOLLOW_UPS_PER_MAIN);
  }
  return DEFAULT_FOLLOW_UPS_PER_MAIN;
}

const promptCache = {};
function loadPrompt(version = resolvePromptVersion()) {
  resolvePromptVersion(version);
  if (!promptCache[version]) {
    promptCache[version] = fs.readFileSync(path.join(__dirname, 'prompts', `${version}.md`), 'utf8');
  }
  return promptCache[version];
}

/** True for the prompt versions that work from a rubric. */
const usesRubric = (version) => RUBRIC_PROMPTS.includes(version);

/**
 * The rubric of the main question being discussed, as [{ id, text }]: what a full answer must say. It sits next to the
 * theme's criteria in the config (`theme.rubric[mainIndex]`). A config without one falls back to the criteria, one item each.
 */
function rubricFor(config, state) {
  const theme = currentTheme(config, state);
  const own = Array.isArray(theme.rubric) ? theme.rubric[state.mainIndex] : null;
  if (Array.isArray(own) && own.length) return own.map((item) => ({ id: String(item.id), text: String(item.text) }));
  return (theme.criteria || []).map((text, i) => ({ id: `r${i + 1}`, text }));
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
    return { themeIndex: state.themeIndex, mainIndex: state.mainIndex + 1, followUpCount: 0 };
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

/**
 * The actions the model may choose right now:
 * follow_up only while this main question has budget left, next_main only while a main question
 * remains, end only when none remain.
 */
function allowedActions(config, state) {
  const followUpsRemaining = Math.max(0, followUpBudget(config) - state.followUpCount);
  const mainsLeft = nextMainPosition(config, state) !== null;
  const allowed = [];
  if (followUpsRemaining > 0) allowed.push(ACTIONS.FOLLOW_UP);
  allowed.push(mainsLeft ? ACTIONS.NEXT_MAIN : ACTIONS.END);
  return allowed;
}

function buildUserMessage({ config, state, code, turns, rubric }) {
  const theme = currentTheme(config, state);
  const followUpsRemaining = Math.max(0, followUpBudget(config) - state.followUpCount);
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
    ...(rubric ? ['Rubric for this main question (private; a full answer shows every item):', ...rubric.map((item) => `- ${item.id}: ${item.text}`)] : []),
    `Follow-ups remaining for this main question: ${followUpsRemaining}`,
    `More main questions remain after this one: ${mainsLeft ? 'yes' : 'no'}`,
    `Allowed actions now: ${allowedActions(config, state).join(', ')}`,
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
 * On failure, `modelReason` carries the model's own reason when the JSON was readable.
 *
 * With `rubric` (host.v4) the reply must also carry `missing`, a list of rubric ids; a follow-up carries `target`, the
 * id it aims at; `isHint` marks a follow-up that is a smaller step or hint after a struggling answer.
 * @returns {{ ok: true, value: { action, question, reason, missing?, target?, isHint? } } | { ok: false, modelReason?: string }}
 */
function parseHostOutput(text, { criteria = [], rubric = null } = {}) {
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
  if (!parsed || typeof parsed !== 'object') return { ok: false };

  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, MAX_REASON_LENGTH) : '';
  const invalid = { ok: false, ...(reason && { modelReason: reason }) };
  if (!Object.values(ACTIONS).includes(parsed.action)) return invalid;

  let question = typeof parsed.question === 'string' ? parsed.question.replace(/\s+/g, ' ').trim() : '';

  const rubricIds = rubric ? rubric.map((item) => item.id) : null;
  const extra = {};
  if (rubricIds) {
    const missing = rubricIdList(parsed.missing, rubricIds);
    if (!missing) return invalid;
    extra.missing = missing;
    extra.target = null;
    extra.isHint = false;
    if (parsed.action === ACTIONS.FOLLOW_UP) {
      const target = typeof parsed.target === 'string' ? rubricIds.find((id) => id.toLowerCase() === parsed.target.trim().toLowerCase()) : undefined;
      if (!target) return invalid;
      extra.target = target;
      extra.isHint = parsed.isHint === true;
    }
  }

  if (parsed.action === ACTIONS.FOLLOW_UP) {
    if (!question || question.length > MAX_FOLLOW_UP_LENGTH) return invalid;
    if (/\b(rubric|criteria|criterion)\b/i.test(question)) return invalid;
    // With a rubric, its items are private too.
    if (leaksCriterion(question, rubric ? [...criteria, ...rubric.map((item) => item.text)] : criteria)) return invalid;
  } else {
    question = '';
  }
  return { ok: true, value: { action: parsed.action, question, reason, ...extra } };
}

/** The rubric ids in a reply's "missing" list, in rubric order without repeats; null when it is not a list of known ids. "none" is ignored. */
function rubricIdList(value, ids) {
  if (!Array.isArray(value)) return null;
  const found = new Set();
  for (const item of value) {
    if (typeof item !== 'string') return null;
    if (item.trim().toLowerCase() === 'none') continue;
    const match = ids.find((id) => id.toLowerCase() === item.trim().toLowerCase());
    if (!match) return null;
    found.add(match);
  }
  return ids.filter((id) => found.has(id));
}

/**
 * Two-question guard. A follow-up that asks more than one question (the simple text check) is sent back to the model
 * once to be rewritten as one question. If the rewrite still asks two, or the model cannot answer, only the first
 * question is kept. `guard` records what happened.
 * @returns {Promise<{ question: string, guard: object, usage: object }>}
 */
async function guardTwoQuestions({ decision, firstReply, userMessage, system, modelId, converseFn, parseOptions }) {
  const guard = { fired: true, original: decision.question, fixedByRetry: false };
  const usage = { inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  try {
    const result = await converseFn({
      system,
      messages: [
        { role: 'user', content: [{ text: userMessage }] },
        { role: 'assistant', content: [{ text: firstReply }] },
        { role: 'user', content: [{ text: REWRITE_REQUEST }] },
      ],
      modelId,
      ...(parseOptions.rubric && { maxTokens: RUBRIC_MAX_TOKENS }),
    });
    usage.inputTokens = result.inputTokens;
    usage.outputTokens = result.outputTokens;
    usage.latencyMs = result.latencyMs;
    const again = parseHostOutput(result.text, parseOptions);
    if (again.ok && again.value.action === ACTIONS.FOLLOW_UP && !isMultiPart(again.value.question)) {
      guard.fixedByRetry = true;
      return { question: again.value.question, guard, usage };
    }
  } catch (error) {
    if (error.name !== 'ModelUnavailableError') throw error;
    guard.retryFailed = true;
  }
  return { question: firstQuestionOnly(decision.question), guard, usage };
}

/**
 * Decide the next step after the student's latest answer (already the last entry of `turns`).
 *
 * `reason` always describes the action actually taken. When the engine replaced the model's
 * choice (fallback or override), the model's own reason, if any, is returned as `modelReason`.
 * When only one action is allowed (the next main question, or end) the model is not called at all and the
 * result has `engineDecision: true`.
 *
 * @returns {Promise<{
 *   action: 'follow_up'|'next_main'|'end',
 *   question: string, reason: string, modelReason?: string,
 *   themeId: string|null, kind: 'main'|'follow_up'|null,
 *   state: object, fallback: string|null,
 *   usage: { inputTokens: number, outputTokens: number, latencyMs: number },
 *   engineDecision?: true, guard?: object, missing?: string[], target?: string|null, isHint?: boolean
 * }>}
 */
async function decideNext({ config, state, code, turns, modelId, promptVersion, converseFn = bedrock.converse }) {
  const followUpsRemaining = followUpBudget(config) - state.followUpCount;
  const nextMain = nextMainPosition(config, state);
  const theme = currentTheme(config, state);
  const allowed = allowedActions(config, state);
  const version = promptVersion || resolvePromptVersion();
  const rubric = usesRubric(version) ? rubricFor(config, state) : null;

  let usage = { inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  let decision = null;
  let fallback = null;
  let modelReason = '';
  let guard = null;
  let engineDecision = false;

  if (allowed.length === 1) {
    // Nothing to choose: no follow-up is left for this main question. The model is not asked.
    engineDecision = true;
    decision = {
      action: allowed[0],
      question: '',
      reason: allowed[0] === ACTIONS.NEXT_MAIN
        ? 'engine: no follow-up left for this main question; asked the next main question'
        : 'engine: no follow-up left and no main question remains; ended',
    };
  } else {
    try {
      const system = loadPrompt(version);
      const userMessage = buildUserMessage({ config, state, code, turns, rubric });
      const parseOptions = { criteria: theme.criteria, rubric };
      const result = await converseFn({
        system,
        messages: [{ role: 'user', content: [{ text: userMessage }] }],
        modelId,
        ...(rubric && { maxTokens: RUBRIC_MAX_TOKENS }),
      });
      usage = { inputTokens: result.inputTokens, outputTokens: result.outputTokens, latencyMs: result.latencyMs };

      const parsed = parseHostOutput(result.text, parseOptions);
      if (parsed.ok) {
        decision = parsed.value;
        modelReason = parsed.value.reason;
        if (decision.action === ACTIONS.FOLLOW_UP && followUpsRemaining > 0 && isMultiPart(decision.question)) {
          const guarded = await guardTwoQuestions({ decision, firstReply: result.text, userMessage, system, modelId, converseFn, parseOptions });
          guard = guarded.guard;
          decision = { ...decision, question: guarded.question };
          usage = {
            inputTokens: usage.inputTokens + guarded.usage.inputTokens,
            outputTokens: usage.outputTokens + guarded.usage.outputTokens,
            latencyMs: usage.latencyMs + guarded.usage.latencyMs,
          };
        }
      } else {
        fallback = FALLBACKS.INVALID_OUTPUT;
        modelReason = parsed.modelReason || '';
      }
    } catch (error) {
      if (error.name !== 'ModelUnavailableError') throw error;
      fallback = FALLBACKS.MODEL_UNAVAILABLE;
    }
  }

  // What the engine will do instead of the model's choice, if anything.
  const moveOn = nextMain ? ACTIONS.NEXT_MAIN : ACTIONS.END;
  const moveOnText = nextMain ? 'asked the next main question' : 'no main questions remain, ended';
  let action;
  let reason;
  let replaced = true;

  if (fallback) {
    action = moveOn;
    reason = `${FALLBACK_REASONS[fallback]}; ${moveOnText}`;
  } else if (decision.action === ACTIONS.FOLLOW_UP && followUpsRemaining <= 0) {
    action = moveOn;
    reason = `override: follow-up limit for this main question reached; ${moveOnText}`;
  } else if (decision.action === ACTIONS.END && nextMain) {
    // Every student gets the instructor's full question set.
    action = ACTIONS.NEXT_MAIN;
    reason = 'override: model asked to end but main questions remain; asked the next main question';
  } else if (decision.action === ACTIONS.NEXT_MAIN && !nextMain) {
    action = ACTIONS.END;
    reason = 'override: model asked for another main question but none remain; ended';
  } else {
    action = decision.action;
    reason = decision.reason;
    replaced = false;
  }
  const withModelReason = replaced && modelReason ? { modelReason } : {};

  // What was recorded about this decision, next to the action: the engine's own decision, the guard, and the
  // rubric fields of host.v4 (the target and the hint only belong to a follow-up that was asked).
  const asked = action === ACTIONS.FOLLOW_UP;
  const record = {
    ...(engineDecision && { engineDecision: true }),
    ...(guard && { guard }),
    ...(decision && Array.isArray(decision.missing) && {
      missing: decision.missing,
      target: asked ? decision.target : null,
      isHint: asked ? decision.isHint : false,
    }),
  };

  const baseState = { ...state, fallbackCount: state.fallbackCount + (fallback ? 1 : 0) };

  if (action === ACTIONS.FOLLOW_UP) {
    return {
      action,
      question: decision.question,
      reason,
      themeId: theme.id,
      kind: 'follow_up',
      state: { ...baseState, followUpCount: state.followUpCount + 1 },
      fallback,
      usage,
      ...record,
    };
  }

  if (action === ACTIONS.NEXT_MAIN) {
    const next = { ...baseState, ...nextMain };
    return {
      action,
      question: currentMainQuestion(config, next),
      reason,
      ...withModelReason,
      themeId: currentTheme(config, next).id,
      kind: 'main',
      state: next,
      fallback,
      usage,
      ...record,
    };
  }

  return { action, question: '', reason, ...withModelReason, themeId: null, kind: null, state: baseState, fallback, usage, ...record };
}

/** The fields of a decision that are stored on the Host turn (or on the interview's end detail). */
function recordFields(decision) {
  const out = {};
  if (decision.engineDecision) out.engineDecision = true;
  if (decision.guard) out.guard = decision.guard;
  if (Array.isArray(decision.missing)) {
    out.missing = decision.missing;
    out.target = decision.target;
    out.isHint = decision.isHint;
  }
  return out;
}

module.exports = {
  PROMPT_VERSION,
  PROMPT_VERSIONS,
  RUBRIC_PROMPTS,
  DEFAULT_FOLLOW_UPS_PER_MAIN,
  MAX_FOLLOW_UPS_PER_MAIN,
  ACTIONS,
  FALLBACKS,
  FALLBACK_REASONS,
  MAX_FOLLOW_UP_LENGTH,
  REWRITE_REQUEST,
  resolvePromptVersion,
  usesRubric,
  rubricFor,
  followUpBudget,
  allowedActions,
  initialState,
  firstQuestion,
  decideNext,
  buildUserMessage,
  parseHostOutput,
  recordFields,
  loadPrompt,
};
