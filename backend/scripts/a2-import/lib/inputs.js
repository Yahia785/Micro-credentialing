// Every candidate input of one function in questions.json: the standard and target inputs, the main logic question's input and the
// smaller logic question's input (case 4). The import runs all of them under the sanitizers, so "their code is right" and every follow-up
// input come from the same record.
function candidateInputs(questions, fn) {
  const f = questions.functions[fn];
  const out = [];
  const add = (group, input) => { if (!out.some((x) => x.cmd === input.cmd)) out.push({ ...input, group }); };
  (f.standardInputs || []).forEach((i) => add('standard', i));
  (f.targetInputs || []).forEach((i) => add('target', i));
  if (f.main) add('main', { cmd: f.main.input.cmd, display: f.main.input.display, spec: f.main.spec });
  if (f.small) add('small', { cmd: f.small.input.cmd, display: f.small.input.display, spec: f.small.spec });
  return out;
}

module.exports = { candidateInputs };
