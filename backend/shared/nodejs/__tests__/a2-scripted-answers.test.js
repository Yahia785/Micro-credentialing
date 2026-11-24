// The scripted-answers generator: every case a student's code allows is covered at least twice per function, the unclear path too, and the
// files are only ever written outside the repo. Made-up students only.
const fs = require('fs');
const path = require('path');
const lib = '../../../scripts/a2-import';
const { buildPlan } = require(`${lib}/lib/plan-build`);
const { questionInputs } = require(`${lib}/lib/reference`);
const { candidateInputs } = require(`${lib}/lib/inputs`);
const { build, coverage, render, codeFormats, wrongCode } = require(`${lib}/scripted-answers`);

const A2 = path.join(__dirname, '../../../scripts/eval/a2');
const questions = JSON.parse(fs.readFileSync(path.join(A2, 'questions.json'), 'utf8'));
const officialHeader = fs.readFileSync(path.join(A2, 'reference/functions.h'), 'utf8');
const driver = fs.readFileSync(path.join(A2, 'driver/main.cpp'), 'utf8');
const V01 = fs.readFileSync(path.join(A2, 'variants/v01-correct-a/functions.cpp'), 'utf8');
const reference = { inputs: Object.fromEntries(questionInputs(questions).map((i) => { const f = candidateInputs(questions, i.function).find((x) => x.cmd === i.cmd); return [i.cmd, { ...i, spec: f.spec, refStops: f.refStops || [] }]; })) };
const fnState = () => ({ present: true, compiles: true });
const record = (n, wrongCmd) => ({
  importId: `id-${n}`, githubUsername: `fake${n}`, status: 'ok', headerUsed: 'official', outsideFunctionsError: null,
  functions: { reverseList: fnState(), splitString: fnState(), playCraps: fnState(), mode: fnState() },
  inputs: Object.values(reference.inputs).map((i) => ({ function: i.function, cmd: i.cmd, output: i.cmd === wrongCmd ? '[3, 5, 8]' : i.spec, matchesSpec: i.cmd !== wrongCmd, unclearSpec: false, excludeFromQuestions: false })),
});
const docker = () => ({
  runPlain: async ({ source, cmds }) => { const m = (/@@TRACE-[0-9a-f]+@@/.exec(source) || [])[0]; return { compile: { ok: true }, runs: cmds.map((c) => ({ code: 0, stdout: `${reference.inputs[c].spec}\n`, stderr: `${m}\t1\ta=1\n${m}\t2\ta=2\n` })) }; },
  runInputs: async ({ cmds }) => ({ sanCompile: { ok: true }, plainCompile: { ok: true }, runs: cmds.map((c) => ({ san: { code: 0, stderr: '' }, plain: { code: 0, stdout: `changed ${c}\n` } })) }),
});
const make = (n, wrongCmd) => buildPlan({ record: record(n, wrongCmd), code: V01, studentHeader: null, form: n % 2 ? 'A' : 'B', assets: { officialHeader, driver, questions }, reference, docker: docker() });

describe('scripted answers', () => {
  let students;
  beforeAll(async () => { students = build([await make(1, null), await make(2, 'reverseList 3 5 8')]); });

  test('every case the code allows is covered at least twice per function, and the unclear path too', () => {
    const cov = coverage(students);
    // student 1 is right everywhere; student 2 is wrong for reverseList only
    for (const fn of ['reverseList', 'splitString', 'playCraps']) { expect(cov[fn][1]).toBeGreaterThanOrEqual(2); expect(cov[fn][3]).toBeGreaterThanOrEqual(2); expect(cov[fn].unclear).toBeGreaterThanOrEqual(2); }
    expect(cov.reverseList[2]).toBeGreaterThanOrEqual(2);
    expect(cov.reverseList[4]).toBeGreaterThanOrEqual(2);
    expect(cov.splitString[2] + cov.splitString[4]).toBe(0); // no student's splitString is wrong: nothing to script
  });

  test('each path says what is typed, the expected check and what is asked next; right answers are right and wrong ones differ', () => {
    for (const s of students) for (const f of s.functions) for (const p of f.paths) for (const st of p.steps) {
      expect(['correct', 'wrong', 'unclear']).toContain(st.expected);
      // a smaller code step has an intent instead of an answer: the run fills the value in from the question the agent really asked
      if (st.kind === 'smallStep') { expect(['right', 'wrong']).toContain(st.intent); expect(st.answer).toBeNull(); expect(st.asks).toContain('breakpoint template'); } else expect(st.answer.length).toBeGreaterThan(0);
      expect(['logic', 'code', 'compile']).toContain(st.answerType);
    }
    const main = students[0].functions[0].paths.find((p) => p.case === 1).steps[0];
    expect(main).toMatchObject({ answer: '2', expected: 'correct', answerType: 'logic' });
    expect(students[0].functions[0].paths.find((p) => p.unclear).steps[0].expected).toBe('unclear');
    expect(students[0].functions[0].paths.find((p) => p.unclear).steps[0].next).toBe('Can you give the exact result?');
  });

  test('case 2 is the only path whose asked text shows their output and the spec answer', () => {
    const paths = students[1].functions[0].paths;
    const debug = paths.find((p) => p.case === 2).steps[1].asks;
    expect(debug).toContain('[3, 5, 8]');
    expect(debug).toContain('[8, 5, 3]');
    paths.filter((p) => p.case !== 2).forEach((p) => p.steps.slice(1).forEach((st) => expect(st.asks).not.toContain('[8, 5, 3]')));
  });

  test('the markdown has the coverage table and every path; the formats vary', () => {
    const md = render(students);
    expect(md).toContain('## Coverage: scripted paths per case and function');
    expect(md).toContain('nothing here has been run');
    expect(new Set(codeFormats('[50, 40, 30]')).size).toBe(3);
    expect(codeFormats('left number=1, right number=5')[0]).toBe('1 and 5');
    expect(wrongCode('[3, 5, 8]')).not.toBe('[3, 5, 8]');
  });

  test('the right case 2 and compile-error answers are really right for their code: the cause, the line number and the change', () => {
    const { caseTwoAnswers, compileAnswer } = require('../../../scripts/a2-import/lib/right-answers');
    const loop = ['#include "functions.h"', '', 'void reverseList(vector<int>& vec) {', '    for (int i = 0; i < vec.size(); i++) {', '        swap(vec[i], vec[vec.size() - 1 - i]);', '    }', '}', '', 'int mode(const vector<int>& vec) {', '    return 0;', '}'].join('\n');
    const a = caseTwoAnswers({ bug: 'v03', code: loop, fn: 'reverseList' });
    expect(a.why).toContain('every pair is swapped twice');
    expect(a.line).toContain('Line 4,');
    expect(a.line).toContain('i < vec.size() / 2');
    expect(a.lineNumber).toBe(4);
    expect(a.wrongLine).toContain('Line 3,'); // the function header: not where the bug is
    // a stub is recognised from the code when the plan names no bug
    const stub = ['#include "functions.h"', '', 'vector<string> splitString(string str, char delim) {', '    return {};', '}'].join('\n');
    expect(caseTwoAnswers({ bug: null, code: stub, fn: 'splitString' })).toMatchObject({ lineNumber: 4 });
    const missing = compileAnswer({ message: "expected primary-expression before ';' token", line: 2, code: 'int x;\n    int oops = ;\n' });
    expect(missing).toContain('On line 2, `int oops = ;`');
    expect(missing).toContain('a value is missing');
    expect(missing).toContain('int oops = 0;');
    expect(compileAnswer({ message: "expected ';' before 'current'", line: 1, code: 'parts.push_back(current)\ncurrent = "";' })).toContain('the ; is missing');
  });

  test('refuses to write inside the repo', () => {
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, [path.join(__dirname, '../../../scripts/a2-import/scripted-answers.js'), '--out', path.join(__dirname, 'x')], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('outside the repo');
  });
});
