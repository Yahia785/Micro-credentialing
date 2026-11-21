// Rules for choosing the input of a main question, the K of a tracing question and whether a what-if change is allowed.
// Pure functions: no files, no runner. Used by run-all.js and run-harness.js.
const NOT_OK_STATUSES = new Set(['runtime_error', 'time_limit', 'memory_limit', 'compile_error', 'internal_error']);

/** Why an input must never be used (not defined by the spec), or null. Applies to every input in questions.json. */
function undefinedInput(fn, input) {
  const cmd = input.cmd;
  if (fn === 'splitString') {
    const rest = cmd.slice('splitString '.length); // "<delimiter> <string>"
    const delim = rest[0];
    const str = rest.length > 2 ? rest.slice(2) : '';
    if (str.length > 0 && str[str.length - 1] === delim) return 'the string ends with a delimiter (not defined by the spec)';
  }
  if (fn === 'playCraps') {
    const count = cmd.trim().split(/\s+/).length - 1;
    if (count % 2 === 1) return 'an odd number of dice values (not defined by the spec)';
  }
  return null;
}

/** Why an input is not usable as a main question input right now, or null. */
function unusable(fn, input) {
  if (input.unclearSpec) return `unclear spec: ${input.reason || 'depends on the validation reading in SPEC-NOTES.md'}`;
  return undefinedInput(fn, input);
}

const outcome = (run) => {
  if (!run) return { ok: false, why: 'not run' };
  if (run.status && run.status !== 'accepted') return { ok: false, why: run.status };
  return { ok: true };
};

/**
 * Choose the input of the main question for one function.
 * `runs` maps cmd -> { status, stdout } from the student's plain code. The first usable target input where the student's output differs
 * from the spec answer is used (targeted = true). An input where the code crashes, errors or hits the limit is never used. With no such
 * input, the first standard input that runs cleanly is used (targeted = false). `skipped` lists every input passed over, with the reason.
 */
function selectInput({ fn, standardInputs, targetInputs, runs }) {
  const skipped = [];
  for (const input of targetInputs) {
    const bad = unusable(fn, input);
    if (bad) { skipped.push({ cmd: input.cmd, why: bad }); continue; }
    const o = outcome(runs.get(input.cmd));
    if (!o.ok) { skipped.push({ cmd: input.cmd, why: `the code ${o.why === 'runtime_error' ? 'crashes' : o.why === 'time_limit' ? 'hits the time limit' : `did not run cleanly (${o.why})`} on this input` }); continue; }
    if (String(runs.get(input.cmd).stdout).trim() !== String(input.spec).trim()) return { input, targeted: true, bug: input.bug, skipped, reason: `separates this code from the spec (${input.bug})` };
  }
  for (const input of standardInputs) {
    const bad = unusable(fn, input);
    if (bad) { skipped.push({ cmd: input.cmd, why: bad }); continue; }
    const o = outcome(runs.get(input.cmd));
    if (!o.ok) { skipped.push({ cmd: input.cmd, why: `the code ${o.why === 'runtime_error' ? 'crashes' : o.why === 'time_limit' ? 'hits the time limit' : `did not run cleanly (${o.why})`} on this input` }); continue; }
    const crashed = skipped.filter((s) => /crashes|time limit|did not run/.test(s.why));
    const reason = crashed.length
      ? `standard input: no usable target input (${crashed.map((s) => `${s.cmd.replace(/^\S+ ?/, '') || 'empty input'}: ${s.why}`).join('; ')})`
      : 'standard input: no target input separates this code from the spec';
    return { input, targeted: false, skipped, reason };
  }
  return { input: null, targeted: false, skipped, reason: 'no input runs cleanly' };
}

/**
 * Choose K for a tracing question from the student's own stops (array of text, in order). Never a K that does not happen. For a
 * targeted input the first K where the student's stop differs from the reference's stop (or the reference has none) is preferred,
 * because that is where this student's code behaves differently. Otherwise preferredK, or the last stop when there are fewer.
 */
function chooseK({ stops, refStops, preferredK, targeted }) {
  if (!Array.isArray(stops) || stops.length === 0) return null;
  if (targeted && Array.isArray(refStops)) {
    for (let k = 1; k <= stops.length; k += 1) if (refStops[k - 1] !== stops[k - 1]) return k;
  }
  return Math.min(preferredK || 1, stops.length);
}

/** The two what-if rules. plain / whatIf are { status, stdout }; spec is the spec answer (string) of the chosen input. */
function checkWhatIf({ plain, whatIf, spec }) {
  if (!whatIf || whatIf.status !== 'accepted') return { ok: false, reason: `the changed copy did not run cleanly (${whatIf ? whatIf.status : 'not run'})` };
  const a = String(plain.stdout).trim();
  const b = String(whatIf.stdout).trim();
  if (a === b) return { ok: false, reason: 'the change does not alter the output on this input' };
  if (a !== String(spec).trim() && b === String(spec).trim()) return { ok: false, reason: 'the change would fix the student\'s bug (the output becomes the spec answer)' };
  return { ok: true };
}

const ordinal = (k) => `${k}${k % 100 >= 11 && k % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[k % 10] || 'th'}`;

module.exports = { NOT_OK_STATUSES, undefinedInput, unusable, selectInput, chooseK, checkWhatIf, ordinal };
