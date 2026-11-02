/**
 * Writes summary.json, summary.csv and summary.md from the per-prompt summaries.
 */
const fs = require('fs');
const path = require('path');
const { BAD_LABELS, GAMING_PROFILES } = require('./students');
const { OVERRIDE_TYPES } = require('./metrics');

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
  ['reason_contradiction', 'Reason contradicts action', (s) => frac(s.reasonContradiction), (s) => s.reasonContradiction.rate],
  ['latency_median_ms', 'Latency median (ms)', (s) => ms(s.latencyMs.median), (s) => s.latencyMs.median],
  ['latency_p95_ms', 'Latency p95 (ms)', (s) => ms(s.latencyMs.p95), (s) => s.latencyMs.p95],
  ['input_tokens', 'Input tokens', (s) => s.inputTokens],
  ['output_tokens', 'Output tokens', (s) => s.outputTokens],
  ['estimated_cost_usd', 'Est. cost', (s) => usd(s.estimatedCostUsd), (s) => s.estimatedCostUsd],
  // Adaptive behaviour (n/a when the judge did not run, or the scope has no pair interviews)
  ...[
    ['gap_targeting', 'Gap targeting', (a) => a.gapTargeting.hit],
    ['gap_none', 'Judged generic (none)', (a) => a.gapTargeting.none],
    ['gap_other', 'Judged other', (a) => a.gapTargeting.other],
    ['action_agreement', 'Action agreement', (a) => a.actionAgreement],
    ['direction_agreement', 'Direction agreement', (a) => a.directionAgreement],
    ['discrimination', 'Discrimination', (a) => a.pairs.discrimination],
    ['pairs_both_follow_up', 'Pairs: both got a follow-up', (a) => a.pairs.bothAsked],
    ['pairs_identical', 'Pairs: identical follow-ups', (a) => a.pairs.identical],
    ['gaming_skip', 'Gaming skip', (a) => a.gamingSkip.total],
  ].map(([id, label, pick]) => [
    id, label,
    (s) => (s.adaptive ? frac(pick(s.adaptive)) : 'n/a'),
    (s) => (s.adaptive ? pick(s.adaptive).rate : null),
  ]),
];

// Columns whose raw value is a rate (0 to 1): shown as percentage points when two runs are compared.
const RATE_COLUMNS = new Set([
  'unnecessary_follow_up', 'missed_follow_up', 'missed_vague', 'missed_wrong', 'missed_short', 'missed_idk',
  'overrides', 'fallbacks', 'yes_no', 'multi_part', 'reason_contradiction',
  'gap_targeting', 'gap_none', 'gap_other', 'action_agreement', 'direction_agreement', 'discrimination',
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
  const out = [];
  out.push('## Adaptive behaviour', '');
  out.push('Does the Host follow the answer? The `fixed` arm (when present) asks one fixed question after every main answer, whatever the student said: it is the non-adaptive comparison for every row.', '');
  out.push('- **Gap targeting**: of the follow-ups asked after a weak answer, the share the judge says aim at the gap that answer left open. "Generic" is the share judged as pointing at nothing specific, "other" the share aiming at something that is not a listed gap.');
  out.push('- **Action agreement**: across repeats, how often two runs of the same interview made the same choice (follow-up or move on) after the same main answer. Needs 2 or more repeats.');
  out.push('- **Direction agreement**: across repeats, among follow-ups that were asked, how often they aimed at the same gap.');
  out.push('- **Discrimination**: of the minimal pairs (two weak answers to the same question that leave different gaps), the share where each answer got a follow-up aimed at its own gap.');
  out.push('- **Gaming skip**: main answers from the gaming profiles (keywords, echo, inject) that got no follow-up although one was allowed. Lower is better.', '');
  if (judge) {
    out.push(`Judge: ${judge.model} (${judge.promptVersion}), ${judge.judgements} follow-ups judged, ${judge.unjudged} without a usable judgement, ${judge.calls} calls (${judge.cached} reused), est. cost ${usd(judge.estimatedCostUsd)}.`, '');
  } else {
    out.push('Judge not run (`--judge`): gap targeting, direction agreement and discrimination are n/a.', '');
  }
  if (options.pairs === false) out.push('Minimal pairs were skipped (`--no-pairs`), so discrimination is n/a.', '');
  else out.push(`Minimal-pair interviews run: ${pairInterviews || 0} (they feed only the discrimination columns).`, '');

  const rate = (r) => frac(r);
  out.push('### Overall', '');
  out.push(mdTable(
    ['Arm', 'Gap targeting', 'Generic (none)', 'Other', 'Action agreement', 'Direction agreement', 'Discrimination', 'Pairs: both got a follow-up', 'Pairs: identical follow-ups', 'Gaming skip'],
    arms.map((arm) => {
      const a = ad(arm);
      return [arm, rate(a.gapTargeting.hit), rate(a.gapTargeting.none), rate(a.gapTargeting.other), rate(a.actionAgreement),
        rate(a.directionAgreement), rate(a.pairs.discrimination), rate(a.pairs.bothAsked), rate(a.pairs.identical), rate(a.gamingSkip.total)];
    })
  ), '');

  out.push('### Gap targeting by answer label', '');
  out.push(mdTable(['Arm', ...GAP_LABELS], arms.map((arm) => [arm, ...GAP_LABELS.map((l) => rate(ad(arm).gapTargeting.byLabel[l]))])), '');

  out.push('### Gaming skip by profile', '');
  out.push(mdTable(['Arm', ...GAMING_PROFILES], arms.map((arm) => [arm, ...GAMING_PROFILES.map((p) => rate(ad(arm).gamingSkip.byProfile[p]))])), '');

  const caseIds = [...new Set(arms.flatMap((arm) => Object.keys(results[arm].byCase)))];
  out.push('### By case', '');
  const rows = [];
  for (const caseId of caseIds) {
    for (const arm of arms) {
      const s = results[arm].byCase[caseId];
      if (!s) continue;
      const a = s.adaptive;
      rows.push([caseId, arm, rate(a.gapTargeting.hit), rate(a.actionAgreement), rate(a.directionAgreement), rate(a.pairs.discrimination), rate(a.gamingSkip.total)]);
    }
  }
  out.push(mdTable(['Case', 'Arm', 'Gap targeting', 'Action agreement', 'Direction agreement', 'Discrimination', 'Gaming skip'], rows), '');
  return out;
}

function toMarkdown({ runId, options, plan, results, notes = [], judge = null, pairInterviews = 0 }) {
  const cols = MD_COLUMNS.map((name) => COLUMNS.find((c) => c[1] === name));
  const cells = (s) => cols.map((c) => c[2](s));
  const out = [];
  out.push(`# Host agent evaluation ${runId}`, '');
  out.push(`Prompts: ${options.prompts.join(', ')}${options.baseline ? ` + ${options.baseline} baseline` : ''} | cases: ${options.cases.join(', ')} | profiles: ${options.profiles.join(', ')} | repeats: ${options.repeats} | ${options.fakeModel ? 'FAKE MODEL (no Bedrock)' : `model: ${options.modelId}`}`, '');
  out.push(`Interviews: ${plan.interviews} | model calls: ${plan.actualCalls ?? 'n/a'} | estimated cost: ${usd(plan.actualCostUsd || 0)}`, '');
  if (notes.length) out.push(...notes.map((n) => `- ${n}`), '');

  const prompts = Object.keys(results);
  out.push('## Comparison (overall)', '');
  out.push(mdTable(['Prompt', ...MD_COLUMNS], prompts.map((p) => [p, ...cells(results[p].overall)])), '');

  const caseIds = [...new Set(prompts.flatMap((p) => Object.keys(results[p].byCase)))];
  for (const caseId of caseIds) {
    out.push(`## Comparison: ${caseId}`, '');
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
  return `${out.join('\n')}\n`;
}

/** judge-sample.csv: judged follow-ups for a person to label, to measure how often the judge agrees with a human. */
function toJudgeSampleCsv(items) {
  const header = ['sample_id', 'main_question', 'student_answer', 'gap_list', 'follow_up', 'judge_target', 'judge_reason', 'human_target', 'source'];
  const rows = items.map((item, i) => [
    i + 1,
    item.mainQuestion,
    item.answer,
    item.gaps.map((gap) => `${gap.id}: ${gap.text}`).join(' | '),
    item.followUp,
    item.target,
    item.reason,
    '', // human_target: a gap id from gap_list, "none" or "other"
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
  const header = ['Arm', 'Interviews', 'Unnecessary', 'Missed', 'Overrides', 'Fallbacks', 'Gap target', 'Action agree', 'Discrim.', 'Gaming skip', 'Cost'];
  const rows = arms.map((arm) => {
    const s = report.results[arm].overall;
    const a = s.adaptive;
    return [arm, s.interviews, pct(s.unnecessaryFollowUp), pct(s.missedFollowUp), pct(s.overrides.total), pct(s.fallbacks.total),
      pct(a.gapTargeting.hit), pct(a.actionAgreement), pct(a.pairs.discrimination), pct(a.gamingSkip.total), usd(s.estimatedCostUsd)];
  });
  const lines = [`Summary (${report.runId})`, textTable(header, rows)];
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
