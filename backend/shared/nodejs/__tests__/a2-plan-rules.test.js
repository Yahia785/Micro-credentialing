const fs = require('fs');
const path = require('path');
const lib = '../../../scripts/a2-import/lib';
const { assignForms, decideSlots, renderQuestion, functionState } = require(`${lib}/plan-rules`);
const { buildPlan } = require(`${lib}/plan-build`);
const { renderReview, summarize } = require(`${lib}/plan-review`);
const { questionInputs } = require(`${lib}/reference`);
const { planForRecord } = require('../../../scripts/a2-import/plan');

const A2 = path.join(__dirname, '../../../scripts/eval/a2');
const questions = JSON.parse(fs.readFileSync(path.join(A2, 'questions.json'), 'utf8'));
const officialHeader = fs.readFileSync(path.join(A2, 'reference/functions.h'), 'utf8');
const driver = fs.readFileSync(path.join(A2, 'driver/main.cpp'), 'utf8');
const variant = (name) => fs.readFileSync(path.join(A2, 'variants', name, 'functions.cpp'), 'utf8');
const V01 = variant('v01-correct-a');
const V03 = variant('v03-reverse-loop-to-end');
const V10 = variant('v10-split-stub');

// the reference's answers from questions.json (spec and refStops are filled in there)
const reference = { inputs: Object.fromEntries(questionInputs(questions).map((i) => {
  const all = [...questions.functions[i.function].standardInputs, ...questions.functions[i.function].targetInputs];
  const found = all.find((x) => x.cmd === i.cmd);
  return [i.cmd, { ...i, spec: found.spec, refStops: found.refStops }];
})) };

const fnState = (over = {}) => ({ present: true, compiles: true, ...over });
const okRecord = (over = {}) => ({
  importId: 'id-1', githubUsername: 'amy', status: 'ok', headerUsed: 'official', outsideFunctionsError: null, modeNeeded: false,
  functions: { reverseList: fnState(), splitString: fnState(), playCraps: fnState(), mode: fnState() },
  inputs: Object.values(reference.inputs).map((i) => ({ function: i.function, cmd: i.cmd, output: i.spec, excludeFromQuestions: false, excludeReason: null })),
  ...over,
});

describe('assignForms', () => {
  test('sorted by importId, alternating A, B, A, B; records without code get no form', () => {
    const records = [{ importId: 'c', status: 'ok' }, { importId: 'a', status: 'ok' }, { importId: 'x', status: 'no_version_before_deadline' }, { importId: 'b', status: 'nothing_compiles' }, { importId: 'd', status: 'file_does_not_compile' }];
    const forms = assignForms(records);
    expect([...forms.entries()]).toEqual([['a', 'A'], ['b', 'B'], ['c', 'A'], ['d', 'B']]);
    expect(forms.has('x')).toBe(false);
  });

  test('the forms are split evenly', () => {
    const records = Array.from({ length: 12 }, (_, i) => ({ importId: `i${String(i).padStart(2, '0')}`, status: 'ok' }));
    const counts = [...assignForms(records).values()].reduce((m, f) => ({ ...m, [f]: (m[f] || 0) + 1 }), {});
    expect(counts).toEqual({ A: 6, B: 6 });
  });
});

describe('decideSlots', () => {
  const slotsOf = (record, form = 'A') => decideSlots({ form, record, formTypes: questions.forms[form] });
  const kinds = (r) => r.slots.map((s) => `${s.slot}:${s.function}:${s.kind}`);

  test('form A and form B: the types follow the form for functions that compile', () => {
    expect(kinds(slotsOf(okRecord(), 'A'))).toEqual(['reverseList:reverseList:predict', 'splitString:splitString:tracing', 'playCraps:playCraps:predict']);
    expect(kinds(slotsOf(okRecord(), 'B'))).toEqual(['reverseList:reverseList:tracing', 'splitString:splitString:predict', 'playCraps:playCraps:tracing']);
  });

  test('mode replaces a function that is completely missing and takes its type', () => {
    const record = okRecord({ functions: { reverseList: fnState(), splitString: fnState({ present: false, compiles: false }), playCraps: fnState(), mode: fnState() } });
    const a = slotsOf(record, 'A');
    expect(kinds(a)).toEqual(['reverseList:reverseList:predict', 'splitString:mode:tracing', 'playCraps:playCraps:predict']);
    expect(a.slots[1].replaces).toBe('splitString');
    expect(a.notes[0]).toContain('splitString is missing: mode replaces it (tracing)');
    expect(kinds(slotsOf(record, 'B'))[1]).toBe('splitString:mode:predict');
  });

  test('a missing function with a missing mode has no question for the slot', () => {
    const record = okRecord({ functions: { reverseList: fnState(), splitString: fnState({ present: false }), playCraps: fnState(), mode: fnState({ present: false }) } });
    expect(slotsOf(record).slots[1]).toMatchObject({ kind: 'unaskable', function: 'mode', replaces: 'splitString' });
  });

  test('a function that exists but does not compile gets a compile-error question, never mode', () => {
    const record = okRecord({ status: 'file_does_not_compile', functions: { reverseList: fnState({ compilesAlone: true }), splitString: fnState({ compilesAlone: false, firstError: { line: 23, message: "expected ';'" } }), playCraps: fnState({ compilesAlone: true }), mode: fnState({ compilesAlone: true }) } });
    const r = slotsOf(record, 'A');
    expect(r.slots[1]).toMatchObject({ kind: 'compileError', function: 'splitString', line: 23, message: "expected ';'" });
    expect(r.slots[1].replaces).toBeUndefined();
    expect(r.slots.map((s) => s.function)).toEqual(['reverseList', 'splitString', 'playCraps']);
  });

  test('a function that does not compile and has no error line gets a logic question with the reason', () => {
    const record = okRecord({ status: 'file_does_not_compile', functions: { reverseList: fnState({ compilesAlone: true }), splitString: fnState({ compilesAlone: false, firstError: { line: null, message: 'driver.cpp: ambiguous' } }), playCraps: fnState({ compilesAlone: true }), mode: fnState({ compilesAlone: true }) } });
    expect(slotsOf(record).slots[1]).toMatchObject({ kind: 'logic' });
    expect(slotsOf(record).slots[1].reason).toContain('no line to point to');
  });

  test('an error outside the functions replaces the first normal question and says which function', () => {
    const record = okRecord({ status: 'file_does_not_compile', outsideFunctionsError: { line: 78, message: 'expected primary-expression' }, functions: { reverseList: fnState({ compilesAlone: true }), splitString: fnState({ compilesAlone: true }), playCraps: fnState({ compilesAlone: true }), mode: fnState({ compilesAlone: true }) } });
    const r = slotsOf(record, 'A');
    expect(r.slots[0]).toMatchObject({ kind: 'compileErrorOutside', replacedFunction: 'reverseList', line: 78 });
    expect(r.slots[1].kind).toBe('tracing');
    expect(r.notes.join(' ')).toContain('replaces the reverseList question');
  });

  test('nothing compiles: every function gets a logic question', () => {
    const record = okRecord({ status: 'nothing_compiles', functions: { reverseList: fnState({ present: true, compilesAlone: false }), splitString: fnState({ compilesAlone: false }), playCraps: fnState({ compilesAlone: false }), mode: fnState({ compilesAlone: false }) } });
    expect(kinds(slotsOf(record, 'B'))).toEqual(['reverseList:reverseList:logic', 'splitString:splitString:logic', 'playCraps:playCraps:logic']);
  });

  test('statuses without code have no plan', () => {
    expect(decideSlots({ form: 'A', record: { status: 'no_version_before_deadline' }, formTypes: questions.forms.A }).noPlan).toContain('no code');
  });

  test('functionState', () => {
    expect(functionState(okRecord(), 'mode')).toBe('compiles');
    expect(functionState({ status: 'file_does_not_compile', functions: { mode: { present: true, compilesAlone: false } } }, 'mode')).toBe('compileError');
    expect(functionState({ status: 'ok', functions: { mode: { present: false } } }, 'mode')).toBe('missing');
  });
});

describe('the question texts', () => {
  test('predict, tracing, compile error, compile error outside and logic, exactly as the student sees them', () => {
    expect(renderQuestion(questions, 'predict', { function: 'splitString', display: 'the string "a,b" with delimiter \',\'' })).toBe('What does your splitString return for the string "a,b" with delimiter \',\'?');
    expect(renderQuestion(questions, 'tracing', { function: 'reverseList', line: 7, display: 'the vector {1, 2, 3}', k: 2 })).toBe('You put a breakpoint on line 7 and run reverseList on the vector {1, 2, 3}. When it stops for the 2nd time, which two numbers are about to be swapped?');
    expect(renderQuestion(questions, 'compileError', { function: 'splitString', line: 23 })).toBe("Your splitString doesn't compile. The compiler points to line 23. What is wrong on that line, and how would you fix it?");
    expect(renderQuestion(questions, 'compileErrorOutside', { line: 78 })).toBe("Your code doesn't compile. The compiler points to line 78. What is wrong on that line, and how would you fix it?");
    expect(renderQuestion(questions, 'logic', { function: 'mode', display: 'the vector {5}' })).toBe('Walk me through what your mode would do with the vector {5}, step by step.');
  });
});

// A fake docker: a trace program prints three stops. Nothing else is run for a plan.
function fakeDocker({ compileFails = () => false } = {}) {
  return {
    runPlain: jest.fn(async ({ source, cmds }) => {
      if (compileFails(source)) return { compile: { ok: false, errors: 'error' }, runs: [] };
      const marker = (/@@TRACE-[0-9a-f]+@@/.exec(source) || [])[0];
      if (marker) {
        const spec = reference.inputs[cmds[0]].spec;
        return { compile: { ok: true }, runs: [{ code: 0, stdout: `${spec}\n`, stderr: `${marker}\t1\ta=1\n${marker}\t2\ta=2\n${marker}\t3\ta=3\n` }] };
      }
      throw new Error('a plan must not run anything but the trace copy');
    }),
    cleanup: jest.fn(),
  };
}
const build = (over) => buildPlan({ record: okRecord(), code: V01, studentHeader: null, form: 'A', assets: { officialHeader, driver, questions }, reference, docker: fakeDocker(), ...over });

describe('buildPlan', () => {
  test('form A with a correct submission: predict, tracing, predict; every question has its answer, flags and a what-if', async () => {
    const plan = await build();
    expect(plan.questions.map((q) => `${q.function}:${q.kind}`)).toEqual(['reverseList:predict', 'splitString:tracing', 'playCraps:predict']);
    const [q1, q2, q3] = plan.questions;
    expect(q1).toMatchObject({ index: 1, targeted: false, correct: true, answer: '[50, 40, 30, 20, 10]', spec: '[50, 40, 30, 20, 10]' });
    expect(q1.text).toBe('What would the vector hold after your reverseList runs on the vector {10, 20, 30, 40, 50}?');
    expect(q2).toMatchObject({ kind: 'tracing', k: 2, kth: '2nd', traceDiffersFromReference: true, answer: 'a=2' }); // the fake docker's second stop
    expect(q2.text).toMatch(/^You put a breakpoint on line \d+ and run splitString on the string "a,b,c" with delimiter ','\. When it stops for the 2nd time, what piece is about to be added\?$/);
    expect(q2.lineText).toContain('parts.push_back(current);');
    expect(q2.variables).toEqual([{ name: 'piece', expr: 'current' }]);
    expect(q3.spec).toBe('1');
    // the fixed follow-up: the same question and answer key for every student
    expect(q1.fixedFollowUp).toEqual(questions.fixedFollowUps.reverseList);
    expect(q2.fixedFollowUp).toEqual(questions.fixedFollowUps.splitString);
    expect(q3.fixedFollowUp).toEqual(questions.fixedFollowUps.playCraps);
    [q1, q2, q3].forEach((q) => expect(q).not.toHaveProperty('whatIf'));
    expect(plan.referenceAnswers['reverseList 10 20 30 40 50'].spec).toBe('[50, 40, 30, 20, 10]');
  });

  test('a targeted input is used when the student\'s output differs from the spec, and the answer comes from their code', async () => {
    const record = okRecord();
    const target = record.inputs.find((i) => i.cmd === 'reverseList 3 5 8');
    target.output = '[3, 5, 8]'; // the recorded output of v03
    const plan = await build({ record, code: V03 });
    expect(plan.questions[0]).toMatchObject({ targeted: true, bug: 'v03', answer: '[3, 5, 8]', spec: '[8, 5, 3]', correct: false });
  });

  test('excluded inputs stored in the record are never used', async () => {
    const record = okRecord();
    const t = record.inputs.find((i) => i.cmd === 'reverseList 3 5 8');
    t.output = '[3, 5, 8]';
    t.excludeFromQuestions = true;
    t.excludeReason = 'sanitizer: sanitizer';
    const plan = await build({ record, code: V03 });
    expect(plan.questions[0].input.cmd).toBe('reverseList 10 20 30 40 50');
    expect(plan.questions[0].targeted).toBe(false);
    expect(plan.questions[0].selectionReason).toContain('sanitizer: sanitizer');
  });

  test('a tracing line that needs manual (and has no override) switches the function to predict and logs typeChanged', async () => {
    const record = okRecord();
    const plan = await build({ record, code: V10 });
    const q = plan.questions[1];
    expect(q).toMatchObject({ function: 'splitString', kind: 'predict', formType: 'tracing' });
    expect(q.typeChanged).toEqual({ from: 'tracing', to: 'predict', reason: expect.stringContaining('needs manual') });
    expect(plan.log.join(' ')).toContain('splitString: tracing changed to predict');
    expect(q.text).toBe('What does your splitString return for the string "a,b,c" with delimiter \',\'?');
  });

  test('an override sets the line, the variables and K, and is applied again on a re-run', async () => {
    const overrides = { reverseList: { pauseLine: 7, variables: [{ name: 'left number', expr: 'vec[left]' }, { name: 'right number', expr: 'vec[right]' }], k: 1 } };
    const first = await build({ form: 'B', overrides });
    const q = first.questions[0];
    expect(q).toMatchObject({ kind: 'tracing', line: 7, k: 1, kth: '1st', overridden: true });
    expect(q.text).toContain('line 7');
    const again = await build({ form: 'B', overrides });
    expect(again.questions[0]).toMatchObject({ line: 7, k: 1 });
    // an override that cannot be built changes the type, with the reason
    const bad = await build({ form: 'B', overrides: { reverseList: { pauseLine: 1, variables: [{ name: 'x', expr: 'vec[0]' }] } } });
    expect(bad.questions[0].typeChanged.reason).toContain('refused');
    // K larger than the number of stops is refused
    const tooBig = await build({ form: 'B', overrides: { reverseList: { k: 9 } } });
    expect(tooBig.questions[0].typeChanged.reason).toContain('K=9');
  });

  test('a missing function: mode replaces it with the same type and its own answers', async () => {
    const record = okRecord({ functions: { reverseList: fnState(), splitString: fnState({ present: false, compiles: false }), playCraps: fnState(), mode: fnState() } });
    const plan = await build({ record });
    expect(plan.questions[1]).toMatchObject({ slot: 'splitString', function: 'mode', replaces: 'splitString', kind: 'tracing' });
    expect(plan.questions[1].text).toContain('run mode on');
    expect(plan.questions[1].fixedFollowUp).toEqual(questions.fixedFollowUps.mode); // the follow-up is mode's own
  });

  test('a function that does not compile gets the compile-error question with the compiler message as the answer key', async () => {
    const record = okRecord({ status: 'file_does_not_compile', functions: { reverseList: fnState({ compilesAlone: true, headerUsed: 'official' }), splitString: fnState({ compilesAlone: false, firstError: { line: 23, message: "expected ';' before 'current'" } }), playCraps: fnState({ compilesAlone: true, headerUsed: 'official' }), mode: fnState({ compilesAlone: true, headerUsed: 'official' }) } });
    const plan = await build({ record, code: V01 });
    const q = plan.questions[1];
    expect(q).toMatchObject({ kind: 'compileError', function: 'splitString', line: 23, answerKey: "expected ';' before 'current'" });
    expect(q.text).toBe("Your splitString doesn't compile. The compiler points to line 23. What is wrong on that line, and how would you fix it?");
    expect(q.lineText).toBe(V01.split('\n')[22].trim());
    expect(q.fixedFollowUp).toBeUndefined(); // compile-error questions have no follow-up
  });

  test('an error outside the functions: "Your code doesn\'t compile..." replaces the first function\'s question, which is named', async () => {
    const record = okRecord({ status: 'file_does_not_compile', outsideFunctionsError: { line: 4, message: 'expected primary-expression' }, functions: { reverseList: fnState({ compilesAlone: true, headerUsed: 'official' }), splitString: fnState({ compilesAlone: true, headerUsed: 'official' }), playCraps: fnState({ compilesAlone: true, headerUsed: 'official' }), mode: fnState({ compilesAlone: true, headerUsed: 'official' }) } });
    const plan = await build({ record });
    expect(plan.questions[0]).toMatchObject({ kind: 'compileErrorOutside', replacedFunction: 'reverseList', line: 4 });
    expect(plan.questions[0].text).toBe("Your code doesn't compile. The compiler points to line 4. What is wrong on that line, and how would you fix it?");
    expect(plan.questions[1].kind).toBe('tracing');
  });

  test('nothing compiles: the first function gets a compile-error question (its own first error), the other two get logic questions, no run', async () => {
    const record = okRecord({ status: 'nothing_compiles', functions: { reverseList: fnState({ compilesAlone: false, firstError: { line: 4, message: 'expected primary-expression' } }), splitString: fnState({ compilesAlone: false, firstError: { line: 12, message: 'x' } }), playCraps: fnState({ compilesAlone: false }), mode: fnState({ compilesAlone: false }) } });
    const docker = fakeDocker();
    const plan = await build({ record, form: 'B', docker });
    expect(plan.questions.map((q) => q.kind)).toEqual(['compileError', 'logic', 'logic']);
    expect(plan.questions[0]).toMatchObject({ function: 'reverseList', line: 4, answerKey: 'expected primary-expression' });
    expect(plan.questions[0].text).toBe("Your reverseList doesn't compile. The compiler points to line 4. What is wrong on that line, and how would you fix it?");
    expect(plan.questions[1].text).toBe('Walk me through what your splitString would do with the string "a,b,c" with delimiter \',\', step by step.');
    expect(plan.questions[1].answerKey).toBe('["a", "b", "c"]');
    expect(plan.questions[2].answerKey).toBe('1');
    plan.questions.forEach((q) => expect(q.fixedFollowUp).toBeUndefined());
    expect(docker.runPlain).not.toHaveBeenCalled();
  });

  test('nothing compiles because of an error outside the functions: the first function gets the "Your code doesn\'t compile" question', async () => {
    const record = okRecord({ status: 'nothing_compiles', outsideFunctionsError: { line: 2, message: 'bad include' }, functions: { reverseList: fnState({ compilesAlone: false, firstError: null, blockedByOutsideError: true }), splitString: fnState({ compilesAlone: false, firstError: null }), playCraps: fnState({ compilesAlone: false, firstError: null }), mode: fnState({ compilesAlone: false, firstError: null }) } });
    const plan = await build({ record });
    expect(plan.questions.map((q) => q.kind)).toEqual(['compileErrorOutside', 'logic', 'logic']);
    expect(plan.questions[0]).toMatchObject({ replacedFunction: 'reverseList', line: 2, answerKey: 'bad include' });
  });

  test('nothing compiles and no error line anywhere: logic questions for all three, with the reason', async () => {
    const record = okRecord({ status: 'nothing_compiles', functions: { reverseList: fnState({ compilesAlone: false, firstError: { line: null, message: 'x' } }), splitString: fnState({ compilesAlone: false }), playCraps: fnState({ compilesAlone: false }), mode: fnState({ compilesAlone: false }) } });
    const plan = await build({ record });
    expect(plan.questions.map((q) => q.kind)).toEqual(['logic', 'logic', 'logic']);
    expect(plan.questions[0].reason).toContain('no error line');
  });

  test('every function has a fixed follow-up with an answer key in questions.json', () => {
    for (const fn of ['reverseList', 'splitString', 'playCraps', 'mode']) {
      expect(questions.fixedFollowUps[fn].question.length).toBeGreaterThan(20);
      expect(questions.fixedFollowUps[fn].answerKey.length).toBeGreaterThan(10);
    }
    expect(questions.fixedFollowUps.mode.answerKey).toBe('1, because a tie goes to the smallest number.');
    expect(questions).not.toHaveProperty('followUp');
  });

  test('a trace that changes the program\'s output is a system error and changes the type', async () => {
    const docker = fakeDocker();
    const real = docker.runPlain.getMockImplementation();
    docker.runPlain.mockImplementation(async (args) => { const r = await real(args); if (/@@TRACE/.test(args.source)) r.runs[0].stdout = 'different\n'; return r; });
    const plan = await build({ docker });
    expect(plan.questions[1].typeChanged.reason).toContain('instrumentation changed behavior');
  });

  test('a record without code has no plan', async () => {
    const plan = await build({ record: { importId: 'z', githubUsername: 'late', status: 'no_version_before_deadline' } });
    expect(plan.noPlan).toContain('no code');
    expect(plan.questions).toEqual([]);
  });
});

describe('plan-review and the stored plan', () => {
  test('the review has the summary, and each question as the student sees it with its line, answers and flags', async () => {
    const plan = await build({ record: okRecord({ githubUsername: 'amy' }) });
    const other = await build({ record: okRecord({ importId: 'id-2', githubUsername: 'ben' }), code: V10, form: 'B' });
    const md = renderReview([plan, other, { githubUsername: 'late', status: 'no_version_before_deadline', noPlan: 'no code', questions: [], notes: [], log: [] }], { records: { 'id-1': okRecord({ commitHash: 'abcdef123', headerUsed: 'student' }) } });
    expect(md).toContain('## Summary');
    expect(md).toContain('Students with a plan: 2 (form A: 1, form B: 1)');
    expect(md).toContain('## amy: form A, status ok');
    expect(md).toContain('> What would the vector hold after your reverseList runs on the vector {10, 20, 30, 40, 50}?');
    expect(md).toContain('- Spec answer: `[50, 40, 30, 20, 10]`');
    expect(md).toContain('Line of their code:');
    expect(md).toContain('trace differs from reference:');
    expect(md).toContain('Fixed follow-up (asked only after a correct main answer):');
    expect(md).toContain('Answer key: Each swap places two numbers');
    expect(md).not.toMatch(/what-if/i);
    expect(md).toContain('No plan: no code');
    expect(summarize([plan, other]).kinds.predict).toBeGreaterThan(0);
  });

  test('the plan stored in a record has no line text', async () => {
    const plan = await build();
    expect(JSON.stringify(plan)).toContain('lineText');
    const stored = planForRecord(plan);
    expect(JSON.stringify(stored)).not.toContain('lineText');
    expect(stored.questions[1].text).toBe(plan.questions[1].text);
    expect(stored.questions[1].line).toBe(plan.questions[1].line);
  });
});
