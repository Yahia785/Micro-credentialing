#!/usr/bin/env node
/**
 * Compares your hand labels with the Host, the rubric-check judge and the scripted answer.
 *
 *   node scripts/eval/compare-rubric.js eval-results/<run>
 *   node scripts/eval/compare-rubric.js <rubric-check-blind.csv> <rubric-check-key.csv>
 *
 * First fill in the `human_missing` column of rubric-check-blind.csv: for each answer, the rubric items the answer did NOT
 * show, written as ids ("r1 r3"), or "none" when it shows every item. Leave a row empty to skip it. The key file
 * (rubric-check-key.csv) holds what the Host, the judge and the scripted answer said; do not open it before you label.
 *
 * For each of Host vs you, judge vs you and scripted vs you it prints the exact match rate (the two lists are identical)
 * and, per rubric item: agreed (both say missing, or both say shown), missed (you say missing, the other says shown) and
 * wrongly called missing (the other says missing, you say shown).
 */
const fs = require('fs');
const path = require('path');
const { compareWithHuman } = require('./rubric');
const { textTable } = require('./report');

const BLIND_NAME = 'rubric-check-blind.csv';
const KEY_NAME = 'rubric-check-key.csv';

const pct = (r) => (r.rate === null ? 'n/a' : `${(r.rate * 100).toFixed(0)}% (${r.num}/${r.den})`);

/** @returns {string} the report */
function renderComparison(result) {
  const out = [];
  out.push(`Labelled ${result.labelled} of ${result.rows} answers.`);
  if (result.hostBlank) out.push(`${result.hostBlank} labelled answers have no Host check (the Host was not asked), so they are left out of the Host rows.`);
  const names = { host: 'Host vs you', judge: 'Judge vs you', scripted: 'Scripted vs you' };
  const summary = Object.entries(names).map(([key, label]) => [label, result.comparisons[key].n, pct(result.comparisons[key].exact)]);
  out.push('', textTable(['Comparison', 'Answers', 'Exact match'], summary));
  const itemRows = [];
  for (const [key, label] of Object.entries(names)) {
    for (const [id, c] of Object.entries(result.comparisons[key].perItem)) {
      itemRows.push([label, id, c.n, c.agreed, c.missed, c.wronglyMissing]);
    }
  }
  out.push('', 'Per rubric item ("missed": you say missing, it says shown; "wrongly missing": it says missing, you say shown)', '');
  out.push(textTable(['Comparison', 'Item', 'Answers', 'Agreed', 'Missed', 'Wrongly missing'], itemRows));
  return out.join('\n');
}

function main(argv) {
  if (argv.length < 1 || argv.length > 2) throw new Error('Usage: node scripts/eval/compare-rubric.js <run folder> | <blind.csv> <key.csv>');
  let blindFile;
  let keyFile;
  if (argv.length === 1) {
    blindFile = path.join(path.resolve(argv[0]), BLIND_NAME);
    keyFile = path.join(path.resolve(argv[0]), KEY_NAME);
  } else {
    [blindFile, keyFile] = argv.map((f) => path.resolve(f));
  }
  for (const file of [blindFile, keyFile]) if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const result = compareWithHuman(fs.readFileSync(blindFile, 'utf8'), fs.readFileSync(keyFile, 'utf8'));
  if (result.labelled === 0) throw new Error('No row has a human_missing value yet. Fill in the column ("r1 r3" or "none") and run this again.');
  return renderComparison(result);
}

if (require.main === module) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`Failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { main, renderComparison };
