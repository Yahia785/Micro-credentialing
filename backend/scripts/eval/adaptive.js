/**
 * Adaptive-behaviour metrics: does the Host follow the answer? Same answer should get the same kind
 * of follow-up, a specific weakness should get a follow-up on that weakness, and a strong answer
 * should not get one. The fixed-survey baseline gives the non-adaptive comparison for every number.
 *
 * Input is the saved transcripts (see README.md): the interviews, and the minimal-pair interviews.
 * Judgements (which gap a follow-up targets) are attached to host follow-up turns by the judge step;
 * without them the judge-based metrics are n/a.
 */
const { BAD_LABELS } = require('./students');
const { GAMING_LABEL, GAMING_PROFILES } = require('./students');
const { stepsOf, ratio } = require('./metrics');

const GAP_LABELS = [...BAD_LABELS, GAMING_LABEL];

const asksFollowUp = (step) => step.action === 'follow_up' && !step.fallback;
const hasJudgement = (step) => !!step.judgement && step.judgement.valid;
const actionOf = (step) => (step.action === 'follow_up' ? 'follow_up' : 'move_on');

/** Did the judged target match the gap the scripted answer left open? "all" accepts any listed gap. */
function hitsGap(step) {
  const { target } = step.judgement;
  if (target === 'none' || target === 'other') return false;
  return step.gap === 'all' || target === step.gap;
}

/** Pairwise agreement of the values in each group: 1 point per pair of repeats that match. */
function pairwiseAgreement(groups) {
  let agree = 0;
  let total = 0;
  for (const values of groups.values()) {
    for (let i = 0; i < values.length; i += 1) {
      for (let j = i + 1; j < values.length; j += 1) {
        total += 1;
        if (values[i] === values[j]) agree += 1;
      }
    }
  }
  return ratio(agree, total);
}

function addTo(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

/** How the follow-ups of the interviews matched the scripted gaps. */
function gapTargeting(transcripts) {
  const out = {
    eligible: 0, judged: 0, hit: 0, none: 0, other: 0,
    byLabel: Object.fromEntries(GAP_LABELS.map((l) => [l, { judged: 0, hit: 0 }])),
  };
  for (const transcript of transcripts) {
    for (const step of stepsOf(transcript)) {
      if (!asksFollowUp(step) || !step.gap) continue;
      out.eligible += 1;
      if (!hasJudgement(step)) continue;
      out.judged += 1;
      const bucket = out.byLabel[step.label];
      if (bucket) bucket.judged += 1;
      if (step.judgement.target === 'none') out.none += 1;
      else if (step.judgement.target === 'other') out.other += 1;
      if (hitsGap(step)) {
        out.hit += 1;
        if (bucket) bucket.hit += 1;
      }
    }
  }
  return {
    unjudged: out.eligible - out.judged,
    judged: out.judged,
    hit: ratio(out.hit, out.judged),
    none: ratio(out.none, out.judged),
    other: ratio(out.other, out.judged),
    byLabel: Object.fromEntries(GAP_LABELS.map((l) => [l, ratio(out.byLabel[l].hit, out.byLabel[l].judged)])),
  };
}

/** Across repeats of the same interview: same action, and same judged gap when a follow-up was asked. */
function consistency(transcripts) {
  const actions = new Map();
  const directions = new Map();
  for (const transcript of transcripts) {
    for (const step of stepsOf(transcript)) {
      if (!step.answeredMain || step.fallback) continue;
      const key = [transcript.promptVersion, transcript.caseId, transcript.profile, step.mainOrdinal].join('|');
      addTo(actions, key, actionOf(step));
      if (step.action === 'follow_up' && hasJudgement(step)) addTo(directions, key, step.judgement.target);
    }
  }
  return { action: pairwiseAgreement(actions), direction: pairwiseAgreement(directions) };
}

/** Main answers of the gaming profiles that got no follow-up although one was allowed. */
function gamingSkip(transcripts) {
  const opportunities = { all: 0 };
  const skipped = { all: 0 };
  GAMING_PROFILES.forEach((p) => { opportunities[p] = 0; skipped[p] = 0; });
  for (const transcript of transcripts) {
    if (!((transcript.budget || 0) > 0)) continue;
    for (const step of stepsOf(transcript)) {
      if (!step.answeredMain || step.label !== GAMING_LABEL || step.fallback) continue;
      const profile = transcript.profile;
      opportunities.all += 1;
      if (opportunities[profile] !== undefined) opportunities[profile] += 1;
      if (step.action !== 'follow_up') {
        skipped.all += 1;
        if (skipped[profile] !== undefined) skipped[profile] += 1;
      }
    }
  }
  return {
    total: ratio(skipped.all, opportunities.all),
    byProfile: Object.fromEntries(GAMING_PROFILES.map((p) => [p, ratio(skipped[p], opportunities[p])])),
  };
}

const normalise = (text) => String(text).toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Minimal pairs: two weak answers to the same question that leave different gaps, each run in the
 * same interview position. The pair discriminates when each variant's follow-up targets its own gap.
 */
function discrimination(pairTranscripts) {
  const groups = new Map();
  for (const transcript of pairTranscripts) {
    const { pairId, side, mainOrdinal } = transcript.pair;
    const key = [transcript.promptVersion, transcript.caseId, mainOrdinal, pairId, transcript.repeat].join('|');
    if (!groups.has(key)) groups.set(key, {});
    const steps = stepsOf(transcript);
    groups.get(key)[side] = { step: steps[steps.length - 1], gap: transcript.pair.gap }; // the decision after the pair answer
  }

  let pairs = 0;
  let bothAsked = 0;
  let identical = 0;
  let judged = 0;
  let discriminated = 0;
  let judgeRan = false;
  for (const group of groups.values()) {
    if (!group.a || !group.b || !group.a.step || !group.b.step) continue;
    pairs += 1;
    const { a, b } = group;
    if (a.step.judgement || b.step.judgement) judgeRan = true;
    if (!asksFollowUp(a.step) || !asksFollowUp(b.step)) continue;
    bothAsked += 1;
    if (normalise(a.step.question) === normalise(b.step.question)) identical += 1;
    if (hasJudgement(a.step) && hasJudgement(b.step)) {
      judged += 1;
      if (a.step.judgement.target === a.gap && b.step.judgement.target === b.gap) discriminated += 1;
    }
  }
  return {
    pairs,
    bothAsked: ratio(bothAsked, pairs),
    identical: ratio(identical, bothAsked),
    // Pairs where a variant got no follow-up count as not discriminating, so judged pairs are compared with all pairs.
    judgedPairs: judged,
    discrimination: judgeRan ? ratio(discriminated, pairs) : ratio(0, 0),
  };
}

/** All adaptive-behaviour numbers for one list of interviews and one list of pair interviews. */
function summarizeAdaptive(transcripts, pairTranscripts = []) {
  const targeting = gapTargeting(transcripts);
  const agreement = consistency(transcripts);
  return {
    gapTargeting: targeting,
    actionAgreement: agreement.action,
    directionAgreement: agreement.direction,
    gamingSkip: gamingSkip(transcripts),
    pairs: discrimination(pairTranscripts),
  };
}

/** Attach `adaptive` to every summary in a `summarizeRun` result (overall, byCase and byProfile). */
function attachAdaptive(results, transcripts, pairTranscripts = []) {
  for (const arm of Object.keys(results)) {
    const mine = transcripts.filter((t) => t.promptVersion === arm);
    const minePairs = pairTranscripts.filter((t) => t.promptVersion === arm);
    results[arm].overall.adaptive = summarizeAdaptive(mine, minePairs);
    for (const caseId of Object.keys(results[arm].byCase)) {
      results[arm].byCase[caseId].adaptive = summarizeAdaptive(
        mine.filter((t) => t.caseId === caseId),
        minePairs.filter((t) => t.caseId === caseId)
      );
    }
    for (const profile of Object.keys(results[arm].byProfile)) {
      results[arm].byProfile[profile].adaptive = summarizeAdaptive(mine.filter((t) => t.profile === profile), []);
    }
  }
  return results;
}

module.exports = {
  summarizeAdaptive, attachAdaptive, gapTargeting, consistency, gamingSkip, discrimination, hitsGap, GAP_LABELS,
};
