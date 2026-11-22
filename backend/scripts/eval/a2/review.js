#!/usr/bin/env node
// Writes results/questions-review.md for reading: the final question templates, and for each form (A and B) the question every fake
// submission would get. Needs results/harness.json (run run-harness.js first). It writes no scripted student answers.
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const questions = JSON.parse(fs.readFileSync(path.join(ROOT, 'questions.json'), 'utf8'));
const harness = JSON.parse(fs.readFileSync(path.join(ROOT, 'results', 'harness.json'), 'utf8'));
const primary = Object.keys(questions.functions).filter((f) => questions.functions[f].primary);
const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

const fill = (text, values) => Object.entries(values).reduce((t, [k, v]) => t.split(`{${k}}`).join(v), text);
const askedAs = (fn, type, x) => {
  const t = questions.functions[fn][type];
  return type === 'predict' ? fill(t.question, { input: x.display }) : fill(questions.tracingQuestion, { line: x.trace.pauseLine, function: fn, input: x.display, kth: x.trace.kth, what: t.what });
};

let md = '# A2 question review\n\nGenerated from `questions.json` and `results/harness.json` (the local run, GCC 14.2). No scripted student answers.\n\n';
md += '## Part 1. The questions as a student sees them\n\n';
md += 'Each student gets one main question per function. The type rotates by form: **form A** = reverseList predict, splitString tracing, playCraps predict. **form B** = reverseList tracing, splitString predict, playCraps tracing. mode is the backup: it replaces a function that cannot be asked and takes that function\'s type. [INPUT], [K] and [LINE] (the student\'s own breakpoint line) are filled per student.\n\n';
for (const fn of Object.keys(questions.functions)) {
  const f = questions.functions[fn];
  md += `### ${fn}${f.primary ? '' : ' (backup)'}\n\n`;
  md += `**Predict:** ${fill(f.predict.question, { input: '[INPUT]' })}\n\n`;
  md += `**Tracing:** ${fill(questions.tracingQuestion, { line: '[LINE]', function: fn, input: '[INPUT]', kth: '[K]th', what: f.tracing.what })}\n\n`;
  md += `**Fixed follow-up** (after a correct main answer): ${questions.fixedFollowUps[fn].question}\n\nAnswer key: ${questions.fixedFollowUps[fn].answerKey}\n\n`;
}

md += '## Part 2. What each submission would be asked\n\n';
md += 'Columns: the question with the input and K filled in; whether the input is targeted (and why, when it is not); the answer from that submission\'s own code (predict: what it returns or leaves in the vector; tracing: its own trace at the K-th stop, there is no spec answer); the spec answer (predict only).\n\n';
for (const form of ['A', 'B']) {
  const types = questions.forms[form];
  md += `### Form ${form}\n\n`;
  md += `${primary.map((fn) => `${fn} ${types[fn]}`).join(', ')}.\n\n`;
  md += '| submission | function | question | targeted? | trace differs from reference? | answer from the code | spec answer |\n|---|---|---|---|---|---|---|\n';
  for (const r of harness.results) {
    const sub = r.id === 'reference' ? 'reference' : r.short;
    for (const fn of primary) {
      const type = types[fn];
      const x = r.functions[fn];
      const replaced = (type === 'tracing' && !x.trace.available) || (type === 'predict' && !x.input);
      if (replaced) {
        md += `| ${sub} | ${fn} | not asked: ${esc(type === 'tracing' ? x.trace.reason : x.reason)} (replaced by mode below) | | | | |\n`;
        const m = r.functions.mode;
        md += `| ${sub} | mode (replaces ${fn}) | ${esc(`${type}: ${m.input ? askedAs('mode', type, m) : 'no input runs cleanly'}`)} | ${m.targeted ? `yes (${m.bug})` : `no: ${esc(m.reason)}`} | ${differsCell(type, m)} | ${type === 'predict' ? `\`${esc(m.plainOutput)}\`` : m.trace.available ? `\`${esc(m.trace.answer)}\`` : 'no trace'} | ${type === 'predict' ? `\`${esc(m.spec)}\`` : 'none'} |\n`;
        continue;
      }
      const answer = type === 'predict' ? `\`${esc(x.plainOutput)}\`${x.plainOutput === x.spec ? '' : ' (wrong)'}` : `\`${esc(x.trace.answer)}\``;
      md += `| ${sub} | ${fn} | ${esc(`${type}: ${askedAs(fn, type, x)}`)} | ${x.targeted ? `yes (${x.bug})` : `no: ${esc(x.reason.replace(/^standard input: /, ''))}`} | ${differsCell(type, x)} | ${answer} | ${type === 'predict' ? `\`${esc(x.spec)}\`` : 'none'} |\n`;
    }
  }
  md += '\n';
}

function differsCell(type, x) {
  if (type !== 'tracing') return 'n/a';
  return x.trace.available ? (x.trace.differsFromReference ? 'yes' : 'no') : 'n/a';
}

fs.writeFileSync(path.join(ROOT, 'results', 'questions-review.md'), md);
console.log(`wrote results/questions-review.md (${md.length} characters)`);
