#!/usr/bin/env node
// Computes the answer keys of the A2 case design (questions.json version 3) by running the REFERENCE in Docker (gcc:13, no network):
//   functions[fn].main.spec / .key    the logic main question (the same for every student)
//   functions[fn].small.spec / .key   the smaller logic question (case 4)
// spec = what the reference prints for the input (used to compare the student's code, like the other inputs); key = the answer a student
// should give to the logic question. For reverseList the key is the number of swaps, counted by instrumenting the reference: the trace
// copy stops at the line that exchanges two positions (left < right, so always two different positions), so its stop count is the swap count.
// For splitString the key is the printed list without the outer brackets. The other keys are the reference's output.
//
//   node scripts/eval/a2/compute-keys.js          (needs Docker running)
const fs = require('fs');
const path = require('path');
const { makeDocker, dockerAvailable } = require('../../a2-import/lib/docker');
const harness = require('../../../shared/nodejs/services/harness-builder');

const ROOT = __dirname;
const FILE = path.join(ROOT, 'questions.json');

/** The key of one logic question from the reference's output (and, for reverseList, its swap count). */
function keyFrom(fn, spec, swaps) {
  if (fn === 'reverseList') return String(swaps);
  if (fn === 'splitString') return spec.replace(/^\[/, '').replace(/\]$/, '');
  return spec;
}

async function main() {
  if (!dockerAvailable()) { console.error('Docker is not running. Start Docker Desktop and run this again.'); process.exit(2); }
  const questions = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const header = fs.readFileSync(path.join(ROOT, 'reference', 'functions.h'), 'utf8');
  const code = fs.readFileSync(path.join(ROOT, 'reference', 'functions.cpp'), 'utf8');
  const driver = fs.readFileSync(path.join(ROOT, 'driver', 'main.cpp'), 'utf8');
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'reference', 'meta.json'), 'utf8'));
  const docker = makeDocker();
  try {
    const plain = harness.buildProgram({ header, studentSource: code, driver });
    const targets = [];
    for (const [fn, f] of Object.entries(questions.functions)) for (const which of ['main', 'small']) if (f[which]) targets.push({ fn, which, cmd: f[which].input.cmd });
    const ran = await docker.runPlain({ source: plain.source, cmds: targets.map((t) => t.cmd) });
    if (!ran.compile.ok) throw new Error('the reference does not compile');
    // the swap count: stops of the reference's trace copy at its swap line (7: the first line of the swap block)
    const t = meta.interview.reverseList.tracing;
    const trace = harness.buildTraceProgram({ header, studentSource: code, driver, pauseLine: t.pauseLine, variables: t.variables });
    const swaps = {};
    const rl = targets.filter((x) => x.fn === 'reverseList');
    const tr = await docker.runPlain({ source: trace.source, cmds: rl.map((x) => x.cmd) });
    rl.forEach((x, i) => { swaps[x.cmd] = harness.parseAllStops(tr.runs[i].stderr, trace.marker).length; });
    targets.forEach((x, i) => {
      const spec = ran.runs[i].stdout.trim();
      const f = questions.functions[x.fn][x.which];
      f.spec = spec;
      f.key = keyFrom(x.fn, spec, swaps[x.cmd]);
      console.log(`${x.fn} ${x.which}: ${x.cmd} -> spec ${spec}; key ${f.key}`);
    });
  } finally { docker.cleanup(); }
  fs.writeFileSync(FILE, `${JSON.stringify(questions, null, 2)}\n`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { keyFrom };
