#!/usr/bin/env node
/**
 * Cases 6 to 9: four submissions of the tank controller, each the reference program (cases/tank-controller.cpp) with ONE bug.
 * They share case 4's statement, main questions, rubric and gaps (cases/tank-controller.json). This script writes
 *   cases/tank-controller-gt.cpp, -alarm.cpp, -max.cpp, -count.cpp       the buggy programs (one changed line each)
 *   cases/tank-controller.tests.case6.json ... case9.json                what each buggy program prints for the seven tests
 * There is no compiler here: the outputs come from `simulate` below, a careful transcription of the C++ into JavaScript. Its
 * transcription of the reference program is checked against the stored expected outputs of case 4 before anything is written.
 *
 *   node scripts/eval/build-tank-cases.js           write the files
 *   node scripts/eval/build-tank-cases.js --check   fail if a file on disk differs from what would be written
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'cases');

const VARIANTS = {
  case6: { file: 'tank-controller-gt.cpp', what: 'step uses reading > s.high instead of >= (a reading of exactly 80 does not stop the pump)', from: 'if (reading >= s.high) {', to: 'if (reading > s.high) {' },
  case7: { file: 'tank-controller-alarm.cpp', what: 'step does not check current == ALARM first (ALARM does not stick)', from: ['    if (current == TankState::ALARM) {', '        return TankState::ALARM;', '    }', ''], to: '' },
  case8: { file: 'tank-controller-max.cpp', what: 'isValid uses reading < s.max (rejects exactly max)', from: 'return reading >= 0 && reading <= s.max;', to: 'return reading >= 0 && reading < s.max;' },
  case9: { file: 'tank-controller-count.cpp', what: 'main counts a pump start on every FILLING reading, not only on entering FILLING', from: 'if (next == TankState::FILLING && state != TankState::FILLING) {', to: 'if (next == TankState::FILLING) {' },
};

/** What the program prints for `input` (the reference program for 'case4', otherwise the buggy one). */
function simulate(variant, input) {
  const nums = input.trim().split(/\s+/).map(Number);
  const s = { low: nums[0], high: nums[1], max: nums[2] };
  const isValid = (r) => (variant === 'case8' ? r >= 0 && r < s.max : r >= 0 && r <= s.max);
  const reachesHigh = (r) => (variant === 'case6' ? r > s.high : r >= s.high);
  const step = (current, r) => {
    if (variant !== 'case7' && current === 'ALARM') return 'ALARM';
    if (!isValid(r)) return 'ALARM';
    if (r < s.low) return 'FILLING';
    if (reachesHigh(r)) return 'FULL';
    return variant === 'case5' ? 'IDLE' : current; // case 5 (cases/tank-controller-bug.cpp): the end of step returns IDLE instead of holding the state
  };
  let state = 'IDLE';
  let starts = 0;
  const out = [];
  for (const r of nums.slice(3)) {
    const next = step(state, r);
    if (variant === 'case9' ? next === 'FILLING' : (next === 'FILLING' && state !== 'FILLING')) starts += 1;
    state = next;
    out.push(`${r} -> ${state}`);
  }
  out.push(`Pump starts: ${starts}`);
  return out;
}

/** { [file name]: text } for every file this script writes. Throws if the transcription disagrees with the reference tests. */
function buildFiles() {
  const base = fs.readFileSync(path.join(DIR, 'tank-controller.cpp'), 'utf8');
  const nl = base.includes('\r\n') ? '\r\n' : '\n';
  const tests = JSON.parse(fs.readFileSync(path.join(DIR, 'tank-controller.tests.json'), 'utf8')).tests;
  tests.forEach((t) => {
    if (JSON.stringify(simulate('case4', t.input)) !== JSON.stringify(t.expected)) throw new Error(`The transcription does not reproduce ${t.id} of the reference program`);
  });
  const files = {};
  for (const [id, v] of Object.entries(VARIANTS)) {
    const from = Array.isArray(v.from) ? v.from.join(nl) : v.from;
    if (!base.includes(from)) throw new Error(`${id}: the line to change was not found in tank-controller.cpp`);
    files[v.file] = base.replace(from, v.to);
    const results = tests.map((t) => {
      const expected = simulate(id, t.input);
      return { id: t.id, checks: t.checks, input: t.input, expected, passesStatement: JSON.stringify(expected) === JSON.stringify(t.expected) };
    });
    const failing = results.filter((r) => !r.passesStatement).map((r) => r.id);
    files[`tank-controller.tests.${id}.json`] = `${JSON.stringify({
      note: `Stored for later: nothing runs these yet. ${id}: ${v.what}. The expected lines are what THIS program prints (computed by a hand transcription of the C++ in JavaScript, scripts/eval/build-tank-cases.js; no compiler was run). The lines the statement expects are in tank-controller.tests.json. It fails ${failing.length ? failing.join(', ') : 'none'} of the statement's seven tests.`,
      program: v.file,
      tests: results,
    }, null, 2)}\n`;
  }
  return files;
}

function main(argv = process.argv.slice(2)) {
  const files = buildFiles();
  const check = argv.includes('--check');
  let differs = 0;
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(DIR, name);
    if (check) {
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) { differs += 1; console.error(`differs: ${name}`); }
    } else {
      fs.writeFileSync(file, text);
    }
  }
  if (check && differs) process.exit(1);
  if (!check) console.log(`Wrote ${Object.keys(files).length} files in ${DIR}`);
}

if (require.main === module) main();

module.exports = { VARIANTS, simulate, buildFiles };
