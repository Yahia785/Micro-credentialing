// A small made-up plan, record and student code for the A2 tests (no real student data; the shape is what plan.js stores on a record).
const IMPORT_ID = '0b6f2c1e-3d4a-4e5b-8c7d-9a1b2c3d4e5f';
const USERNAME = 'fixtureuser99';

const CODE = [
  '#include "functions.h"', // 1
  '', // 2
  'void reverseList(vector<int>& vec) {', // 3
  '    for (size_t i = 0; i < vec.size() / 2; i++) {', // 4
  '        swap(vec[i], vec[vec.size() - 1 - i]);', // 5
  '    }', // 6
  '}', // 7
  '', // 8
  'vector<string> splitString(string str, char delim) {', // 9
  '    vector<string> parts;', // 10
  '    size_t start = 0;', // 11
  '    size_t pos = str.find(delim);', // 12
  '    while (pos != string::npos) {', // 13
  '        parts.push_back(str.substr(start, pos - start));', // 14
  '        start = pos + 1;', // 15
  '        pos = str.find(delim, start);', // 16
  '    }', // 17
  '    parts.push_back(str.substr(start));', // 18
  '    return parts;', // 19
  '}', // 20
  '', // 21
  'int playCraps(const vector<int>& rolls) {', // 22
  '    return rolls.empty() ? -1 : 1;', // 23
  '}', // 24
  '',
].join('\n');

const fixed = {
  reverseList: { question: 'Why does reversing in place only need to go through half of the vector?', answerKey: 'Each swap places two numbers; going all the way swaps everything back.' },
  splitString: { question: 'Why does splitting "apple,banana" with a bar give one piece instead of none?', answerKey: 'There is no delimiter, so the whole string is the one piece.' },
  playCraps: { question: 'Why does {4, 3} end the game right away?', answerKey: '7 on the first roll is an instant win.' },
};

/** The plan of a student whose reverseList is wrong for three numbers (form A: predict, tracing, predict). */
function formAPlan() {
  return {
    version: 1,
    importId: IMPORT_ID,
    githubUsername: USERNAME,
    form: 'A',
    status: 'ok',
    notes: [],
    log: [],
    questions: [
      {
        slot: 'reverseList', function: 'reverseList', formType: 'predict', kind: 'predict', input: { cmd: 'reverseList 3 5 8', display: 'the vector {3, 5, 8}' },
        targeted: true, bug: 'v03', selectionReason: 'separates this code from the spec', spec: '[8, 5, 3]',
        text: 'What would the vector hold after your reverseList runs on the vector {3, 5, 8}?', answer: '[3, 5, 8]', correct: false, fixedFollowUp: fixed.reverseList, index: 1,
      },
      {
        slot: 'splitString', function: 'splitString', formType: 'tracing', kind: 'tracing', input: { cmd: 'splitString , a,b,c', display: 'the string "a,b,c" with delimiter \',\'' },
        targeted: false, selectionReason: 'standard input',
        text: 'You put a breakpoint on line 14 and run splitString on the string "a,b,c" with delimiter \',\'. When it stops for the 2nd time, what piece is about to be added?',
        line: 14, variables: [{ name: 'piece', expr: 'str.substr(start, pos - start)' }], k: 2, kth: '2nd', totalStops: 2, answer: 'piece="b"', traceDiffersFromReference: false,
        fixedFollowUp: fixed.splitString, index: 2,
      },
      {
        slot: 'playCraps', function: 'playCraps', formType: 'predict', kind: 'predict', input: { cmd: 'playCraps 2 2 1 2 3 4', display: 'the dice values {2, 2, 1, 2, 3, 4}' },
        targeted: false, selectionReason: 'standard input', spec: '1',
        text: 'What does your playCraps return for the dice values {2, 2, 1, 2, 3, 4}?', answer: '1', correct: true, fixedFollowUp: fixed.playCraps, index: 3,
      },
    ],
    referenceAnswers: {
      'reverseList 3 5 8': { function: 'reverseList', display: 'the vector {3, 5, 8}', spec: '[8, 5, 3]', refStops: ['left number=3, right number=8'] },
      'splitString , a,b,c': { function: 'splitString', display: 'x', spec: '["a", "b", "c"]', refStops: ['piece="a"', 'piece="b"'] },
      'playCraps 2 2 1 2 3 4': { function: 'playCraps', display: 'x', spec: '1', refStops: ['sum=4'] },
    },
  };
}

/** A student whose file does not compile: a compile-error question, then two logic questions (no fixed follow-up for either). */
function brokenPlan() {
  return {
    version: 1,
    importId: IMPORT_ID,
    githubUsername: USERNAME,
    form: 'B',
    status: 'nothing_compiles',
    notes: [],
    log: [],
    questions: [
      { slot: 'reverseList', function: 'reverseList', formType: 'tracing', kind: 'compileError', text: "Your reverseList doesn't compile. The compiler points to line 6. What is wrong on that line, and how would you fix it?", line: 6, answerKey: "expected ';' before '}' token", index: 1 },
      { slot: 'splitString', function: 'splitString', formType: 'predict', kind: 'logic', text: 'Walk me through what your splitString would do with the string "a,b,c" with delimiter \',\', step by step.', input: { cmd: 'splitString , a,b,c', display: 'x' }, answerKey: '["a", "b", "c"]', index: 2 },
      { slot: 'playCraps', function: 'playCraps', formType: 'tracing', kind: 'logic', text: 'Walk me through what your playCraps would do with the dice values {4, 3}, step by step.', input: { cmd: 'playCraps 4 3', display: 'x' }, answerKey: '0', index: 3 },
    ],
    referenceAnswers: {},
  };
}

const okRecord = (plan = formAPlan()) => ({
  importId: IMPORT_ID,
  githubUsername: USERNAME,
  status: plan.status,
  headerUsed: 'official',
  functions: { reverseList: { present: true }, splitString: { present: true }, playCraps: { present: true }, mode: { present: false } },
  plan: JSON.parse(JSON.stringify(plan)),
});

const MILESTONE = {
  milestoneId: 'milestone_a2',
  title: 'Code Interview',
  language: 'cpp',
  timeLimit: 5000,
  memoryLimit: 256000,
  interview: { enabled: true, interviewOnly: true, source: 'a2-pilot', timeLimitMinutes: 20, maxFollowUpsPerMainQuestion: 1, promptVersion: 'host.a2', themes: [] },
};

module.exports = { IMPORT_ID, USERNAME, CODE, formAPlan, brokenPlan, okRecord, MILESTONE, fixed };
