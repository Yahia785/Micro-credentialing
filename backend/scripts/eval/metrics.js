/**
 * Metrics for the Host agent evaluation. Everything that decides "is this a problem?" lives here, so
 * the heuristics can be read, tested and changed in one place.
 *
 * Input is the saved transcript of one interview (see README.md for the shape):
 *   { promptVersion, caseId, profile, status, budget, turns: [...], endDetail, endModelCall, calls }
 * Host turns carry kind ('main' | 'follow_up'), text, reason, modelReason, fallback and modelCall.
 * Student turns carry scripted: { label, answerType, mainOrdinal }.
 *
 * A "step" is one decision of the Host: the student answered, and the Host then asked a follow-up,
 * asked the next main question, or ended the interview.
 */
const { BAD_LABELS, LABELS } = require('./students');

// ---------------------------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------------------------

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

// Phrases in a reason that argue for a follow-up, and phrases that argue against one.
const REASON_SAYS_NO_FOLLOW_UP = [
  'no follow-up needed',
  'no follow up needed',
  'no follow-up is needed',
  'no further follow-up',
  'no further question',
  'no clarification needed',
  'no clarification is needed',
  'does not need a follow-up',
  "doesn't need a follow-up",
  'no need for a follow-up',
  'fully covers',
  'fully covered',
];
const REASON_SAYS_FOLLOW_UP = [
  'needs clarification',
  'need clarification',
  'requires clarification',
  'clarification is needed',
  'clarification before',
  'probe',
  'probing',
  'follow-up is needed',
  'needs a follow-up',
  'needs follow-up',
  'should ask a follow-up',
  'ask a follow-up',
  'incomplete',
];
// "no need to probe", "not incomplete": a negation right before the phrase cancels it.
const NEGATION_BEFORE = /(\bno need to |\bnot |\bwithout |n't |\bno )$/;

function mentions(reason, phrases) {
  const text = String(reason).toLowerCase();
  return phrases.some((phrase) => {
    let at = text.indexOf(phrase);
    while (at !== -1) {
      const before = text.slice(Math.max(0, at - 14), at);
      if (!NEGATION_BEFORE.test(before)) return true;
      at = text.indexOf(phrase, at + 1);
    }
    return false;
  });
}

/**
 * Does the model's reason argue for a different action than the one taken?
 * @param {'follow_up'|'next_main'|'end'} action
 */
function reasonContradictsAction(action, reason) {
  if (!reason) return false;
  return action === 'follow_up' ? mentions(reason, REASON_SAYS_NO_FOLLOW_UP) : mentions(reason, REASON_SAYS_FOLLOW_UP);
}

const OVERRIDE_PREFIXES = [
  ['override: follow-up limit', 'followUpLimit'],
  ['override: model asked to end', 'earlyEnd'],
  ['override: model asked for another main question', 'nextMainNoneRemain'],
];
const OVERRIDE_TYPES = OVERRIDE_PREFIXES.map(([, type]) => type);

/** What kind of reason is this? 'followUpLimit' | 'earlyEnd' | 'nextMainNoneRemain' | 'fallback' | 'model' */
function classifyReason(reason) {
  const text = String(reason || '');
  if (text.startsWith('fallback:')) return 'fallback';
  const hit = OVERRIDE_PREFIXES.find(([prefix]) => text.startsWith(prefix));
  return hit ? hit[1] : 'model';
}

const THROTTLE_ERRORS = ['ThrottlingException', 'TooManyRequestsException', 'ServiceQuotaExceededException', 'RequestLimitExceeded'];
function isThrottleError(name) {
  return THROTTLE_ERRORS.includes(name);
}

// ---------------------------------------------------------------------------------------------
// Per-transcript counters
// ---------------------------------------------------------------------------------------------

const zeroByLabel = (labels) => Object.fromEntries(labels.map((l) => [l, 0]));

function emptyCounters() {
  return {
    interviews: 0,
    completed: 0,
    timedOut: 0,
    errored: 0,
    questions: 0,
    followUps: 0,
    decisions: 0,
    mainAnswers: zeroByLabel(LABELS),
    unnecessaryOpportunities: 0,
    unnecessary: 0,
    missedOpportunities: zeroByLabel(BAD_LABELS),
    missed: zeroByLabel(BAD_LABELS),
    overrides: zeroByLabel(OVERRIDE_TYPES),
    fallbacks: { invalidOutput: 0, modelUnavailable: 0, throttled: 0 },
    throttleRetries: 0,
    yesNo: 0,
    multiPart: 0,
    reasonChecks: 0,
    contradictions: 0,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencies: [],
  };
}

/** The decisions in a transcript, in order. */
function stepsOf(transcript) {
  const turns = transcript.turns || [];
  const steps = [];
  turns.forEach((turn, i) => {
    if (turn.role !== 'student') return;
    const asked = turns[i - 1];
    const next = turns[i + 1];
    let step;
    if (next && next.role === 'host') {
      step = {
        action: next.kind === 'follow_up' ? 'follow_up' : 'next_main',
        question: next.text,
        reason: next.reason,
        fallback: next.fallback || null,
        modelCall: next.modelCall || null,
      };
    } else if (!next && transcript.status === 'completed' && transcript.endDetail) {
      step = {
        action: 'end',
        question: '',
        reason: transcript.endDetail.reason,
        fallback: transcript.endDetail.fallback || null,
        modelCall: transcript.endModelCall || null,
      };
    } else {
      return; // timed out or errored before the Host answered
    }
    steps.push({ ...step, answeredMain: !!asked && asked.kind === 'main', label: turn.scripted && turn.scripted.label });
  });
  return steps;
}

function analyzeTranscript(transcript) {
  const c = emptyCounters();
  c.interviews = 1;
  if (transcript.status === 'completed') c.completed = 1;
  else if (transcript.status === 'timed_out') c.timedOut = 1;
  else c.errored = 1;

  const turns = transcript.turns || [];
  c.questions = turns.filter((t) => t.role === 'host').length;
  c.followUps = turns.filter((t) => t.role === 'host' && t.kind === 'follow_up').length;
  const followUpAllowed = (transcript.budget || 0) > 0;

  for (const step of stepsOf(transcript)) {
    c.decisions += 1;
    const kind = classifyReason(step.reason);

    if (OVERRIDE_TYPES.includes(kind)) c.overrides[kind] += 1;
    if (step.fallback === 'invalid_output') c.fallbacks.invalidOutput += 1;
    if (step.fallback === 'model_unavailable') {
      if (step.modelCall && step.modelCall.throttled) c.fallbacks.throttled += 1;
      else c.fallbacks.modelUnavailable += 1;
    }

    if (step.action === 'follow_up') {
      if (isYesNo(step.question)) c.yesNo += 1;
      if (isMultiPart(step.question)) c.multiPart += 1;
    }

    // Reasons written by the model itself (not by the engine) are checked against the action.
    if (kind === 'model' && step.reason) {
      c.reasonChecks += 1;
      if (reasonContradictsAction(step.action, step.reason)) c.contradictions += 1;
    }

    // Follow-up judgement: only answers to a main question, and only decisions the model made.
    if (step.answeredMain && step.label && !step.fallback) {
      c.mainAnswers[step.label] += 1;
      if (followUpAllowed && step.label === 'good') {
        c.unnecessaryOpportunities += 1;
        if (step.action === 'follow_up') c.unnecessary += 1;
      }
      if (followUpAllowed && BAD_LABELS.includes(step.label)) {
        c.missedOpportunities[step.label] += 1;
        if (step.action !== 'follow_up') c.missed[step.label] += 1;
      }
    }
  }

  for (const call of transcript.calls || []) {
    c.calls += 1;
    c.inputTokens += call.inputTokens || 0;
    c.outputTokens += call.outputTokens || 0;
    c.throttleRetries += call.throttleRetries || 0;
    if (call.latencyMs > 0) c.latencies.push(call.latencyMs);
  }
  return c;
}

function mergeCounters(a, b) {
  const out = emptyCounters();
  const add = (x, y) => {
    if (typeof x === 'number') return x + y;
    if (Array.isArray(x)) return [...x, ...y];
    return Object.fromEntries(Object.keys(x).map((k) => [k, add(x[k], y[k])]));
  };
  for (const key of Object.keys(out)) out[key] = add(a[key], b[key]);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------------------------

/** A fraction with its counts. rate is null when there was nothing to measure. */
function ratio(num, den) {
  return { num, den, rate: den > 0 ? num / den : null };
}

const sum = (object) => Object.values(object).reduce((a, b) => a + b, 0);

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Price per million tokens in USD. */
const DEFAULT_PRICES = Object.freeze({ inputPerMillion: 0.15, outputPerMillion: 0.6 });

function estimateCost(inputTokens, outputTokens, prices = DEFAULT_PRICES) {
  return (inputTokens * prices.inputPerMillion + outputTokens * prices.outputPerMillion) / 1e6;
}

/** Turn merged counters into the numbers that are reported. */
function summarize(counters, prices = DEFAULT_PRICES) {
  const c = counters;
  const missedOpportunities = sum(c.missedOpportunities);
  const missedTotal = sum(c.missed);
  const overrideTotal = sum(c.overrides);
  const fallbackTotal = sum(c.fallbacks);

  return {
    interviews: c.interviews,
    completed: c.completed,
    timedOut: c.timedOut,
    errored: c.errored,
    questionsPerInterview: c.interviews ? c.questions / c.interviews : null,
    followUpsPerInterview: c.interviews ? c.followUps / c.interviews : null,
    unnecessaryFollowUp: ratio(c.unnecessary, c.unnecessaryOpportunities),
    missedFollowUp: ratio(missedTotal, missedOpportunities),
    missedFollowUpByLabel: Object.fromEntries(BAD_LABELS.map((l) => [l, ratio(c.missed[l], c.missedOpportunities[l])])),
    overrides: {
      total: ratio(overrideTotal, c.decisions),
      byType: Object.fromEntries(OVERRIDE_TYPES.map((t) => [t, ratio(c.overrides[t], c.decisions)])),
    },
    fallbacks: {
      total: ratio(fallbackTotal, c.decisions),
      invalidOutput: c.fallbacks.invalidOutput,
      modelUnavailable: c.fallbacks.modelUnavailable,
      throttled: c.fallbacks.throttled,
      throttleRetries: c.throttleRetries,
    },
    yesNo: ratio(c.yesNo, c.followUps),
    multiPart: ratio(c.multiPart, c.followUps),
    reasonContradiction: ratio(c.contradictions, c.reasonChecks),
    latencyMs: { median: median(c.latencies), p95: percentile(c.latencies, 0.95), n: c.latencies.length },
    calls: c.calls,
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    estimatedCostUsd: estimateCost(c.inputTokens, c.outputTokens, prices),
  };
}

/** Summary of a list of transcripts. */
function summarizeTranscripts(transcripts, prices) {
  const merged = transcripts.map(analyzeTranscript).reduce(mergeCounters, emptyCounters());
  return summarize(merged, prices);
}

const uniq = (values) => [...new Set(values)];

/**
 * Per prompt version: overall, by case and by profile.
 * @returns {{ [promptVersion: string]: { overall, byCase: object, byProfile: object } }}
 */
function summarizeRun(transcripts, prices) {
  const result = {};
  for (const promptVersion of uniq(transcripts.map((t) => t.promptVersion))) {
    const mine = transcripts.filter((t) => t.promptVersion === promptVersion);
    const group = (key) => Object.fromEntries(
      uniq(mine.map((t) => t[key])).sort().map((value) => [value, summarizeTranscripts(mine.filter((t) => t[key] === value), prices)])
    );
    result[promptVersion] = {
      overall: summarizeTranscripts(mine, prices),
      byCase: group('caseId'),
      byProfile: group('profile'),
    };
  }
  return result;
}

module.exports = {
  isYesNo,
  isMultiPart,
  reasonContradictsAction,
  classifyReason,
  isThrottleError,
  stepsOf,
  analyzeTranscript,
  mergeCounters,
  emptyCounters,
  summarize,
  summarizeTranscripts,
  summarizeRun,
  ratio,
  median,
  percentile,
  estimateCost,
  DEFAULT_PRICES,
  OVERRIDE_TYPES,
  THROTTLE_ERRORS,
};
