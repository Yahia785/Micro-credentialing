#!/usr/bin/env node
/**
 * Compares the metrics of two result folders side by side, with the difference.
 *
 *   npm run eval:compare -- eval-results/<older> eval-results/<newer>
 *   node scripts/eval/compare.js <folderA> <folderB> [--arm host.v3] [--arm host.v2:host.v3]
 *
 * Each folder has a summary.json. Arms (prompt versions, and `fixed`) with the same name in both
 * folders are compared. If the names differ but each folder has exactly one arm, those two are
 * compared. `--arm name` picks one arm from both folders; `--arm nameA:nameB` picks one from each.
 * Rates are compared in percentage points (pp), other numbers as a plain difference (B minus A).
 */
const fs = require('fs');
const path = require('path');
const { COLUMNS, RATE_COLUMNS, textTable } = require('./report');

// The metrics shown, in order (ids from report.js COLUMNS).
const COMPARE_IDS = [
  'interviews', 'completed', 'timed_out', 'errored', 'questions_per_interview',
  'unnecessary_follow_up', 'missed_follow_up', 'missed_vague', 'missed_wrong', 'missed_short', 'missed_idk',
  'overrides', 'fallbacks', 'yes_no', 'multi_part', 'reason_contradiction',
  'gap_targeting', 'gap_none', 'gap_other', 'action_agreement', 'direction_agreement', 'discrimination',
  'pairs_both_follow_up', 'pairs_identical', 'gaming_skip',
  'latency_median_ms', 'latency_p95_ms', 'estimated_cost_usd',
];

function loadSummary(folder) {
  const file = path.join(folder, 'summary.json');
  if (!fs.existsSync(file)) throw new Error(`No summary.json in ${folder}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pickArms(a, b, armOption) {
  const namesA = Object.keys(a.results);
  const namesB = Object.keys(b.results);
  if (armOption) {
    const [first, second = first] = armOption.split(':');
    if (!namesA.includes(first)) throw new Error(`Folder A has no arm "${first}". It has: ${namesA.join(', ')}`);
    if (!namesB.includes(second)) throw new Error(`Folder B has no arm "${second}". It has: ${namesB.join(', ')}`);
    return [[first, second]];
  }
  const shared = namesA.filter((name) => namesB.includes(name));
  if (shared.length) return shared.map((name) => [name, name]);
  if (namesA.length === 1 && namesB.length === 1) return [[namesA[0], namesB[0]]];
  throw new Error(`The two folders share no arm. A has: ${namesA.join(', ')}. B has: ${namesB.join(', ')}. Use --arm.`);
}

const numberOf = (column, summary) => {
  const [, , text, raw] = column;
  const value = raw ? raw(summary) : text(summary);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

function difference(id, a, b) {
  if (a === null || b === null) return 'n/a';
  const diff = b - a;
  if (RATE_COLUMNS.has(id)) return `${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)} pp`;
  const digits = id === 'estimated_cost_usd' ? 4 : (Number.isInteger(a) && Number.isInteger(b) ? 0 : 2);
  return `${diff >= 0 ? '+' : ''}${diff.toFixed(digits)}`;
}

/**
 * @returns {string} the comparison, one table per pair of arms
 */
function compareSummaries(a, b, { arm } = {}) {
  const out = [`A: ${a.runId} (${a.options.fakeModel ? 'fake model' : a.options.modelId})`, `B: ${b.runId} (${b.options.fakeModel ? 'fake model' : b.options.modelId})`];
  if (a.options.fakeModel !== b.options.fakeModel) out.push('Warning: one run used the fake model and the other the real one.');
  for (const [nameA, nameB] of pickArms(a, b, arm)) {
    const sa = a.results[nameA].overall;
    const sb = b.results[nameB].overall;
    out.push('', nameA === nameB ? `Arm: ${nameA}` : `Arms: ${nameA} (A) vs ${nameB} (B)`);
    const rows = COMPARE_IDS.map((id) => {
      const column = COLUMNS.find((c) => c[0] === id);
      return [column[1], column[2](sa), column[2](sb), difference(id, numberOf(column, sa), numberOf(column, sb))];
    });
    out.push(textTable(['Metric', 'A', 'B', 'B minus A'], rows));
  }
  return out.join('\n');
}

function main(argv) {
  const folders = [];
  let arm;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--arm') {
      if (argv[i + 1] === undefined) throw new Error('--arm needs a value');
      arm = argv[i + 1];
      i += 1;
    } else if (argv[i].startsWith('--')) {
      throw new Error(`Unknown option: ${argv[i]}`);
    } else {
      folders.push(argv[i]);
    }
  }
  if (folders.length !== 2) throw new Error('Usage: npm run eval:compare -- <folderA> <folderB> [--arm name]');
  return compareSummaries(loadSummary(path.resolve(folders[0])), loadSummary(path.resolve(folders[1])), { arm });
}

if (require.main === module) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`Failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { compareSummaries, loadSummary, pickArms, difference, COMPARE_IDS, main };
