/**
 * Adaptive-behaviour metrics: does the Host follow the answer? Same answer should get the same kind
 * of follow-up, a specific weakness should get a follow-up on that weakness, and a strong answer
 * should not get one. The fixed-survey baseline gives the non-adaptive comparison for every number.
 *
 * Input is the saved transcripts (see README.md): the interviews, and the minimal-pair interviews.
 * Judgements are attached to host follow-up turns by the judge step (see judge.js): the blind judge
 * labels the follow-up alone (`targets`, `reveals`, `twoPart`, `beyondScope`) and this file compares those
 * labels with the gaps the scripted answer left open (`step.gaps`). Without judgements the judge-based
 * metrics are n/a.
 */
const { BAD_LABELS } = require('./students');
const { GAMING_LABEL, GAMING_PROFILES } = require('./students');
const { stepsOf, ratio, isMultiPart, headlineOf, armOf } = require('./metrics');
const { NONE } = require('./judge');

const GAP_LABELS = [...BAD_LABELS, GAMING_LABEL];

const asksFollowUp = (step) => step.action === 'follow_up' && !step.fallback;
const hasJudgement = (step) => !!step.judgement && step.judgement.valid;
const actionOf = (step) => (step.action === 'follow_up' ? 'follow_up' : 'move_on');

const isGeneric = (step) => step.judgement.targets.length === 1 && step.judgement.targets[0] === NONE;
/** The gap ids a judged follow-up targets (without "none"). */
const targetedGaps = (step) => step.judgement.targets.filter((id) => id !== NONE);

/** Is the follow-up on target? It targets ANY gap the scripted answer actually left open. */
function hitsGap(step) {
  return targetedGaps(step).some((id) => step.gaps.includes(id));
}

/** Does the follow-up ask about a gap the scripted answer did NOT leave (something the student already showed)? */
function targetsShownGap(step) {
  return targetedGaps(step).some((id) => !step.gaps.includes(id));
}

/**
 * Chance level for one answer: the probability that a follow-up aimed at one gap picked uniformly at
 * random from the question's gaps lands on a gap the answer left open (gaps left / gaps of the question).
 */
const chanceOf = (step) => step.gaps.length / step.gapCount;

/** A mean of probabilities shown like a rate: `num` is the sum of the chances, `den` how many were summed. */
const meanOf = (sumOfChances, count) => ({ num: sumOfChances, den: count, rate: count > 0 ? sumOfChances / count : null });

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

/**
 * How the follow-ups of the interviews matched the gaps the scripted answers left.
 * - hit: of the follow-ups asked after an answer that left at least one gap, the share that target ANY gap it left.
 * - chance: the hit rate a random follow-up (one gap picked uniformly from the question's gaps) would get on
 *   exactly the same answers. An answer that leaves every gap has a chance of 100%: compare hit with chance.
 * - partial: the same two numbers for answers that left some but not all gaps (where a hit says something).
 * - none: the share judged generic. offTarget: of ALL judged follow-ups (also after good answers), the share
 *   that target a gap the answer did not leave, that is, ask about something the student already showed.
 */
function gapTargeting(transcripts) {
  const blank = () => ({ judged: 0, hit: 0, chance: 0 });
  const out = {
    eligible: 0, all: blank(), partial: blank(), none: 0, judgedAny: 0, offTarget: 0,
    byLabel: Object.fromEntries(GAP_LABELS.map((l) => [l, blank()])),
  };
  const add = (bucket, step) => {
    bucket.judged += 1;
    bucket.chance += chanceOf(step);
    if (hitsGap(step)) bucket.hit += 1;
  };
  for (const transcript of transcripts) {
    for (const step of stepsOf(transcript)) {
      if (!asksFollowUp(step) || !step.gapCount) continue;
      if (hasJudgement(step)) {
        out.judgedAny += 1;
        if (targetsShownGap(step)) out.offTarget += 1;
      }
      if (step.gaps.length === 0) continue;
      out.eligible += 1;
      if (!hasJudgement(step)) continue;
      add(out.all, step);
      if (step.gaps.length < step.gapCount) add(out.partial, step);
      if (out.byLabel[step.label]) add(out.byLabel[step.label], step);
      if (isGeneric(step)) out.none += 1;
    }
  }
  return {
    unjudged: out.eligible - out.all.judged,
    judged: out.all.judged,
    hit: ratio(out.all.hit, out.all.judged),
    chance: meanOf(out.all.chance, out.all.judged),
    none: ratio(out.none, out.all.judged),
    partial: { hit: ratio(out.partial.hit, out.partial.judged), chance: meanOf(out.partial.chance, out.partial.judged) },
    offTarget: ratio(out.offTarget, out.judgedAny),
    byLabel: Object.fromEntries(GAP_LABELS.map((l) => [l, {
      hit: ratio(out.byLabel[l].hit, out.byLabel[l].judged),
      chance: meanOf(out.byLabel[l].chance, out.byLabel[l].judged),
    }])),
  };
}

/**
 * Checks on every judged follow-up (the judge's labels, plus the simple text check for comparison):
 * - reveals: the follow-up states part of the expected answer that the student has not said yet, i.e. it
 *   gives away a gap that this answer left open (restating something the student already said is fine).
 * - twoPart (judge, on the follow-up as asked, after the guard), twoPartSimple (the `?` / "and why" text check, on the same
 *   follow-ups) and twoPartGuardOff (the judge's label of the follow-up the model first wrote, where the guard changed it).
 * - beyondScope: asks about something outside the instructor's criteria.
 */
function followUpChecks(transcripts) {
  let judged = 0;
  let reveals = 0;
  let twoPart = 0;
  let twoPartSimple = 0;
  let twoPartGuardOff = 0;
  let beyondScope = 0;
  for (const transcript of transcripts) {
    for (const step of stepsOf(transcript)) {
      if (!asksFollowUp(step) || !hasJudgement(step)) continue;
      judged += 1;
      if (step.judgement.reveals.some((id) => step.gaps.includes(id))) reveals += 1;
      if (step.judgement.twoPart) twoPart += 1;
      // As if the two-question guard were off: where it fired, the judge's label of the follow-up the model first wrote.
      const original = step.guard && step.guard.originalJudgement;
      if (original && original.valid ? original.twoPart : step.judgement.twoPart) twoPartGuardOff += 1;
      if (isMultiPart(step.question)) twoPartSimple += 1;
      if (step.judgement.beyondScope) beyondScope += 1;
    }
  }
  return {
    judged,
    reveals: ratio(reveals, judged),
    twoPart: ratio(twoPart, judged),
    twoPartSimple: ratio(twoPartSimple, judged),
    twoPartGuardOff: ratio(twoPartGuardOff, judged),
    beyondScope: ratio(beyondScope, judged),
  };
}

/** Across repeats of the same interview: same action, and same judged gaps when a follow-up was asked. */
function consistency(transcripts) {
  const actions = new Map();
  const directions = new Map();
  for (const transcript of transcripts) {
    for (const step of stepsOf(transcript)) {
      if (!step.answeredMain || step.fallback) continue;
      const key = [armOf(transcript), transcript.caseId, transcript.profile, step.mainOrdinal].join('|');
      addTo(actions, key, actionOf(step));
      if (step.action === 'follow_up' && hasJudgement(step)) addTo(directions, key, [...step.judgement.targets].sort().join('+'));
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
 * same interview position. The pair discriminates when each variant's follow-up targets its own gap and
 * not the other variant's gap.
 */
function discrimination(pairTranscripts) {
  const groups = new Map();
  for (const transcript of pairTranscripts) {
    const { pairId, side, mainOrdinal } = transcript.pair;
    const key = [armOf(transcript), transcript.caseId, mainOrdinal, pairId, transcript.repeat].join('|');
    if (!groups.has(key)) groups.set(key, {});
    const steps = stepsOf(transcript);
    // the decision after the pair answer
    groups.get(key)[side] = { step: steps[steps.length - 1], gap: transcript.pair.gap, gapCount: transcript.pair.gapCount };
  }

  let pairs = 0;
  let bothAsked = 0;
  let identical = 0;
  let judged = 0;
  let discriminated = 0;
  let judgeRan = false;
  let chance = 0;
  for (const group of groups.values()) {
    if (!group.a || !group.b || !group.a.step || !group.b.step) continue;
    pairs += 1;
    const { a, b } = group;
    if (a.step.judgement || b.step.judgement) judgeRan = true;
    if (a.gapCount && b.gapCount) chance += 1 / (a.gapCount * b.gapCount); // both random follow-ups land on their own gap
    if (!asksFollowUp(a.step) || !asksFollowUp(b.step)) continue;
    bothAsked += 1;
    if (normalise(a.step.question) === normalise(b.step.question)) identical += 1;
    if (hasJudgement(a.step) && hasJudgement(b.step)) {
      judged += 1;
      const ta = targetedGaps(a.step);
      const tb = targetedGaps(b.step);
      if (ta.includes(a.gap) && !ta.includes(b.gap) && tb.includes(b.gap) && !tb.includes(a.gap)) discriminated += 1;
    }
  }
  return {
    pairs,
    bothAsked: ratio(bothAsked, pairs),
    identical: ratio(identical, bothAsked),
    // Pairs where a variant got no follow-up count as not discriminating, so judged pairs are compared with all pairs.
    judgedPairs: judged,
    discrimination: judgeRan ? ratio(discriminated, pairs) : ratio(0, 0),
    // The rate a random follow-up (one gap picked at random for each variant) would get on the same pairs.
    discriminationChance: judgeRan ? meanOf(chance, pairs) : meanOf(0, 0),
  };
}

/**
 * Own-code questions: in some tank-controller cases the student's program differs from the problem statement (case 5: `step`
 * returns IDLE between the levels; case 6: `>` instead of `>=`; case 7: ALARM does not stick; case 9: a start is counted on
 * every FILLING reading), so on ONE main question the scripted students answer about their own code and their answers
 * leave open the gaps (from the statement) that the bug contradicts. Case 8 changes no answer. Per case: the main question
 * (0-based) and the gaps that the bug contradicts. For each, how often the follow-up the Host asks after the main answer
 * targets one of those gaps, for every profile and for the strong profile alone, with case 4's strong answer to the same
 * question (correct code, no gap left) as the comparison. The cases are pooled.
 */
const OWN_CODE_QUESTIONS = Object.freeze({
  case5: { ordinal: 0, gaps: ['g1', 'g2'] },
  case6: { ordinal: 3, gaps: ['g2', 'g3'] },
  case7: { ordinal: 2, gaps: ['g3'] },
  case9: { ordinal: 0, gaps: ['g3'] },
});
const OWN_CODE_COMPARISON = 'case4';

function ownCodeCheck(transcripts) {
  const tally = (cases, profile, asComparison) => {
    let answered = 0;
    let asked = 0;
    let judged = 0;
    let targets = 0;
    for (const [id, q] of Object.entries(OWN_CODE_QUESTIONS)) {
      const caseId = asComparison ? OWN_CODE_COMPARISON : id;
      if (!cases.includes(id)) continue;
      for (const transcript of transcripts) {
        if (transcript.caseId !== caseId || transcript.pair || (profile && transcript.profile !== profile)) continue;
        for (const step of stepsOf(transcript)) {
          if (!step.answeredMain || step.mainOrdinal !== q.ordinal || step.fallback) continue;
          answered += 1;
          if (!asksFollowUp(step)) continue;
          asked += 1;
          if (!hasJudgement(step)) continue;
          judged += 1;
          if (targetedGaps(step).some((gap) => q.gaps.includes(gap))) targets += 1;
        }
      }
    }
    return { answered, asked: ratio(asked, answered), judged, targetsMiddle: ratio(targets, judged) };
  };
  const present = Object.keys(OWN_CODE_QUESTIONS).filter((id) => transcripts.some((t) => t.caseId === id));
  return {
    cases: present,
    all: tally(present),
    strong: tally(present, 'strong'),
    comparison: { caseId: OWN_CODE_COMPARISON, strong: tally(present, 'strong', true) },
  };
}

/** All adaptive-behaviour numbers for one list of interviews and one list of pair interviews. */
function summarizeAdaptive(transcripts, pairTranscripts = []) {
  const agreement = consistency(transcripts);
  return {
    gapTargeting: gapTargeting(transcripts),
    followUpChecks: followUpChecks(transcripts),
    actionAgreement: agreement.action,
    directionAgreement: agreement.direction,
    gamingSkip: gamingSkip(transcripts),
    pairs: discrimination(pairTranscripts),
  };
}

/**
 * Attach `adaptive` to every summary in a `summarizeRun` result: the headline `overall` and `byProfile`
 * leave out the excluded cases (like metrics.summarizeRun), `allCases` and `byCase` do not.
 */
function attachAdaptive(results, transcripts, pairTranscripts = []) {
  for (const arm of Object.keys(results)) {
    const mine = transcripts.filter((t) => armOf(t) === arm);
    const minePairs = pairTranscripts.filter((t) => armOf(t) === arm);
    const onlyExcluded = headlineOf(mine).length === 0;
    const headline = onlyExcluded ? mine : headlineOf(mine);
    const headlinePairs = onlyExcluded ? minePairs : headlineOf(minePairs);
    results[arm].overall.adaptive = summarizeAdaptive(headline, headlinePairs);
    results[arm].allCases.adaptive = summarizeAdaptive(mine, minePairs);
    if (mine.some((t) => OWN_CODE_QUESTIONS[t.caseId])) results[arm].ownCode = ownCodeCheck(mine);
    for (const caseId of Object.keys(results[arm].byCase)) {
      results[arm].byCase[caseId].adaptive = summarizeAdaptive(
        mine.filter((t) => t.caseId === caseId),
        minePairs.filter((t) => t.caseId === caseId)
      );
    }
    for (const profile of Object.keys(results[arm].byProfile)) {
      results[arm].byProfile[profile].adaptive = summarizeAdaptive(headline.filter((t) => t.profile === profile), []);
    }
  }
  return results;
}

module.exports = {
  summarizeAdaptive, attachAdaptive, gapTargeting, followUpChecks, consistency, gamingSkip, discrimination,
  hitsGap, targetsShownGap, chanceOf, ownCodeCheck, GAP_LABELS,
};
