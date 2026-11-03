/**
 * Writes summary.json, summary.csv and summary.md from the per-prompt summaries.
 */
const fs = require('fs');
const path = require('path');
const { BAD_LABELS, GAMING_PROFILES } = require('./students');
const { OVERRIDE_TYPES } = require('./metrics');
const { evaluateBars } = require('./bars');
const { followUpLines } = require('./followups');
const engine = require('../../shared/nodejs/agent/interview-engine');

const pct = (r) => (r.rate === null ? 'n/a' : `${(r.rate * 100).toFixed(0)}%`);
const frac = (r) => (r.rate === null ? 'n/a' : `${(r.rate * 100).toFixed(0)}% (${r.num}/${r.den})`);
const num = (value, digits = 1) => (value === null || value === undefined ? 'n/a' : Number(value).toFixed(digits));
const ms = (value) => (value === null || value === undefined ? 'n/a' : Math.round(value));
const usd = (value) => `$${value.toFixed(4)}`;

// One table row per scope. Columns are shared by the markdown tables and the CSV.
const COLUMNS = [
  ['interviews', 'Interviews', (s) => s.interviews],
  ['completed', 'Completed', (s) => s.completed],
  ['timed_out', 'Timed out', (s) => s.timedOut],
  ['errored', 'Errored', (s) => s.errored],
  ['questions_per_interview', 'Questions / interview', (s) => num(s.questionsPerInterview), (s) => s.questionsPerInterview],
  ['unnecessary_follow_up', 'Unnecessary follow-up', (s) => frac(s.unnecessaryFollowUp), (s) => s.unnecessaryFollowUp.rate],
  ['missed_follow_up', 'Missed follow-up', (s) => frac(s.missedFollowUp), (s) => s.missedFollowUp.rate],
  ...BAD_LABELS.map((label) => [
    `missed_${label}`, `Missed (${label})`,
    (s) => frac(s.missedFollowUpByLabel[label]), (s) => s.missedFollowUpByLabel[label].rate,
  ]),
  ['overrides', 'Overrides', (s) => frac(s.overrides.total), (s) => s.overrides.total.rate],
  ...OVERRIDE_TYPES.map((type) => [
    `override_${type}`, `Override: ${type}`,
    (s) => s.overrides.byType[type].num, (s) => s.overrides.byType[type].num,
  ]),
  ['fallbacks', 'Fallbacks', (s) => frac(s.fallbacks.total), (s) => s.fallbacks.total.rate],
  ['fallback_invalid_output', 'Invalid output', (s) => s.fallbacks.invalidOutput],
  ['fallback_model_unavailable', 'Model unavailable', (s) => s.fallbacks.modelUnavailable],
  ['fallback_throttled', 'Throttled', (s) => s.fallbacks.throttled],
  ['throttle_retries', 'Throttle retries', (s) => s.fallbacks.throttleRetries],
  ['yes_no', 'Yes/no questions', (s) => frac(s.yesNo), (s) => s.yesNo.rate],
  ['multi_part', 'Multi-part questions', (s) => frac(s.multiPart), (s) => s.multiPart.rate],
  ['own_code_follow_up', 'Follow-up after an ownCode answer', (s) => frac(s.ownCodeFollowUp), (s) => s.ownCodeFollowUp.rate],
  ['guard_fired', 'Two-question guard fired', (s) => frac(s.guard.fired), (s) => s.guard.fired.rate],
  ['guard_fixed', 'Guard: fixed by the rewrite', (s) => frac(s.guard.fixedByRetry), (s) => s.guard.fixedByRetry.rate],
  ['multi_part_guard_off', 'Multi-part (simple check) if the guard were off', (s) => frac(s.guard.multiPartIfOff), (s) => s.guard.multiPartIfOff.rate],
  ['calls_saved', 'Model calls saved (engine decided)', (s) => s.engineDecisions],
  ['hint_rate', 'Follow-ups marked as a hint', (s) => frac(s.hint), (s) => s.hint.rate],
  ['reason_contradiction', 'Reason contradicts action', (s) => frac(s.reasonContradiction), (s) => s.reasonContradiction.rate],
  ['latency_median_ms', 'Latency median (ms)', (s) => ms(s.latencyMs.median), (s) => s.latencyMs.median],
  ['latency_p95_ms', 'Latency p95 (ms)', (s) => ms(s.latencyMs.p95), (s) => s.latencyMs.p95],
  ['input_tokens', 'Input tokens', (s) => s.inputTokens],
  ['output_tokens', 'Output tokens', (s) => s.outputTokens],
  ['estimated_cost_usd', 'Est. cost', (s) => usd(s.estimatedCostUsd), (s) => s.estimatedCostUsd],
  // Adaptive behaviour (n/a when the judge did not run, or the scope has no pair interviews)
  ...[
    ['gap_targeting', 'Gap targeting', (a) => a.gapTargeting.hit],
    ['gap_chance', 'Gap targeting: chance level', (a) => a.gapTargeting.chance, 'pct'],
    ['gap_partial', 'Gap targeting (partial answers)', (a) => a.gapTargeting.partial.hit],
    ['gap_partial_chance', 'Partial answers: chance level', (a) => a.gapTargeting.partial.chance, 'pct'],
    ['gap_none', 'Judged generic (none)', (a) => a.gapTargeting.none],
    ['off_target', 'Targets a gap already shown', (a) => a.gapTargeting.offTarget],
    ['reveals', 'Reveals the answer', (a) => a.followUpChecks.reveals],
    ['two_part_judge', 'Two-part (judge)', (a) => a.followUpChecks.twoPart],
    ['two_part_simple', 'Two-part (simple check, same follow-ups)', (a) => a.followUpChecks.twoPartSimple],
    ['two_part_guard_off', 'Two-part (judge) if the guard were off', (a) => a.followUpChecks.twoPartGuardOff],
    ['beyond_scope', 'Beyond scope', (a) => a.followUpChecks.beyondScope],
    ['action_agreement', 'Action agreement', (a) => a.actionAgreement],
    ['direction_agreement', 'Direction agreement', (a) => a.directionAgreement],
    ['discrimination', 'Discrimination', (a) => a.pairs.discrimination],
    ['discrimination_chance', 'Discrimination: chance level', (a) => a.pairs.discriminationChance, 'pct'],
    ['pairs_both_follow_up', 'Pairs: both got a follow-up', (a) => a.pairs.bothAsked],
    ['pairs_identical', 'Pairs: identical follow-ups', (a) => a.pairs.identical],
    ['gaming_skip', 'Gaming skip', (a) => a.gamingSkip.total],
  ].map(([id, label, pick, style]) => [
    id, label,
    (s) => (s.adaptive ? (style === 'pct' ? pct(pick(s.adaptive)) : frac(pick(s.adaptive))) : 'n/a'),
    (s) => (s.adaptive ? pick(s.adaptive).rate : null),
  ]),
];

// Columns whose raw value is a rate (0 to 1): shown as percentage points when two runs are compared.
const RATE_COLUMNS = new Set([
  'unnecessary_follow_up', 'missed_follow_up', 'missed_vague', 'missed_wrong', 'missed_short', 'missed_idk',
  'overrides', 'fallbacks', 'yes_no', 'multi_part', 'reason_contradiction',
  'gap_targeting', 'gap_chance', 'gap_partial', 'gap_partial_chance', 'gap_none', 'off_target', 'reveals', 'two_part_judge',
  'two_part_simple', 'two_part_guard_off', 'own_code_follow_up', 'guard_fired', 'guard_fixed', 'multi_part_guard_off', 'hint_rate', 'beyond_scope', 'action_agreement', 'direction_agreement', 'discrimination', 'discrimination_chance',
  'pairs_both_follow_up', 'pairs_identical', 'gaming_skip',
]);

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(results) {
  const header = ['prompt', 'scope', 'key', ...COLUMNS.map((c) => c[0])];
  const rows = [header];
  const push = (prompt, scope, key, s) => {
    rows.push([prompt, scope, key, ...COLUMNS.map(([, , text, raw]) => (raw ? raw(s) : text(s)))]);
  };
  for (const [prompt, r] of Object.entries(results)) {
    push(prompt, 'overall', 'all', r.overall);
    Object.entries(r.byCase).forEach(([key, s]) => push(prompt, 'case', key, s));
    Object.entries(r.byProfile).forEach(([key, s]) => push(prompt, 'profile', key, s));
  }
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

function mdTable(header, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

// The columns shown in the markdown tables (the full set is in summary.csv and summary.json).
const MD_COLUMNS = [
  'Interviews', 'Completed', 'Timed out', 'Errored', 'Questions / interview',
  'Unnecessary follow-up', 'Missed follow-up', 'Overrides', 'Fallbacks',
  'Yes/no questions', 'Multi-part questions', 'Reason contradicts action',
  'Latency median (ms)', 'Latency p95 (ms)', 'Est. cost',
];

const GAP_LABELS = [...BAD_LABELS, 'gaming'];

/** The "Adaptive behaviour" section of summary.md, as lines. */
function adaptiveSection({ results, judge, options, pairInterviews }) {
  const arms = Object.keys(results);
  const ad = (arm) => results[arm].overall.adaptive;
  const rate = (r) => frac(r);
  const out = [];
  out.push('## Adaptive behaviour', '');
  const excluded = [...new Set(arms.flatMap((arm) => results[arm].headlineExcludes || []))];
  out.push(`Headline numbers${excluded.length ? ` leave out ${excluded.join(', ')} (its code is reused in the v2/v3 prompt examples; see "By case")` : ''}. Does the Host follow the answer? The \`fixed\` arm (when present) asks one fixed question after every main answer, whatever the student said: it is the non-adaptive comparison for every row. The fixed follow-ups are labelled by the same blind judge, in the same way.`, '');
  out.push('- **Gap targeting**: of the follow-ups asked after an answer that left at least one gap, the share the blind judge says target ANY gap that answer left. **Chance level** is the share a random follow-up (one gap picked at random from the question\'s gaps) would get on exactly the same answers: read the targeting rate against it. An answer that leaves every gap (wrong, short, idk, gaming) has a chance of 100%, so the **partial answers** rows (answers that leave some but not all gaps) are where targeting says the most.');
  out.push('- **Generic (none)**: the share judged as pointing at nothing specific. **Targets a gap already shown**: of all judged follow-ups, the share that ask about a gap the answer did NOT leave (something the student already showed).');
  out.push('- **Action agreement**: across repeats, how often two runs of the same interview made the same choice (follow-up or move on) after the same main answer. Needs 2 or more repeats.');
  out.push('- **Direction agreement**: across repeats, among follow-ups that were asked, how often they aimed at the same gaps.');
  out.push('- **Discrimination**: of the minimal pairs (two weak answers to the same question that leave different gaps), the share where each answer got a follow-up aimed at its own gap and not at the other\'s. Its chance level is what random single-gap follow-ups would get.');
  out.push('- **Gaming skip**: main answers from the gaming profiles (keywords, echo, inject) that got no follow-up although one was allowed. Lower is better.', '');
  if (judge) {
    out.push(`Judge: ${judge.model} (${judge.promptVersion}), ${judge.judgements} follow-ups judged, ${judge.unjudged} without a usable judgement, ${judge.calls} calls (${judge.cached} reused), est. cost ${usd(judge.estimatedCostUsd)}.`, '');
    if (judge.rubricCheck && judge.rubricCheck.answers) {
      const r = judge.rubricCheck;
      out.push(`Rubric check (${r.promptVersion}, separate from the blind judge): ${r.answers} answers checked, ${r.unjudged} without a usable result, ${r.calls} calls (${r.cached} reused), est. cost ${usd(r.estimatedCostUsd)}.`, '');
    }
  } else {
    out.push('Judge not run (`--judge`): gap targeting, the follow-up checks, direction agreement and discrimination are n/a.', '');
  }
  if (options.pairs === false) out.push('Minimal pairs were skipped (`--no-pairs`), so discrimination is n/a.', '');
  else out.push(`Minimal-pair interviews run: ${pairInterviews || 0} (they feed only the discrimination columns).`, '');

  out.push('### Overall', '');
  out.push(mdTable(
    ['Arm', 'Gap targeting', 'Chance level', 'Partial answers', 'Chance (partial)', 'Generic (none)', 'Targets a gap already shown', 'Action agreement', 'Direction agreement', 'Discrimination', 'Chance (discrim.)', 'Pairs: both got a follow-up', 'Pairs: identical follow-ups', 'Gaming skip'],
    arms.map((arm) => {
      const a = ad(arm);
      return [arm, rate(a.gapTargeting.hit), pct(a.gapTargeting.chance), rate(a.gapTargeting.partial.hit), pct(a.gapTargeting.partial.chance),
        rate(a.gapTargeting.none), rate(a.gapTargeting.offTarget), rate(a.actionAgreement), rate(a.directionAgreement),
        rate(a.pairs.discrimination), pct(a.pairs.discriminationChance), rate(a.pairs.bothAsked), rate(a.pairs.identical), rate(a.gamingSkip.total)];
    })
  ), '');

  out.push('### Gap targeting by answer label (targeting / chance level)', '');
  out.push(mdTable(['Arm', ...GAP_LABELS], arms.map((arm) => [arm, ...GAP_LABELS.map((l) => {
    const b = ad(arm).gapTargeting.byLabel[l];
    return `${rate(b.hit)} / ${pct(b.chance)}`;
  })])), '');

  out.push('### Follow-up checks, per prompt version', '');
  out.push('Each judged follow-up is checked for: **reveals the answer** (it states part of the expected answer the student had not said yet), **two-part** (asks two things in one turn; the judge label, and the simple text check on the same follow-ups for comparison) and **beyond scope** (asks about something outside the instructor\'s criteria). Out of the judged follow-ups.', '');
  const checkHeader = ['Judged follow-ups', 'Reveals the answer', 'Two-part (judge)', 'Two-part (simple check)', 'Beyond scope'];
  const checkCells = (c) => [c.judged, rate(c.reveals), rate(c.twoPart), rate(c.twoPartSimple), rate(c.beyondScope)];
  out.push(mdTable(['Arm', ...checkHeader], arms.map((arm) => [arm, ...checkCells(ad(arm).followUpChecks)])), '');

  out.push('### Follow-up checks, per student profile', '');
  const profiles = [...new Set(arms.flatMap((arm) => Object.keys(results[arm].byProfile)))];
  const profileRows = [];
  for (const profile of profiles) {
    for (const arm of arms) {
      const s = results[arm].byProfile[profile];
      if (s && s.adaptive) profileRows.push([profile, arm, ...checkCells(s.adaptive.followUpChecks)]);
    }
  }
  out.push(mdTable(['Profile', 'Arm', ...checkHeader], profileRows), '');

  out.push('### Gaming skip by profile', '');
  out.push(mdTable(['Arm', ...GAMING_PROFILES], arms.map((arm) => [arm, ...GAMING_PROFILES.map((p) => rate(ad(arm).gamingSkip.byProfile[p]))])), '');

  const caseIds = [...new Set(arms.flatMap((arm) => Object.keys(results[arm].byCase)))];
  out.push('### By case', '');
  if (excluded.length) out.push(`${excluded.join(', ')} is not in the headline numbers above; its own rows are here and in its section below.`, '');
  const rows = [];
  for (const caseId of caseIds) {
    for (const arm of arms) {
      const s = results[arm].byCase[caseId];
      if (!s) continue;
      const a = s.adaptive;
      rows.push([caseId, arm, rate(a.gapTargeting.hit), pct(a.gapTargeting.chance), rate(a.gapTargeting.offTarget), rate(a.actionAgreement),
        rate(a.directionAgreement), rate(a.pairs.discrimination), rate(a.gamingSkip.total)]);
    }
  }
  out.push(mdTable(['Case', 'Arm', 'Gap targeting', 'Chance level', 'Targets a gap already shown', 'Action agreement', 'Direction agreement', 'Discrimination', 'Gaming skip'], rows), '');
  return out;
}

/** The "own-code questions" section (empty when none of cases 5, 6, 7 and 9 was run). */
function ownCodeSection(prompts, results) {
  const holders = prompts.filter((p) => results[p].ownCode);
  if (!holders.length) return [];
  const out = [];
  out.push('## Own-code questions: answer vs own code', '');
  out.push('In some tank-controller cases the program of the student differs from the problem statement, and on ONE main question the scripted students answer about their own code, so even the strong answer leaves open the gaps (from the statement) that the bug contradicts: case 5 (`step` returns IDLE between the levels) Q1, gaps g1 and g2; case 6 (`>` instead of `>=`) Q4, g2 and g3; case 7 (ALARM does not stick) Q3, g3; case 9 (a start is counted on every FILLING reading) Q1, g3. Case 8 changes no answer. Below, pooled over the cases that were run: after that main answer, how often the Host asks a follow-up and how often it targets one of those gaps. Case 4 (same questions, correct code, a strong answer leaves no gap) is the comparison.', '');
  out.push(mdTable(
    ['Prompt', 'Own-code questions: answers', 'Follow-up asked', 'Targets the contradicted gaps', 'Strong only: follow-up asked', 'Strong only: targets them', 'Case 4, same questions, strong: follow-up asked', 'Case 4, same questions, strong: targets them'],
    holders.map((p) => {
      const o = results[p].ownCode;
      return [p, o.all.answered, frac(o.all.asked), frac(o.all.targetsMiddle), frac(o.strong.asked), frac(o.strong.targetsMiddle),
        frac(o.comparison.strong.asked), frac(o.comparison.strong.targetsMiddle)];
    })
  ), '');
  return out;
}

/** The "Good enough" bar table: one row per Host arm, pass or fail on each bar. */
function barSection(results) {
  const rows = evaluateBars(results);
  if (!rows.length) return [];
  const mark = (check, text) => {
    if (check.manual) return 'fill in by hand';
    if (check.pass === null) return `n/a${check.note ? ` (${check.note})` : ''}`;
    return `${text} ${check.pass ? 'PASS' : 'FAIL'}`;
  };
  const cell = (check) => {
    if (check.id === 'targeting') {
      const detail = check.pass === null ? '' : `${pct({ rate: check.value })} (fixed ${pct({ rate: check.fixed })}, chance ${pct({ rate: check.chance })})`;
      return mark(check, detail);
    }
    return mark(check, pct({ rate: check.value }));
  };
  const header = ['Arm', ...rows[0].checks.map((c) => `${c.label}: ${c.rule}`), 'Overall'];
  const out = ['## Good-enough bar (headline cases)', ''];
  out.push('One row per Host arm. Each bar is pass or fail on the headline numbers (cases 4 to 9; cases 1, 2 and 3 are left out). A bar that this run cannot measure shows n/a and the overall result says "incomplete". The judge agreement with a human hand-check comes from `compare-rubric.js` and `judge-sample.csv`, filled in by hand.', '');
  out.push(mdTable(header, rows.map((row) => [row.arm, ...row.checks.map(cell), row.overall])), '');
  return out;
}

/** The two-question guard, per arm: how often it fired, how often the rewrite fixed it, and the numbers as if it were off. */
function guardSection(prompts, results) {
  const out = ['## Two-question guard and skipped model calls', ''];
  out.push('When a follow-up asks more than one question (the simple text check), the engine asks the model once to rewrite it as one question; if it still has two, only the first question is kept. "If the guard were off" is what the follow-ups the model first wrote would have scored, so a run can be compared with an older one. When only one action is allowed (the next main question, or end) the engine decides alone and the model is not called: those calls are saved.', '');
  out.push(mdTable(
    ['Arm', 'Follow-ups asked', 'Guard fired', 'Fixed by the rewrite', 'Kept the first question only', 'Multi-part, simple check: guard off', 'Multi-part, simple check: after the guard', 'Two-part, judge: guard off', 'Two-part, judge: after the guard', 'Model calls saved'],
    prompts.map((p) => {
      const s = results[p].overall;
      const f = s.adaptive ? s.adaptive.followUpChecks : null;
      return [p, s.guard.fired.den, frac(s.guard.fired), frac(s.guard.fixedByRetry), frac(s.guard.keptFirst), frac(s.guard.multiPartIfOff), frac(s.guard.multiPartAfter),
        f ? frac(f.twoPartGuardOff) : 'n/a', f ? frac(f.twoPart) : 'n/a', s.engineDecisions];
    })
  ), '');
  return out;
}

/** Invalid host.v4 replies by the check they failed, and the repairs the engine made (host.v4.1, and the yes/no guard). */
function repairSection(prompts, results) {
  const holders = prompts.filter((p) => /^host\.v[4-9]/.test(p) || results[p].overall.fallbacks.invalidOutput > 0);
  if (!holders.length) return [];
  const codes = Object.keys(results[holders[0]].overall.rejected);
  const out = ['## Invalid replies and repairs (host.v4 and later)', ''];
  out.push('Invalid replies by the check they failed, and what the engine repaired before it would have fallen back: **target** (a missing or wrong target was set to the first missing id), **leak rewrite** (a follow-up that repeated rubric wording was rewritten once; fixed = the rewrite passed), **JSON retry** (a reply that was not JSON was asked for again), **yes/no rewrite** (a yes/no follow-up was rewritten once as an open question; if the rewrite is still yes/no the engine falls back).', '');
  out.push(mdTable(['Arm', 'Invalid replies', ...codes], holders.map((p) => {
    const o = results[p].overall;
    return [p, o.fallbacks.invalidOutput, ...codes.map((c) => o.rejected[c])];
  })), '');
  out.push(mdTable(['Arm', 'Target repaired', 'Leak rewrite: fixed', 'JSON retry: fixed', 'Yes/no rewrite: fixed', 'Check retry (host.v5): fixed'], holders.map((p) => {
    const r = results[p].overall.repairs;
    return [p, r.target, frac(r.leakRewrite), frac(r.jsonRetry), frac(r.yesNoRewrite), frac(r.checkRetry)];
  })), '');
  return out;
}

/** host.v5: how well the checker (step A) matches the scripted gaps_left, with no judge involved, and what it cost. */
function checkerSection(prompts, results) {
  const holders = prompts.filter((p) => /^host\.v5/.test(p) && results[p].rubric);
  if (!holders.length) return [];
  const out = ['## Checker of host.v5 (step A) against the scripted gaps', ''];
  out.push('The missing list of the checker on each main answer, compared with the gaps the scripted answer leaves (r1 = g1, ...). No judge is involved. Exact = the two lists are identical. Missed = the checker says shown, the script says missing. False missing = the checker says missing, the script says shown. Invalid checks are replies that failed the evidence check twice (the engine then moved on).', '');
  out.push(mdTable(['Arm', 'Answers checked', 'Exact match', 'Missed items', 'False-missing items', 'Invalid checks', 'Check retried: fixed'], holders.map((p) => {
    const r = results[p].rubric.hostVsScripted;
    const sum = (key) => Object.values(r.perItem).reduce((a, c) => a + c[key], 0);
    const o = results[p].overall;
    return [p, r.n, frac(r.exact), sum('missed'), sum('wronglyMissing'), o.rejected.check_invalid, frac(o.repairs.checkRetry)];
  })), '');
  return out;
}

/** The rubric check of the host.v4 arms: Host vs judge, and both against the scripted gaps_left. */
function rubricSection(prompts, results) {
  const holders = prompts.filter((p) => results[p].rubric);
  if (!holders.length) return [];
  const out = ['## Rubric check (host.v4)', ''];
  out.push('Three parties say which rubric items an answer did not show ("missing"): the **scripted** answer (its gaps_left, r1 = g1, r2 = g2, r3 = g3), the **Host** (host.v4 checks the answer before it chooses; only on answers where the model was asked, so mostly main answers) and the **rubric-check judge** (a separate call that sees the question, the rubric and the answer). Exact match = the two lists are identical. Per item: **agreed** (both say missing, or both say shown), **missed** (the reference says missing, the first one says shown), **wrongly missing** (the first one says missing, the reference says shown). In "A vs B", B is the reference. Headline cases (2 to 5).', '');
  const rows = [];
  const itemRows = [];
  for (const p of holders) {
    const r = results[p].rubric;
    [['Host vs judge', r.hostVsJudge, true], ['Host vs scripted', r.hostVsScripted, true], ['Judge vs scripted', r.judgeVsScripted, true],
      ['Host vs scripted (answers both checked)', r.commonHostVsScripted, false], ['Judge vs scripted (same answers)', r.commonJudgeVsScripted, false]]
      .forEach(([label, t, perItem]) => {
        rows.push([p, label, t.n, frac(t.exact)]);
        if (perItem) Object.entries(t.perItem).forEach(([id, c]) => itemRows.push([p, label, id, c.n, c.agreed, c.missed, c.wronglyMissing]));
      });
  }
  out.push(mdTable(['Arm', 'Comparison', 'Answers', 'Exact match'], rows), '');
  out.push('### Per rubric item', '');
  out.push(mdTable(['Arm', 'Comparison', 'Item', 'Answers', 'Agreed', 'Missed', 'Wrongly missing'], itemRows), '');
  out.push('### Host target accuracy (no judge) next to the judge targeting', '');
  out.push('Of the follow-ups with a target, asked after an answer that left at least one gap: the share whose target is a gap the scripted answer really left. The judge column is the blind judge targeting number (any gap the answer left) for the same arm.', '');
  out.push(mdTable(['Arm', 'Follow-ups with a target', 'After an answer with gaps', 'Host target is a left gap', 'Judge targeting'],
    holders.map((p) => {
      const t = results[p].rubric.hostTarget;
      const a = results[p].overall.adaptive;
      return [p, t.followUps, t.withGaps, frac(t.onTarget), a ? frac(a.gapTargeting.hit) : 'n/a'];
    })), '');
  return out;
}

/** The share of follow-ups that were a hint, per answer profile (host.v4 arms). */
function hintSection(prompts, results) {
  const holders = prompts.filter((p) => engine.usesRubric(String(p).split('@')[0]));
  if (!holders.length) return [];
  const profiles = [...new Set(holders.flatMap((p) => Object.keys(results[p].byProfile)))];
  const out = ['## Hint rate per profile (host.v4)', ''];
  out.push('Follow-ups the Host marked as a hint (a smaller step after "I do not know" or a struggling answer), out of the follow-ups it asked for that profile. Not scored.', '');
  out.push(mdTable(['Arm', ...profiles], holders.map((p) => [p, ...profiles.map((profile) => {
    const s = results[p].byProfile[profile];
    return s ? frac(s.hint) : 'n/a';
  })])), '');
  return out;
}

function toMarkdown({ runId, options, plan, results, notes = [], judge = null, pairInterviews = 0, followUps = {} }) {
  const cols = MD_COLUMNS.map((name) => COLUMNS.find((c) => c[1] === name));
  const cells = (s) => cols.map((c) => c[2](s));
  const out = [];
  out.push(`# Host agent evaluation ${runId}`, '');
  out.push(`Prompts: ${options.prompts.join(', ')}${options.baseline ? ` + ${options.baseline} baseline` : ''} | cases: ${options.cases.join(', ')} | profiles: ${options.profiles.join(', ')} | repeats: ${options.repeats} | ${options.fakeModel ? 'FAKE MODEL (no Bedrock)' : `model: ${options.modelId}`}`, '');
  out.push(`Interviews: ${plan.interviews} | model calls: ${plan.actualCalls ?? 'n/a'} | estimated cost: ${usd(plan.actualCostUsd || 0)}`, '');
  if (notes.length) out.push(...notes.map((n) => `- ${n}`), '');

  const prompts = Object.keys(results);
  const excludedCases = [...new Set(prompts.flatMap((p) => results[p].headlineExcludes || []))];
  out.push(`## Comparison (overall${excludedCases.length ? `, without ${excludedCases.join(', ')}` : ''})`, '');
  out.push(mdTable(['Prompt', ...MD_COLUMNS], prompts.map((p) => [p, ...cells(results[p].overall)])), '');

  out.push(...barSection(results));
  out.push(...guardSection(prompts, results));
  out.push(...repairSection(prompts, results));
  out.push(...checkerSection(prompts, results));
  out.push(...rubricSection(prompts, results));
  out.push(...hintSection(prompts, results));

  const caseIds = [...new Set(prompts.flatMap((p) => Object.keys(results[p].byCase)))];
  for (const caseId of caseIds) {
    out.push(`## Comparison: ${caseId}${excludedCases.includes(caseId) ? ' (not in the headline numbers)' : ''}`, '');
    out.push(mdTable(['Prompt', ...MD_COLUMNS], prompts.filter((p) => results[p].byCase[caseId]).map((p) => [p, ...cells(results[p].byCase[caseId])])), '');
  }

  out.push('## Missed follow-up by answer label', '');
  out.push(mdTable(['Prompt', ...BAD_LABELS], prompts.map((p) => [p, ...BAD_LABELS.map((l) => frac(results[p].overall.missedFollowUpByLabel[l]))])), '');

  out.push('## Overrides by type (count)', '');
  out.push(mdTable(['Prompt', ...OVERRIDE_TYPES], prompts.map((p) => [p, ...OVERRIDE_TYPES.map((t) => results[p].overall.overrides.byType[t].num)])), '');

  out.push('## Model failures', '');
  out.push(mdTable(
    ['Prompt', 'Invalid output', 'Model unavailable', 'Throttled (final)', 'Throttle retries'],
    prompts.map((p) => {
      const f = results[p].overall.fallbacks;
      return [p, f.invalidOutput, f.modelUnavailable, f.throttled, f.throttleRetries];
    })
  ), '');

  out.push(...adaptiveSection({ results, judge, options, pairInterviews }));

  out.push(...ownCodeSection(prompts, results));

  for (const caseId of excludedCases) {
    const holders = prompts.filter((p) => results[p].byCase[caseId]);
    if (!holders.length) continue;
    out.push(`## ${caseId} on its own (left out of the headline numbers)`, '');
    out.push(caseId === 'case1' ? 'Its code and wording are reused in the examples inside the host.v2 and host.v3 prompts, so those prompts are advantaged here. Use these rows to see the effect, not to rank the prompts.' : 'A side check, kept apart from the headline numbers (the tank controller, cases 4 to 9).', '');
    out.push(mdTable(['Prompt', ...MD_COLUMNS], holders.map((p) => [p, ...cells(results[p].byCase[caseId])])), '');
    const rows = holders.map((p) => {
      const a = results[p].byCase[caseId].adaptive;
      return [p, frac(a.gapTargeting.hit), pct(a.gapTargeting.chance), frac(a.gapTargeting.offTarget), frac(a.followUpChecks.reveals),
        frac(a.followUpChecks.twoPart), frac(a.followUpChecks.beyondScope), frac(a.pairs.discrimination), pct(a.pairs.discriminationChance)];
    });
    out.push(mdTable(['Prompt', 'Gap targeting', 'Chance level', 'Targets a gap already shown', 'Reveals the answer', 'Two-part (judge)', 'Beyond scope', 'Discrimination', 'Chance (discrim.)'], rows), '');
  }

  for (const prompt of prompts) {
    const r = results[prompt];
    out.push(`## ${prompt}`, '');
    const rows = [
      ['overall', ...cells(r.overall)],
      ...Object.entries(r.byCase).map(([k, s]) => [`case: ${k}`, ...cells(s)]),
      ...Object.entries(r.byProfile).map(([k, s]) => [`profile: ${k}`, ...cells(s)]),
    ];
    out.push(mdTable(['Scope', ...MD_COLUMNS], rows), '');
  }
  out.push(...followUpLines(followUps));
  return `${out.join('\n')}\n`;
}

/**
 * judge-sample.csv: judged follow-ups for a person to label, to measure how often the judge agrees with a human.
 * The judge never saw student_answer; it is here (with the gaps that answer left) so a person can decide what
 * the student had not said yet. The human_* columns are empty: human_target is a gap id (or several, separated by
 * "+") from gap_list, or "none"; the others are yes or no.
 */
function toJudgeSampleCsv(items) {
  const header = [
    'sample_id', 'main_question', 'student_answer', 'gap_list', 'gaps_left_by_answer', 'follow_up',
    'judge_target', 'judge_reveals', 'judge_two_part', 'judge_beyond_scope', 'judge_reason',
    'human_target', 'human_reveals', 'human_two_part', 'human_scope', 'source',
  ];
  const rows = items.map((item, i) => [
    i + 1,
    item.mainQuestion,
    item.answer,
    item.gaps.map((gap) => `${gap.id}: ${gap.text}`).join(' | '),
    (item.gapsLeft || []).join('+') || 'none',
    item.followUp,
    item.targets.join('+'),
    // the gap ids the follow-up gives away, whether or not the answer left them open
    item.reveals.length ? item.reveals.join('+') : 'none',
    item.twoPart ? 'yes' : 'no',
    item.beyondScope ? 'yes' : 'no',
    item.reason,
    '', // human_target: gap id(s) from gap_list joined with "+", or none
    '', // human_reveals: yes or no (does the follow-up state something the student has not said yet?)
    '', // human_two_part: yes or no
    '', // human_scope: "beyond" if the follow-up asks outside the criteria, "within" otherwise
    item.source || '',
  ]);
  return `${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

/** Plain-text table with padded columns, for the terminal. */
function textTable(header, rows) {
  const widths = header.map((h, i) => Math.max(String(h).length, ...rows.map((row) => String(row[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

/** The table printed at the end of every run: one row per arm. */
function terminalSummary(report) {
  const arms = Object.keys(report.results);
  const header = ['Arm', 'Interviews', 'Unnecessary', 'Missed', 'Overrides', 'Fallbacks', 'Gap target', 'Chance', 'Shown gap', 'Reveals', 'Action agree', 'Discrim.', 'Gaming skip', 'Cost'];
  const rows = arms.map((arm) => {
    const s = report.results[arm].overall;
    const a = s.adaptive;
    return [arm, s.interviews, pct(s.unnecessaryFollowUp), pct(s.missedFollowUp), pct(s.overrides.total), pct(s.fallbacks.total),
      pct(a.gapTargeting.hit), pct(a.gapTargeting.chance), pct(a.gapTargeting.offTarget), pct(a.followUpChecks.reveals), pct(a.actionAgreement),
      pct(a.pairs.discrimination), pct(a.gamingSkip.total), usd(s.estimatedCostUsd)];
  });
  const lines = [`Summary (${report.runId})${Object.values(report.results).some((r) => (r.headlineExcludes || []).length) ? ', without case1' : ''}`, textTable(header, rows)];
  const bars = evaluateBars(report.results);
  if (bars.length) lines.push(`Good-enough bar: ${bars.map((b) => `${b.arm} ${b.overall}`).join(', ')} (details in summary.md)`);
  if (report.judge) {
    lines.push(`Judge ${report.judge.model}: ${report.judge.judgements} follow-ups judged, ${report.judge.unjudged} unusable, est. cost ${usd(report.judge.estimatedCostUsd)}`);
  } else {
    lines.push('n/a columns need --judge (gap target, discrim.) or 2+ repeats (action agree).');
  }
  return lines.join('\n');
}

function writeReports(outDir, report) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'summary.csv'), toCsv(report.results));
  fs.writeFileSync(path.join(outDir, 'summary.md'), toMarkdown(report));
}

module.exports = {
  writeReports, toCsv, toMarkdown, toJudgeSampleCsv, terminalSummary, textTable, COLUMNS, RATE_COLUMNS, frac, pct,
};
