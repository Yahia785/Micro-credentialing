// The reference's answers for every candidate input, computed once (running the reference solution in Docker) and saved with the plans, so
// nothing needs the reference solution at interview time: the spec answer of every input (what the reference prints) and the reference's
// trace stops (used to choose K for targeted tracing questions).
const fs = require('fs');
const path = require('path');
const harness = require('../../../shared/nodejs/services/harness-builder');
const { FUNCTIONS } = require('./common');
const { candidateInputs } = require('./inputs');

const A2 = path.join(__dirname, '..', '..', 'eval', 'a2');

/** Every input of questions.json: [{ function, cmd, display, bug?, unclearSpec?, reason? }]. */
function questionInputs(questions) {
  const out = [];
  for (const fn of FUNCTIONS) {
    for (const input of candidateInputs(questions, fn)) {
      if (out.some((x) => x.cmd === input.cmd)) continue;
      out.push({ function: fn, cmd: input.cmd, display: input.display, group: input.group, bug: input.bug || null, unclearSpec: Boolean(input.unclearSpec), reason: input.reason || null });
    }
  }
  return out;
}

/** @returns {Promise<{ computedAt: string, inputs: Object<string, { function, display, spec, refStops, group, bug, unclearSpec, reason }> }>} */
async function computeReference({ docker, questions, now = () => new Date().toISOString() }) {
  const code = fs.readFileSync(path.join(A2, 'reference', 'functions.cpp'), 'utf8');
  const header = fs.readFileSync(path.join(A2, 'reference', 'functions.h'), 'utf8');
  const driver = fs.readFileSync(path.join(A2, 'driver', 'main.cpp'), 'utf8');
  const meta = JSON.parse(fs.readFileSync(path.join(A2, 'reference', 'meta.json'), 'utf8'));
  const inputs = questionInputs(questions);
  const plain = harness.buildProgram({ header, studentSource: code, driver });
  if (!plain.ok) throw new Error(`reference: ${plain.reason}`);
  const ran = await docker.runPlain({ source: plain.source, cmds: inputs.map((i) => i.cmd) });
  if (!ran.compile.ok) throw new Error('the reference does not compile in Docker');
  const out = {};
  inputs.forEach((input, i) => { out[input.cmd] = { ...input, spec: ran.runs[i].stdout.trim(), refStops: [] }; });
  for (const fn of FUNCTIONS) {
    const t = meta.interview[fn].tracing;
    const built = harness.buildTraceProgram({ header, studentSource: code, driver, pauseLine: t.pauseLine, variables: t.variables });
    if (!built.ok) throw new Error(`reference trace for ${fn}: ${built.reason}`);
    const list = inputs.filter((i) => i.function === fn);
    const res = await docker.runPlain({ source: built.source, cmds: list.map((i) => i.cmd) });
    if (!res.compile.ok) throw new Error(`the reference trace for ${fn} does not compile`);
    list.forEach((input, i) => { out[input.cmd].refStops = harness.parseAllStops(res.runs[i].stderr, built.marker).map((s) => s.text); });
  }
  return { computedAt: now(), inputs: out };
}

module.exports = { computeReference, questionInputs };
