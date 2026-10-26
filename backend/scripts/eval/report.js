/**
 * Writes summary.json, summary.csv and summary.md from the per-prompt summaries.
 */
const fs = require('fs');
const path = require('path');
const { BAD_LABELS } = require('./students');
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
];

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

function toMarkdown({ runId, options, plan, results, notes = [] }) {
  const cols = MD_COLUMNS.map((name) => COLUMNS.find((c) => c[1] === name));
  const cells = (s) => cols.map((c) => c[2](s));
  const out = [];
  out.push(`# Host agent evaluation ${runId}`, '');
  out.push(`Prompts: ${options.prompts.join(', ')} | cases: ${options.cases.join(', ')} | profiles: ${options.profiles.join(', ')} | repeats: ${options.repeats} | ${options.fakeModel ? 'FAKE MODEL (no Bedrock)' : `model: ${options.modelId}`}`, '');
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

function writeReports(outDir, report) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'summary.csv'), toCsv(report.results));
  fs.writeFileSync(path.join(outDir, 'summary.md'), toMarkdown(report));
}

module.exports = { writeReports, toCsv, toMarkdown, COLUMNS };
