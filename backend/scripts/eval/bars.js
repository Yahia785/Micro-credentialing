/**
 * The "good enough" bar: the numbers an arm has to reach, on the headline cases (2 to 5), each pass or fail.
 *
 * A bar that cannot be measured in this run (no judge, one repeat, no fixed arm, case 5 not run) is not a fail: it shows as n/a
 * and the arm's overall result says so. The judge agreement with a human hand-check is filled in by hand.
 */
const FIXED_ARM = 'fixed';
const HAND_CHECK = 'fill in by hand';

const BARS = Object.freeze({
  reveals: { max: 0.02 },
  twoPart: { max: 0.05 },
  beyondScope: { max: 0.05 },
  partialAboveFixed: 0.10,
  partialAboveChance: 0.15,
  skipsStrong: { min: 0.85 },
  sameAction: { min: 0.90 },
  case5Middle: { min: 0.60 },
});

const ok = (value, test) => (value === null || value === undefined ? null : test(value));

/** The bars for one arm. `fixedResult` is the fixed-survey arm's summary (the comparison for targeting) or undefined. */
function barsFor(result, fixedResult) {
  const a = result.overall.adaptive;
  const checks = [];
  const add = (id, label, rule, value, pass, extra = {}) => checks.push({ id, label, rule, value, pass, ...extra });

  const reveals = a ? a.followUpChecks.reveals.rate : null;
  add('reveals', 'Reveals the answer', `${BARS.reveals.max * 100}% or fewer`, reveals, ok(reveals, (v) => v <= BARS.reveals.max));

  const twoPart = a ? a.followUpChecks.twoPart.rate : null;
  add('two_part', 'Two-part (judge label, after the guard)', `${BARS.twoPart.max * 100}% or fewer`, twoPart, ok(twoPart, (v) => v <= BARS.twoPart.max));

  const scope = a ? a.followUpChecks.beyondScope.rate : null;
  add('beyond_scope', 'Beyond scope', `${BARS.beyondScope.max * 100}% or fewer`, scope, ok(scope, (v) => v <= BARS.beyondScope.max));

  const hit = a ? a.gapTargeting.partial.hit.rate : null;
  const chance = a ? a.gapTargeting.partial.chance.rate : null;
  const fixedHit = fixedResult && fixedResult.overall.adaptive ? fixedResult.overall.adaptive.gapTargeting.partial.hit.rate : null;
  let targetingPass = null;
  let note = '';
  if (hit === null || chance === null) note = 'needs the judge';
  else if (fixedHit === null) note = 'needs the fixed arm';
  else targetingPass = hit - fixedHit >= BARS.partialAboveFixed - 1e-9 && hit - chance >= BARS.partialAboveChance - 1e-9;
  add('targeting', 'Gap targeting on partial answers', `at least ${BARS.partialAboveFixed * 100} points above the fixed arm and ${BARS.partialAboveChance * 100} above chance`, hit, targetingPass,
    { fixed: fixedHit, chance, note });

  const unnecessary = result.overall.unnecessaryFollowUp.rate;
  const skips = unnecessary === null ? null : 1 - unnecessary;
  add('skips_strong', 'Skips strong answers', `${BARS.skipsStrong.min * 100}% or more`, skips, ok(skips, (v) => v >= BARS.skipsStrong.min - 1e-9));

  const same = a ? a.actionAgreement.rate : null;
  add('same_action', 'Same action on repeats', `${BARS.sameAction.min * 100}% or more`, same, ok(same, (v) => v >= BARS.sameAction.min - 1e-9),
    { note: same === null ? 'needs 2 or more repeats' : '' });

  const middle = result.ownCode ? result.ownCode.all.targetsMiddle.rate : null;
  add('case5_q1', 'Case 5 Q1 follow-ups targeting g1 or g2', `${BARS.case5Middle.min * 100}% or more`, middle, ok(middle, (v) => v >= BARS.case5Middle.min - 1e-9),
    { note: middle === null ? 'needs case 5 and the judge' : '' });

  add('judge_agreement', 'Judge agreement with human hand-check', HAND_CHECK, null, null, { manual: true });

  const measured = checks.filter((c) => !c.manual);
  let overall;
  if (measured.some((c) => c.pass === false)) overall = 'FAIL';
  else if (measured.some((c) => c.pass === null)) overall = 'incomplete';
  else overall = 'PASS';
  return { checks, overall };
}

/** The bar table: one entry per Host arm (the fixed baseline is the comparison, not a candidate). */
function evaluateBars(results) {
  const fixed = results[FIXED_ARM];
  return Object.keys(results).filter((arm) => arm !== FIXED_ARM).map((arm) => ({ arm, ...barsFor(results[arm], fixed) }));
}

module.exports = { evaluateBars, barsFor, BARS, HAND_CHECK, FIXED_ARM };
