// The A2 plan, version 3 (the case design): which question each student gets, the keys, "their code is right", the rotation, and every case
// branch prepared per function. No student data: the code is the reference solution's variants, the runs are a fake Docker.
const fs = require('fs');
const path = require('path');
const lib = '../../../scripts/a2-import/lib';
const { assignForms, decideSlots, renderQuestion, functionState } = require(`${lib}/plan-rules`);
const { buildPlan } = require(`${lib}/plan-build`);
const { renderReview, summarize } = require(`${lib}/plan-review`);
const { questionInputs } = require(`${lib}/reference`);
const { candidateInputs } = require(`${lib}/inputs`);
const { candidateEdits, findWhatIf } = require(`${lib}/what-if`);
const { planForRecord } = require('../../../scripts/a2-import/plan');
const { keyFrom } = require('../../../scripts/eval/a2/compute-keys');

const A2 = path.join(__dirname, '../../../scripts/eval/a2');
const questions = JSON.parse(fs.readFileSync(path.join(A2, 'questions.json'), 'utf8'));
const officialHeader = fs.readFileSync(path.join(A2, 'reference/functions.h'), 'utf8');
const driver = fs.readFileSync(path.join(A2, 'driver/main.cpp'), 'utf8');
const variant = (name) => fs.readFileSync(path.join(A2, 'variants', name, 'functions.cpp'), 'utf8');
const V01 = variant('v01-correct-a');
const V03 = variant('v03-reverse-loop-to-end');
const V10 = variant('v10-split-stub');
const FNS = ['reverseList', 'splitString', 'playCraps', 'mode'];

// the reference's answers from questions.json (spec and refStops are filled in there)
const reference = { inputs: Object.fromEntries(questionInputs(questions).map((i) => {
  const found = candidateInputs(questions, i.function).find((x) => x.cmd === i.cmd);
  return [i.cmd, { ...i, spec: found.spec, refStops: found.refStops || [] }];
})) };

const fnState = (over = {}) => ({ present: true, compiles: true, ...over });
const okRecord = (over = {}) => ({
  importId: 'id-1', githubUsername: 'amy', status: 'ok', headerUsed: 'official', outsideFunctionsError: null, modeNeeded: false,
  functions: { reverseList: fnState(), splitString: fnState(), playCraps: fnState(), mode: fnState() },
  inputs: Object.values(reference.inputs).map((i) => ({ function: i.function, cmd: i.cmd, output: i.spec, matchesSpec: true, unclearSpec: Boolean(i.unclearSpec), excludeFromQuestions: false, excludeReason: null })),
  ...over,
});
/** Set what their code prints on one input (and whether that matches the spec). */
function setOutput(record, cmd, output, extra = {}) {
  const e = record.inputs.find((i) => i.cmd === cmd);
  Object.assign(e, { output, matchesSpec: output === reference.inputs[cmd].spec, ...extra });
  return record;
}

describe('assignForms (the rotation)', () => {
  test('sorted by importId, alternating A, B, A, B; records without code get no form', () => {
    const records = [{ importId: 'c', status: 'ok' }, { importId: 'a', status: 'ok' }, { importId: 'x', status: 'no_version_before_deadline' }, { importId: 'b', status: 'nothing_compiles' }, { importId: 'd', status: 'file_does_not_compile' }];
    const forms = assignForms(records);
    expect([...forms.entries()]).toEqual([['a', 'A'], ['b', 'B'], ['c', 'A'], ['d', 'B']]);
    expect(forms.has('x')).toBe(false);
  });

  test('split evenly, and the types of the two forms are opposite', () => {
    const records = Array.from({ length: 12 }, (_, i) => ({ importId: `i${String(i).padStart(2, '0')}`, status: 'ok' }));
    const counts = [...assignForms(records).values()].reduce((m, f) => ({ ...m, [f]: (m[f] || 0) + 1 }), {});
    expect(counts).toEqual({ A: 6, B: 6 });
    expect(questions.rotation.A).toEqual({ reverseList: 'predict', splitString: 'tracing', playCraps: 'predict' });
    ['reverseList', 'splitString', 'playCraps'].forEach((fn) => expect(questions.rotation.B[fn]).not.toBe(questions.rotation.A[fn]));
  });

  test('the M4 forms and fixed follow-ups are gone from questions.json, with a note', () => {
    expect(questions.version).toBe(3);
    expect(questions).not.toHaveProperty('forms');
    expect(questions).not.toHaveProperty('fixedFollowUps');
    expect(questions.replaced).toContain('Nov 23');
  });
});

describe('the main questions and their keys', () => {
  test('the logic questions are the same for every student, with the keys of the design', () => {
    const f = questions.functions;
    expect(f.reverseList.main.question).toBe('To reverse {1, 2, 3, 4, 5} in place, how many swaps are needed?');
    expect(f.reverseList.main.key).toBe('2');
    expect(f.splitString.main.question).toBe('What does splitString return for ",a,,b" with delimiter \',\'?');
    expect(f.splitString.main.key).toBe('"", "a", "", "b"');
    expect(f.playCraps.main.question).toBe('What does playCraps return for {2, 2, 3, 4}?');
    expect(f.playCraps.main.key).toBe('1');
    expect(f.mode.main.question).toBe('What is the mode of {5, 2, 5, 2, 9}?');
    expect(f.mode.main.key).toBe('2');
  });

  test('the smaller logic questions and their keys (case 4)', () => {
    const f = questions.functions;
    expect([f.reverseList.small.question, f.reverseList.small.key]).toEqual(['To reverse {1, 2, 3} in place, how many swaps are needed?', '1']);
    expect([f.splitString.small.question, f.splitString.small.key]).toEqual(['What does splitString return for ",a" with delimiter \',\'?', '"", "a"']);
    expect([f.playCraps.small.question, f.playCraps.small.key]).toEqual(['What does playCraps return for {3, 4}?', '0']);
    expect([f.mode.small.question, f.mode.small.key]).toEqual(['What is the mode of {2, 5, 2}?', '2']);
  });

  test('keyFrom: the swap count for reverseList, the list without brackets for splitString, the output for the others', () => {
    expect(keyFrom('reverseList', '[5, 4, 3, 2, 1]', 2)).toBe('2');
    expect(keyFrom('splitString', '["", "a", "", "b"]')).toBe('"", "a", "", "b"');
    expect(keyFrom('playCraps', '1')).toBe('1');
  });

  // The keys were computed by running the reference. Check them again with a local compiler when there is one (GXX=... or g++ on PATH).
  const { findCompiler, makeLocalRunBatch } = require('../../../scripts/eval/a2/local-runner');
  const compiler = findCompiler();
  (compiler ? test : test.skip)('the keys are what the reference prints, and the swap count is the stops of the reference\'s swap line', async () => {
    const harness = require('../services/harness-builder');
    const code = fs.readFileSync(path.join(A2, 'reference/functions.cpp'), 'utf8');
    const meta = JSON.parse(fs.readFileSync(path.join(A2, 'reference/meta.json'), 'utf8'));
    const { runBatch } = makeLocalRunBatch({ gxx: compiler.gxx });
    const plain = harness.buildProgram({ header: officialHeader, studentSource: code, driver });
    const t = meta.interview.reverseList.tracing;
    const trace = harness.buildTraceProgram({ header: officialHeader, studentSource: code, driver, pauseLine: t.pauseLine, variables: t.variables });
    for (const fn of FNS) {
      for (const which of ['main', 'small']) {
        const { input, spec, key } = questions.functions[fn][which];
        const [run] = await runBatch([{ source: plain.source, stdin: input.cmd, timeLimitMs: 5000 }]);
        expect(run.stdout.trim()).toBe(spec);
        let swaps;
        if (fn === 'reverseList') {
          const [tr] = await runBatch([{ source: trace.source, stdin: input.cmd, timeLimitMs: 5000 }]);
          swaps = harness.parseAllStops(tr.stderr, trace.marker).length;
        }
        expect(keyFrom(fn, run.stdout.trim(), swaps)).toBe(key);
      }
    }
  });
});

describe('decideSlots', () => {
  const slotsOf = (record, form = 'A') => decideSlots({ record, rotation: questions.rotation[form] });
  const kinds = (r) => r.slots.map((s) => `${s.slot}:${s.function}:${s.kind}:${s.type}`);

  test('every function that compiles gets its logic main question, with the rotation type of its form', () => {
    expect(kinds(slotsOf(okRecord(), 'A'))).toEqual(['reverseList:reverseList:logic:predict', 'splitString:splitString:logic:tracing', 'playCraps:playCraps:logic:predict']);
    expect(kinds(slotsOf(okRecord(), 'B'))).toEqual(['reverseList:reverseList:logic:tracing', 'splitString:splitString:logic:predict', 'playCraps:playCraps:logic:tracing']);
    expect(slotsOf(okRecord()).slots.every((s) => s.followUps)).toBe(true);
  });

  test('mode replaces a function that is completely missing, and takes its place and its rotation type', () => {
    const record = okRecord({ functions: { reverseList: fnState(), splitString: fnState({ present: false, compiles: false }), playCraps: fnState(), mode: fnState() } });
    const a = slotsOf(record, 'A');
    expect(kinds(a)).toEqual(['reverseList:reverseList:logic:predict', 'splitString:mode:logic:tracing', 'playCraps:playCraps:logic:predict']);
    expect(a.slots[1].replaces).toBe('splitString');
    expect(a.notes[0]).toContain('splitString is missing: mode replaces it (tracing)');
    expect(kinds(slotsOf(record, 'B'))[1]).toBe('splitString:mode:logic:predict');
  });

  test('a missing function with a missing mode has no question for the slot', () => {
    const record = okRecord({ functions: { reverseList: fnState(), splitString: fnState({ present: false }), playCraps: fnState(), mode: fnState({ present: false }) } });
    expect(slotsOf(record).slots[1]).toMatchObject({ kind: 'unaskable', function: 'mode', replaces: 'splitString' });
  });

  test('a function that exists but does not compile gets a compile-error question and no follow-ups, never mode', () => {
    const record = okRecord({ status: 'file_does_not_compile', functions: { reverseList: fnState({ compilesAlone: true }), splitString: fnState({ compilesAlone: false, firstError: { line: 23, message: "expected ';'" } }), playCraps: fnState({ compilesAlone: true }), mode: fnState({ compilesAlone: true }) } });
    const r = slotsOf(record, 'A');
    expect(r.slots[1]).toMatchObject({ kind: 'compileError', function: 'splitString', line: 23, message: "expected ';'", followUps: false });
    expect(r.slots[1].replaces).toBeUndefined();
  });

  test('a function that does not compile and has no error line keeps its logic question, with no follow-ups and the reason', () => {
    const record = okRecord({ status: 'file_does_not_compile', functions: { reverseList: fnState({ compilesAlone: true }), splitString: fnState({ compilesAlone: false, firstError: { line: null, message: 'driver.cpp: ambiguous' } }), playCraps: fnState({ compilesAlone: true }), mode: fnState({ compilesAlone: true }) } });
    expect(slotsOf(record).slots[1]).toMatchObject({ kind: 'logic', followUps: false });
    expect(slotsOf(record).slots[1].reason).toContain('no line to point to');
  });

  test('an error outside the functions replaces the first logic question (no follow-ups) and says which function', () => {
    const record = okRecord({ status: 'file_does_not_compile', outsideFunctionsError: { line: 78, message: 'expected primary-expression' }, functions: { reverseList: fnState({ compilesAlone: true }), splitString: fnState({ compilesAlone: true }), playCraps: fnState({ compilesAlone: true }), mode: fnState({ compilesAlone: true }) } });
    const r = slotsOf(record, 'A');
    expect(r.slots[0]).toMatchObject({ kind: 'compileErrorOutside', replacedFunction: 'reverseList', line: 78, followUps: false });
    expect(r.slots[1]).toMatchObject({ kind: 'logic', followUps: true });
    expect(r.notes.join(' ')).toContain('replaces the reverseList question');
  });

  test('nothing compiles: the first function gets a compile-error question, the other two keep their logic main questions with no follow-ups', () => {
    const record = okRecord({ status: 'nothing_compiles', functions: { reverseList: fnState({ compilesAlone: false, firstError: { line: 4, message: 'x' } }), splitString: fnState({ compilesAlone: false }), playCraps: fnState({ compilesAlone: false }), mode: fnState({ compilesAlone: false }) } });
    const r = slotsOf(record, 'B');
    expect(r.slots.map((s) => `${s.function}:${s.kind}:${s.followUps}`)).toEqual(['reverseList:compileError:false', 'splitString:logic:false', 'playCraps:logic:false']);
  });

  test('statuses without code have no plan', () => {
    expect(decideSlots({ record: { status: 'no_version_before_deadline' }, rotation: questions.rotation.A }).noPlan).toContain('no code');
  });

  test('functionState', () => {
    expect(functionState(okRecord(), 'mode')).toBe('compiles');
    expect(functionState({ status: 'file_does_not_compile', functions: { mode: { present: true, compilesAlone: false } } }, 'mode')).toBe('compileError');
    expect(functionState({ status: 'ok', functions: { mode: { present: false } } }, 'mode')).toBe('missing');
  });
});

describe('the question texts', () => {
  test('main, small, case 3, debug, change, what-if, tracing, predict and compile errors, exactly as the student sees them', () => {
    expect(renderQuestion(questions, 'main', { function: 'playCraps' })).toBe('What does playCraps return for {2, 2, 3, 4}?');
    expect(renderQuestion(questions, 'small', { function: 'reverseList' })).toBe('To reverse {1, 2, 3} in place, how many swaps are needed?');
    expect(renderQuestion(questions, 'case3', { function: 'reverseList' })).toBe('How many swaps does your reverseList make on {1, 2, 3, 4, 5}?');
    expect(renderQuestion(questions, 'case3', { function: 'splitString' })).toBe('What does your splitString return for ",a,,b" with delimiter \',\'?');
    expect(renderQuestion(questions, 'debug', { function: 'reverseList', output: '[3, 5, 8]', display: 'the vector {3, 5, 8}', spec: '[8, 5, 3]' })).toBe('Your reverseList returns [3, 5, 8] for the vector {3, 5, 8}. Why does it give that instead of [8, 5, 3]?');
    expect(renderQuestion(questions, 'change', {})).toBe('Which line would you change, and how?');
    expect(renderQuestion(questions, 'whatIf', { function: 'reverseList', line: 5, oldLine: 'int right = n - 1;', newLine: 'int right = n - 2;', display: 'the vector {1, 2, 3}' }))
      .toBe('Suppose line 5 of your reverseList were changed from `int right = n - 1;` to `int right = n - 2;`. With that change, what would the vector hold after your reverseList runs on the vector {1, 2, 3}?');
    expect(renderQuestion(questions, 'predict', { function: 'splitString', display: 'the string "a,b" with delimiter \',\'' })).toBe('What does your splitString return for the string "a,b" with delimiter \',\'?');
    expect(renderQuestion(questions, 'tracing', { function: 'reverseList', line: 7, display: 'the vector {1, 2, 3}', k: 2 })).toBe('You put a breakpoint on line 7 and run reverseList on the vector {1, 2, 3}. When it stops for the 2nd time, which two numbers are about to be swapped?');
    expect(renderQuestion(questions, 'compileError', { function: 'splitString', line: 23 })).toBe("Your splitString doesn't compile. The compiler points to line 23. What is wrong on that line, and how would you fix it?");
    expect(renderQuestion(questions, 'compileErrorOutside', { line: 78 })).toBe("Your code doesn't compile. The compiler points to line 78. What is wrong on that line, and how would you fix it?");
    expect(questions.clarify).toBe('Can you give the exact result?');
  });
});

// A fake docker. A trace program prints three stops (and the same output as the plain run); a changed copy (what-if) prints `changed <cmd>`
// unless `whatIf` says otherwise. Nothing else is run for a plan.
function fakeDocker({ compileFails = () => false, whatIf = (cmd) => ({ code: 0, stdout: `changed ${cmd}\n`, san: { code: 0, stderr: '' } }) } = {}) {
  return {
    runPlain: jest.fn(async ({ source, cmds }) => {
      if (compileFails(source)) return { compile: { ok: false, errors: 'error' }, runs: [] };
      const marker = (/@@TRACE-[0-9a-f]+@@/.exec(source) || [])[0];
      if (!marker) throw new Error('a plan must not run a plain copy');
      return { compile: { ok: true }, runs: cmds.map((cmd) => ({ code: 0, stdout: `${reference.inputs[cmd].spec}\n`, stderr: `${marker}\t1\ta=1\n${marker}\t2\ta=2\n${marker}\t3\ta=3\n` })) };
    }),
    runInputs: jest.fn(async ({ cmds }) => ({
      sanCompile: { ok: true }, plainCompile: { ok: true },
      runs: cmds.map((cmd) => { const r = whatIf(cmd); return { san: r.san, plain: { code: r.code, stdout: r.stdout } }; }),
    })),
    cleanup: jest.fn(),
  };
}
const build = (over) => buildPlan({ record: okRecord(), code: V01, studentHeader: null, form: 'A', assets: { officialHeader, driver, questions }, reference, docker: fakeDocker(), ...over });

describe('codeRight', () => {
  test('true when their code gives the spec answer on every safe candidate input', async () => {
    const plan = await build();
    plan.questions.forEach((q) => expect(q).toMatchObject({ kind: 'logic', codeRight: true, codeRightFailing: [] }));
    expect(plan.questions[0].codeRightChecked).toBe(candidateInputs(questions, 'reverseList').length);
  });

  test('false when one safe input differs, and it names that input', async () => {
    const record = setOutput(okRecord(), 'reverseList 3 5 8', '[3, 5, 8]');
    const plan = await build({ record, code: V03 });
    expect(plan.questions[0]).toMatchObject({ codeRight: false, codeRightFailing: ['reverseList 3 5 8'] });
    expect(plan.questions[1].codeRight).toBe(true);
  });

  test('inputs excluded by the sanitizer, unclear-spec inputs and inputs the spec does not define do not count', async () => {
    const record = okRecord();
    setOutput(record, 'reverseList 3 5 8', '[3, 5, 8]', { excludeFromQuestions: true, excludeReason: 'sanitizer: sanitizer' });
    setOutput(record, 'playCraps 3 4 7 1', '9', { unclearSpec: true });
    setOutput(record, 'splitString , ,apple,banana,orange', 'x');
    record.inputs.find((i) => i.cmd === 'splitString , ,apple,banana,orange').matchesSpec = false;
    const plan = await build({ record, code: V01 });
    expect(plan.questions[0].codeRight).toBe(true);
    expect(plan.questions[0].codeRightChecked).toBe(candidateInputs(questions, 'reverseList').length - 1);
    expect(plan.questions[2].codeRight).toBe(true);
    // the spec-defined input that differs does count
    expect(plan.questions[1].codeRight).toBe(false);
  });

  test('null when no input ran cleanly: nothing is known, so no case 1 or 3', async () => {
    const record = okRecord();
    record.inputs.filter((i) => i.function === 'reverseList').forEach((i) => { i.excludeFromQuestions = true; });
    const plan = await build({ record });
    expect(plan.questions[0].codeRight).toBeNull();
    expect(plan.questions[0].cases.case1.available).toBe(false);
    expect(plan.questions[0].cases.case3.available).toBe(false);
    expect(plan.questions[0].cases.case2.available).toBe(false); // no safe input shows a difference
    expect(plan.questions[0].cases.case4.available).toBe(true); // the smaller logic question needs no run
  });
});

describe('the rotation and case 1', () => {
  test('form A: predict, tracing, predict; form B: the opposite. Follow-up 1 is on a standard or edge input that is not the main input', async () => {
    const a = await build({ form: 'A' });
    const b = await build({ form: 'B' });
    expect(a.questions.map((q) => q.cases.case1.followUp1.type)).toEqual(['predict', 'tracing', 'predict']);
    expect(b.questions.map((q) => q.cases.case1.followUp1.type)).toEqual(['tracing', 'predict', 'tracing']);
    for (const q of [...a.questions, ...b.questions]) {
      const f = q.cases.case1.followUp1;
      expect(f.input.cmd).not.toBe(q.mainInput.cmd);
      expect(['standard', 'target']).toContain(reference.inputs[f.input.cmd].group);
    }
  });

  test('predict: the question from the function\'s template, the answer is their own output', async () => {
    const plan = await build({ form: 'A' });
    const f = plan.questions[0].cases.case1.followUp1;
    expect(f).toMatchObject({ type: 'predict', answerType: 'code', answer: '[50, 40, 30, 20, 10]', text: 'What would the vector hold after your reverseList runs on the vector {10, 20, 30, 40, 50}?' });
  });

  test('tracing: names the line, K is a real stop, the answer is their own trace, with the flag against the reference', async () => {
    const plan = await build({ form: 'A' });
    const f = plan.questions[1].cases.case1.followUp1;
    expect(f).toMatchObject({ type: 'tracing', k: 2, totalStops: 3, answer: 'a=2', answerType: 'code', traceDiffersFromReference: true });
    expect(f.text).toMatch(/^You put a breakpoint on line \d+ and run splitString on the string "a,b,c" with delimiter ','\. When it stops for the 2nd time, what piece is about to be added\?$/);
    expect(f.lineText).toContain('parts.push_back(current);');
    expect(f.variables).toEqual([{ name: 'piece', expr: 'current' }]);
  });

  test('follow-up 2 is a what-if that shows the whole old and new line, with the answer from the changed copy', async () => {
    const plan = await build({ form: 'A' });
    const f = plan.questions[0].cases.case1.followUp2;
    expect(f).toMatchObject({ type: 'whatIf', answerType: 'code', answer: expect.stringMatching(/^changed reverseList /) });
    expect(f.text).toBe(`Suppose line ${f.line} of your reverseList were changed from \`${f.oldLine}\` to \`${f.newLine}\`. With that change, what would the vector hold after your reverseList runs on ${f.input.display}?`);
    expect(f.oldLine).not.toBe(f.newLine);
    expect(V01.split('\n')[f.line - 1].trim()).toBe(f.oldLine);
    expect(plan.questions[0].cases.case1.followUp2.theirOutputBeforeTheChange).toBe(reference.inputs[f.input.cmd].spec);
  });

  test('with no safe what-if, follow-up 2 is the other type, and says why', async () => {
    const docker = fakeDocker({ whatIf: () => ({ code: 0, stdout: '[50, 40, 30, 20, 10]\n', san: { code: 0, stderr: 'ERROR: AddressSanitizer: heap-buffer-overflow' } }) });
    const plan = await build({ form: 'A', docker });
    const [q1, q2] = plan.questions;
    expect(q1.cases.case1.followUp2).toMatchObject({ type: 'tracing', whatIfSkipped: expect.stringContaining('sanitizer') });
    expect(q2.cases.case1.followUp2).toMatchObject({ type: 'predict', whatIfSkipped: expect.any(String) });
    // the what-if was not used, and nothing the sanitizer rejected is in the plan
    plan.questions.forEach((q) => expect(q.cases.case1.followUp2.type).not.toBe('whatIf'));
  });

  test('a tracing line that needs manual (and has no override) changes follow-up 1 to predict and says why; follow-up 2 then cannot be tracing', async () => {
    const docker = fakeDocker({ whatIf: () => ({ code: 0, stdout: 'same\n', san: { code: 0, stderr: '' } }) });
    const plan = await build({ form: 'A', code: V10, docker });
    const c1 = plan.questions[1].cases.case1;
    expect(c1.followUp1).toMatchObject({ type: 'predict', typeChanged: { from: 'tracing', to: 'predict', reason: expect.stringContaining('needs manual') } });
    expect(plan.log.join(' ')).toContain('splitString: follow-up 1 changed from tracing to predict');
  });

  test('an override sets the line, the variables and K, and is applied again on a re-run', async () => {
    const overrides = { reverseList: { pauseLine: 7, variables: [{ name: 'left number', expr: 'vec[left]' }, { name: 'right number', expr: 'vec[right]' }], k: 1 } };
    const first = await build({ form: 'B', overrides });
    const f = first.questions[0].cases.case1.followUp1;
    expect(f).toMatchObject({ type: 'tracing', line: 7, k: 1, overridden: true });
    expect(f.text).toContain('line 7');
    const again = await build({ form: 'B', overrides });
    expect(again.questions[0].cases.case1.followUp1).toMatchObject({ line: 7, k: 1 });
    const bad = await build({ form: 'B', overrides: { reverseList: { pauseLine: 1, variables: [{ name: 'x', expr: 'vec[0]' }] } } });
    expect(bad.questions[0].cases.case1.followUp1.typeChanged.reason).toContain('refused');
    const tooBig = await build({ form: 'B', overrides: { reverseList: { k: 9 } } });
    expect(tooBig.questions[0].cases.case1.followUp1.typeChanged.reason).toContain('K=9');
  });

  test('a trace that changes the program\'s output is a system error and changes the type', async () => {
    const docker = fakeDocker();
    const real = docker.runPlain.getMockImplementation();
    docker.runPlain.mockImplementation(async (args) => { const r = await real(args); r.runs.forEach((x) => { x.stdout = 'different\n'; }); return r; });
    const plan = await build({ form: 'A', docker });
    expect(plan.questions[1].cases.case1.followUp1.typeChanged.reason).toContain('instrumentation changed behavior');
  });

  test('mode replaces a missing function with its own answers and the type of the function it replaces', async () => {
    const record = okRecord({ functions: { reverseList: fnState(), splitString: fnState({ present: false, compiles: false }), playCraps: fnState(), mode: fnState() } });
    const plan = await build({ record, form: 'A' });
    expect(plan.questions[1]).toMatchObject({ slot: 'splitString', function: 'mode', replaces: 'splitString', kind: 'logic', text: 'What is the mode of {5, 2, 5, 2, 9}?', answerKey: '2' });
    expect(plan.questions[1].cases.case1.followUp1.type).toBe('tracing');
    expect(plan.questions[1].cases.case1.followUp1.text).toContain('run mode on');
  });
});

describe('case 2: logic right, their code wrong', () => {
  const wrongReverse = () => setOutput(okRecord(), 'reverseList 3 5 8', '[3, 5, 8]');

  test('follow-up 1 shows their output and the spec answer on a safe target input where they disagree; follow-up 2 asks which line to change', async () => {
    const plan = await build({ record: wrongReverse(), code: V03 });
    const c2 = plan.questions[0].cases.case2;
    expect(c2.available).toBe(true);
    expect(c2.followUp1).toMatchObject({ type: 'debug', theirOutput: '[3, 5, 8]', specAnswer: '[8, 5, 3]', targeted: true, bug: 'v03', answerType: 'code' });
    expect(c2.followUp1.text).toBe('Your reverseList returns [3, 5, 8] for the vector {3, 5, 8}. Why does it give that instead of [8, 5, 3]?');
    expect(c2.followUp2).toMatchObject({ type: 'change', text: 'Which line would you change, and how?' });
    // cases 1 and 3 are not possible for this function
    expect(plan.questions[0].cases.case1.available).toBe(false);
    expect(plan.questions[0].cases.case3.available).toBe(false);
  });

  test('an input excluded by the sanitizer is never the debug input: the next input where they disagree is used', async () => {
    const record = wrongReverse();
    setOutput(record, 'reverseList 3 5 8', '[3, 5, 8]', { excludeFromQuestions: true, excludeReason: 'sanitizer: sanitizer' });
    setOutput(record, 'reverseList 1 2 3 4', '[1, 2, 3, 4]');
    const plan = await build({ record, code: V03 });
    expect(plan.questions[0].cases.case2.followUp1).toMatchObject({ theirOutput: '[1, 2, 3, 4]', targeted: false });
    expect(plan.questions[0].cases.case2.followUp1.input.cmd).toBe('reverseList 1 2 3 4');
  });
});

describe('case 3: logic wrong, their code right', () => {
  test('follow-up 1 asks what their code gives on the main input; the answer is their own output; follow-up 2 is the smaller code step', async () => {
    const plan = await build({ form: 'A' });
    const [rev, split, craps] = plan.questions.map((q) => q.cases.case3);
    expect(split.followUp1).toMatchObject({ type: 'predict', text: 'What does your splitString return for ",a,,b" with delimiter \',\'?', answer: '["", "a", "", "b"]', answerBasis: 'their output on the main input', answerType: 'code' });
    expect(craps.followUp1).toMatchObject({ text: 'What does your playCraps return for {2, 2, 3, 4}?', answer: '1' });
    // reverseList asks for swaps: the number of times their swap line runs on the main input (3 stops in the fake)
    expect(rev.followUp1).toMatchObject({ text: 'How many swaps does your reverseList make on {1, 2, 3, 4, 5}?', answer: '3', answerBasis: expect.stringContaining('runs 3 times') });
    expect(rev.followUp2).toMatchObject({ type: 'smallStep', agentWritten: true });
  });

  test('when the main input did not run cleanly, follow-up 1 says so instead of guessing', async () => {
    const record = okRecord();
    const main = record.inputs.find((i) => i.cmd === 'playCraps 2 2 3 4');
    Object.assign(main, { excludeFromQuestions: true, excludeReason: 'sanitizer: sanitizer' });
    const plan = await build({ record });
    expect(plan.questions[2].cases.case3.followUp1.unavailable).toContain('main input did not run cleanly');
  });
});

describe('case 4: logic wrong, their code wrong', () => {
  test('follow-up 1 is the smaller logic question with its key from the reference; follow-up 2 is the smaller code step', async () => {
    const plan = await build({ record: setOutput(okRecord(), 'splitString , a,b,c', '["a", "b"]'), code: V01 });
    const c4 = plan.questions[1].cases.case4;
    expect(c4.available).toBe(true);
    expect(c4.followUp1).toMatchObject({ type: 'smallLogic', text: 'What does splitString return for ",a" with delimiter \',\'?', answerKey: '"", "a"', answerType: 'logic' });
    expect(c4.followUp2).toMatchObject({ type: 'smallStep', agentWritten: true });
    expect(plan.questions[1].cases.case3.available).toBe(false);
  });
});

describe('the smaller-step material is private', () => {
  test('real variable names and their values at the breakpoint line on the main input, stop by stop, marked private', async () => {
    const plan = await build({ form: 'A' });
    const m = plan.questions[1].cases.case3.followUp2.material;
    expect(m).toMatchObject({ private: true, available: true, input: { cmd: 'splitString , ,a,,b' }, variables: [{ name: 'piece', expr: 'current' }], stops: ['a=1', 'a=2', 'a=3'] });
    expect(m.forAgentOnly).toContain('student never sees');
    expect(m.lineText).toContain('parts.push_back(current);');
  });

  test('is never inside a question text, and the review says it is private', async () => {
    const plan = await build({ form: 'A' });
    const texts = [];
    const collect = (c) => ['followUp1', 'followUp2'].forEach((k) => { if (c[k] && c[k].text) texts.push(c[k].text); });
    plan.questions.forEach((q) => { texts.push(q.text); Object.values(q.cases).forEach(collect); });
    const material = plan.questions.flatMap((q) => [q.cases.case3.followUp2.material, q.cases.case4.followUp2 && q.cases.case4.followUp2.material]).filter(Boolean);
    expect(material.length).toBeGreaterThan(0);
    material.forEach((m) => expect(m.private).toBe(true));
    material.filter((m) => m.available).forEach((m) => m.stops.forEach((s) => texts.forEach((t) => expect(t).not.toContain(s))));
    expect(renderReview([plan])).toContain('Private material, never shown to the student');
  });

  test('says why there is none when the line cannot be found', async () => {
    const plan = await build({ form: 'A', code: V10 });
    expect(plan.questions[1].cases.case3.followUp2.material).toMatchObject({ private: true, available: false, reason: expect.stringContaining('needs manual') });
  });
});

describe('never reveal outside case 2', () => {
  const textsOf = (plan) => plan.questions.flatMap((q) => ['case1', 'case3', 'case4'].flatMap((name) => ['followUp1', 'followUp2'].map((k) => ({ q, name, f: q.cases[name][k] }))).filter(({ f }) => f && f.text));
  const without = (text, display) => String(text).split(display).join('');

  test('no follow-up of cases 1, 3 and 4 states the main answer, the spec answer or the code\'s output (the input itself may be shown)', async () => {
    const record = setOutput(okRecord(), 'splitString , a,b,c', '["a", "b"]');
    for (const plan of [await build({ form: 'A' }), await build({ form: 'B' }), await build({ form: 'A', record, code: V01 })]) {
      for (const { q, f } of textsOf(plan)) {
        const text = without(f.text, f.input.display);
        const secrets = [q.answerKey, f.answer, f.specAnswer, f.theirOutputBeforeTheChange].filter((s) => typeof s === 'string' && s.length >= 3);
        secrets.forEach((secret) => expect(text).not.toContain(secret));
      }
    }
  });

  test('case 2 is the only branch whose text shows their output and the spec answer', async () => {
    const plan = await build({ record: setOutput(okRecord(), 'reverseList 3 5 8', '[3, 5, 8]'), code: V03 });
    const debug = plan.questions[0].cases.case2.followUp1;
    expect(debug.text).toContain(debug.theirOutput);
    expect(debug.text).toContain(debug.specAnswer);
    for (const name of ['case1', 'case3', 'case4']) {
      for (const k of ['followUp1', 'followUp2']) {
        const f = plan.questions[0].cases[name][k];
        if (f && f.text) { expect(f.text).not.toContain(debug.specAnswer); expect(f.text).not.toContain(debug.theirOutput); }
      }
    }
    // the main question never carries an answer
    plan.questions.forEach((q) => expect(without(q.text, q.mainInput.display)).not.toContain(q.answerKey.length >= 3 ? q.answerKey : '\u0000'));
  });
});

describe('compile groups', () => {
  test('a function that does not compile gets the compile-error question with the compiler message as the answer key and no follow-ups', async () => {
    const record = okRecord({ status: 'file_does_not_compile', functions: { reverseList: fnState({ compilesAlone: true, headerUsed: 'official' }), splitString: fnState({ compilesAlone: false, firstError: { line: 23, message: "expected ';' before 'current'" } }), playCraps: fnState({ compilesAlone: true, headerUsed: 'official' }), mode: fnState({ compilesAlone: true, headerUsed: 'official' }) } });
    const plan = await build({ record, code: V01 });
    const q = plan.questions[1];
    expect(q).toMatchObject({ kind: 'compileError', function: 'splitString', line: 23, answerKey: "expected ';' before 'current'", cases: null, followUps: false });
    expect(q.text).toBe("Your splitString doesn't compile. The compiler points to line 23. What is wrong on that line, and how would you fix it?");
    expect(q.lineText).toBe(V01.split('\n')[22].trim());
  });

  test('an error outside the functions: "Your code doesn\'t compile..." replaces the first function\'s question', async () => {
    const record = okRecord({ status: 'file_does_not_compile', outsideFunctionsError: { line: 4, message: 'expected primary-expression' }, functions: { reverseList: fnState({ compilesAlone: true, headerUsed: 'official' }), splitString: fnState({ compilesAlone: true, headerUsed: 'official' }), playCraps: fnState({ compilesAlone: true, headerUsed: 'official' }), mode: fnState({ compilesAlone: true, headerUsed: 'official' }) } });
    const plan = await build({ record });
    expect(plan.questions[0]).toMatchObject({ kind: 'compileErrorOutside', replacedFunction: 'reverseList', line: 4, cases: null });
    expect(plan.questions[1].kind).toBe('logic');
    expect(plan.questions[1].cases.case1.available).toBe(true);
  });

  test('nothing compiles: the first function gets a compile-error question, the other two their logic main questions only; nothing is run', async () => {
    const record = okRecord({ status: 'nothing_compiles', functions: { reverseList: fnState({ compilesAlone: false, firstError: { line: 4, message: 'expected primary-expression' } }), splitString: fnState({ compilesAlone: false, firstError: { line: 12, message: 'x' } }), playCraps: fnState({ compilesAlone: false }), mode: fnState({ compilesAlone: false }) } });
    const docker = fakeDocker();
    const plan = await build({ record, form: 'B', docker });
    expect(plan.questions.map((q) => q.kind)).toEqual(['compileError', 'logic', 'logic']);
    expect(plan.questions[0]).toMatchObject({ function: 'reverseList', line: 4, answerKey: 'expected primary-expression' });
    expect(plan.questions[1]).toMatchObject({ text: 'What does splitString return for ",a,,b" with delimiter \',\'?', answerKey: '"", "a", "", "b"', cases: null, followUps: false });
    expect(plan.questions[2]).toMatchObject({ answerKey: '1', cases: null });
    expect(docker.runPlain).not.toHaveBeenCalled();
    expect(docker.runInputs).not.toHaveBeenCalled();
  });

  test('a record without code has no plan', async () => {
    const plan = await build({ record: { importId: 'z', githubUsername: 'late', status: 'no_version_before_deadline' } });
    expect(plan.noPlan).toContain('no code');
    expect(plan.questions).toEqual([]);
  });
});

describe('what-if edits', () => {
  test('are simple one-line changes inside the function; loop header lines come last; each find is on its line exactly once', () => {
    const edits = candidateEdits(V01, 'reverseList');
    expect(edits.length).toBeGreaterThan(0);
    const firstLoop = edits.findIndex((e) => e.loopHeader);
    if (firstLoop >= 0) edits.slice(firstLoop).forEach((e) => expect(e.loopHeader).toBe(true));
    const lines = V01.split('\n');
    edits.forEach((e) => {
      expect(lines[e.line - 1].split(e.find).length - 1).toBe(1);
      expect(e.newLine).toBe(lines[e.line - 1].replace(e.find, () => e.replace).trim());
      expect(e.find).not.toBe(e.replace);
    });
    expect(edits.some((e) => e.find === '- 1' && e.replace === '- 2')).toBe(true);
  });

  const inputs = [{ cmd: 'reverseList 1 2 3 4', display: 'the vector {1, 2, 3, 4}', spec: '[4, 3, 2, 1]', output: '[4, 3, 2, 1]' }];
  const parts = { header: officialHeader, studentSource: V01 };
  const find = (docker) => findWhatIf({ docker, parts, driver, code: V01, fn: 'reverseList', inputs });

  test('is accepted when it is sanitizer-clean and changes the output', async () => {
    const r = await find(fakeDocker({ whatIf: () => ({ code: 0, stdout: '[3, 2, 1, 4]\n', san: { code: 0, stderr: '' } }) }));
    expect(r).toMatchObject({ ok: true, output: '[3, 2, 1, 4]' });
  });

  test('is rejected with a sanitizer report, a crash, a time limit, an unchanged output, and when it would make the output the spec answer', async () => {
    const reject = async (whatIf) => (await find(fakeDocker({ whatIf }))).ok;
    expect(await reject(() => ({ code: 0, stdout: '[3, 2, 1, 4]\n', san: { code: 0, stderr: 'ERROR: AddressSanitizer: heap-buffer-overflow' } }))).toBe(false);
    expect(await reject(() => ({ code: 0, stdout: '[3, 2, 1, 4]\n', san: { code: 0, stderr: 'x.cpp:3: runtime error: index out of bounds' } }))).toBe(false);
    expect(await reject(() => ({ code: 139, stdout: '', san: { code: 139, stderr: '' } }))).toBe(false);
    expect(await reject(() => ({ code: 124, stdout: '', san: { code: 124, stderr: '' } }))).toBe(false);
    expect(await reject(() => ({ code: 0, stdout: '[4, 3, 2, 1]\n', san: { code: 0, stderr: '' } }))).toBe(false);
    // their output is wrong and the edit would produce the spec answer: that is the fix
    const wrong = [{ ...inputs[0], output: '[1, 2, 3, 4]' }];
    const fix = await findWhatIf({ docker: fakeDocker({ whatIf: () => ({ code: 0, stdout: '[4, 3, 2, 1]\n', san: { code: 0, stderr: '' } }) }), parts, driver, code: V01, fn: 'reverseList', inputs: wrong });
    expect(fix.ok).toBe(false);
    expect(fix.reason).toContain('fix');
  });

  test('with no safe input there is no what-if', async () => {
    expect(await findWhatIf({ docker: fakeDocker(), parts, driver, code: V01, fn: 'reverseList', inputs: [] })).toMatchObject({ ok: false, reason: expect.stringContaining('no safe input') });
  });
});

describe('plan-review and the stored plan', () => {
  test('the review has the summary and, per function, the main question and each case branch with the expected answer and its kind', async () => {
    const plan = await build({ record: okRecord({ githubUsername: 'amy' }) });
    const wrong = await build({ record: setOutput(okRecord({ importId: 'id-2', githubUsername: 'ben' }), 'reverseList 3 5 8', '[3, 5, 8]'), code: V03, form: 'B' });
    const md = renderReview([plan, wrong, { githubUsername: 'late', status: 'no_version_before_deadline', noPlan: 'no code', questions: [], notes: [], log: [] }], { records: { 'id-1': okRecord({ commitHash: 'abcdef123', headerUsed: 'student' }) } });
    expect(md).toContain('## Summary');
    expect(md).toContain('Students with a plan: 2 (rotation A: 1, B: 1)');
    expect(md).toContain('"Their code is right" per function');
    expect(md).toContain('Case 1 follow-up 1 types (rotation)');
    expect(md).toContain('What-ifs: ');
    expect(md).toContain('Compile groups: ');
    expect(md).toContain('## amy: rotation A, status ok');
    expect(md).toContain('> To reverse {1, 2, 3, 4, 5} in place, how many swaps are needed?');
    expect(md).toContain('Expected answer (logic answer, the spec): `2`');
    expect(md).toContain('**Case 1: logic answer right, their code right**');
    expect(md).toContain('**Case 4: logic answer wrong, their code wrong**');
    expect(md).toContain('code answer');
    expect(md).toContain('Your reverseList returns [3, 5, 8] for the vector {3, 5, 8}. Why does it give that instead of [8, 5, 3]?');
    expect(md).toContain('Not possible for this student: their code is right for this function');
    expect(md).toContain('No plan: no code');
    const s = summarize([plan, wrong]);
    expect(s.codeRight.reverseList).toEqual({ right: 1, wrong: 1, unknown: 0 });
    expect(s.whatIf.prepared.length).toBeGreaterThan(0);
  });

  test('the plan stored in a record has no line text', async () => {
    const plan = await build();
    expect(JSON.stringify(plan)).toContain('lineText');
    const stored = planForRecord(plan);
    expect(JSON.stringify(stored)).not.toContain('lineText');
    expect(stored.questions[1].cases.case1.followUp1.text).toBe(plan.questions[1].cases.case1.followUp1.text);
    expect(stored.version).toBe(3);
  });
});
