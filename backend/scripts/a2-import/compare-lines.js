#!/usr/bin/env node
// Compares the suggested breakpoint lines (lib/lines.js) with the hand-set pauseLine in each fake submission's meta.json
// (backend/scripts/eval/a2/reference and variants). Prints every disagreement with both lines' text.
//   node scripts/a2-import/compare-lines.js
const fs = require('fs');
const path = require('path');
const { suggestLine } = require('./lib/lines');
const { FUNCTIONS } = require('./lib/common');

const A2 = path.join(__dirname, '..', 'eval', 'a2');
const dirs = [['reference', path.join(A2, 'reference')], ...fs.readdirSync(path.join(A2, 'variants')).filter((d) => /^v\d\d-/.test(d)).sort().map((d) => [d, path.join(A2, 'variants', d)])];

let total = 0;
let sameLine = 0;
let sameVars = 0;
let confident = 0;
const rows = [];
for (const [name, dir] of dirs) {
  const code = fs.readFileSync(path.join(dir, 'functions.cpp'), 'utf8');
  const lines = code.split('\n');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  for (const fn of FUNCTIONS) {
    const hand = meta.interview[fn].tracing;
    const s = suggestLine(code, fn);
    total += 1;
    if (s.status === 'confident') confident += 1;
    const handLine = hand.pauseLine || null;
    const agreeLine = s.status === 'confident' ? s.line === handLine : handLine === null; // no line by hand + manual by pattern agree
    if (agreeLine) sameLine += 1;
    const handVars = hand.variables ? hand.variables.map((v) => v.expr).join(' | ') : '';
    const sugVars = s.variables ? s.variables.map((v) => v.expr).join(' | ') : '';
    const agreeVars = agreeLine && handVars === sugVars;
    if (agreeVars) sameVars += 1;
    if (!agreeLine || !agreeVars) {
      rows.push([
        `${name} ${fn}`,
        handLine ? `hand: line ${handLine}: ${lines[handLine - 1].trim()}  [${handVars}]` : 'hand: no line (unavailable)',
        s.status === 'confident' ? `suggested: line ${s.line}: ${lines[s.line - 1].trim()}  [${sugVars}]` : `suggested: needs manual (${s.reason})`,
      ].join('\n    '));
    }
  }
}
console.log(`${total} functions (reference + variants x 4): suggested line equals the hand-set line (or both have none) on ${sameLine}, same line and same variables on ${sameVars}; confident on ${confident}`);
if (rows.length) console.log(`\nDisagreements:\n${rows.join('\n')}`);
