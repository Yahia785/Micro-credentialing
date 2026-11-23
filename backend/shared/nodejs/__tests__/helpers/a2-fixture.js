// A small made-up plan (version 3, the case design), record and student code for the A2 tests (no real student data; the shape is what plan.js
// stores on a record). reverseList: their code is wrong (cases 2 and 4). splitString and playCraps: their code is right (cases 1 and 3).
const IMPORT_ID = '0b6f2c1e-3d4a-4e5b-8c7d-9a1b2c3d4e5f';
const USERNAME = 'fixtureuser99';

const CODE = [
  '#include "functions.h"', // 1
  '', // 2
  'void reverseList(vector<int>& vec) {', // 3
  '    for (size_t i = 0; i < vec.size(); i++) {', // 4
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

const REV_MAIN = { cmd: 'reverseList 1 2 3 4 5', display: 'the vector {1, 2, 3, 4, 5}' };
const SPLIT_MAIN = { cmd: 'splitString , ,a,,b', display: 'the string ",a,,b" with delimiter \',\'' };
const SPLIT_STD = { cmd: 'splitString , a,b,c', display: 'the string "a,b,c" with delimiter \',\'' };
const CRAPS_MAIN = { cmd: 'playCraps 2 2 3 4', display: 'the dice values {2, 2, 3, 4}' };
const CRAPS_STD = { cmd: 'playCraps 2 2 1 2 3 4', display: 'the dice values {2, 2, 1, 2, 3, 4}' };
const REV_BAD = { cmd: 'reverseList 3 5 8', display: 'the vector {3, 5, 8}' };

const mainQ = (fn, text, key, mainInput, extra) => ({ slot: fn, function: fn, formType: 'predict', kind: 'logic', text, answerKey: key, answerType: 'logic', mainInput, clarify: 'Can you give the exact result?', followUps: true, ...extra });
const none = (reason) => ({ available: false, reason });

function reverseQuestion() {
  return mainQ('reverseList', 'To reverse {1, 2, 3, 4, 5} in place, how many swaps are needed?', '2', REV_MAIN, {
    codeRight: false, codeRightChecked: 7, codeRightFailing: [REV_BAD.cmd],
    cases: {
      case1: none('their code is wrong for this function (cases 2 and 4 apply)'),
      case2: {
        available: true,
        followUp1: { type: 'debug', input: REV_BAD, theirOutput: '[3, 5, 8]', specAnswer: '[8, 5, 3]', answerType: 'code', targeted: true, bug: 'v03', text: 'Your reverseList returns [3, 5, 8] for the vector {3, 5, 8}. Why does it give that instead of [8, 5, 3]?' },
        followUp2: { type: 'change', text: 'Which line would you change, and how?', answerType: 'code' },
      },
      case3: none('their code is wrong for this function (cases 2 and 4 apply)'),
      case4: {
        available: true,
        followUp1: { type: 'smallLogic', input: { cmd: 'reverseList 1 2 3', display: 'the vector {1, 2, 3}' }, text: 'To reverse {1, 2, 3} in place, how many swaps are needed?', answerKey: '1', answerType: 'logic' },
        followUp2: {
          type: 'smallStep', agentWritten: true,
          material: {
            private: true, forAgentOnly: 'The student never sees this.', available: true, input: REV_MAIN, line: 5, lineText: 'swap(vec[i], vec[vec.size() - 1 - i]);',
            variables: [{ name: 'left number', expr: 'vec[i]' }, { name: 'right number', expr: 'vec[vec.size() - 1 - i]' }],
            stops: ['left number=1, right number=5', 'left number=2, right number=4', 'left number=3, right number=3', 'left number=4, right number=2', 'left number=5, right number=1'],
          },
        },
      },
    },
  });
}

function splitQuestion() {
  return mainQ('splitString', 'What does splitString return for ",a,,b" with delimiter \',\'?', '"", "a", "", "b"', SPLIT_MAIN, {
    codeRight: true, codeRightChecked: 5, codeRightFailing: [],
    cases: {
      case1: {
        available: true,
        followUp1: { type: 'tracing', input: SPLIT_STD, text: 'You put a breakpoint on line 14 and run splitString on the string "a,b,c" with delimiter \',\'. When it stops for the 2nd time, what piece is about to be added?', line: 14, variables: [{ name: 'piece', expr: 'str.substr(start, pos - start)' }], k: 2, totalStops: 2, answer: 'piece="b"', answerType: 'code', traceDiffersFromReference: false },
        followUp2: { type: 'whatIf', input: SPLIT_STD, line: 11, find: '0', replace: '1', oldLine: 'size_t start = 0;', newLine: 'size_t start = 1;', text: 'Suppose line 11 of your splitString were changed from `size_t start = 0;` to `size_t start = 1;`. With that change, what would your splitString return for the string "a,b,c" with delimiter \',\'?', answer: '["x", "b", "c"]', answerType: 'code' },
      },
      case2: none('their code is right for this function (cases 1 and 3 apply)'),
      case3: {
        available: true,
        followUp1: { type: 'predict', input: SPLIT_MAIN, text: 'What does your splitString return for ",a,,b" with delimiter \',\'?', answer: '["", "a", "", "b"]', answerBasis: 'their output on the main input', answerType: 'code' },
        followUp2: {
          type: 'smallStep', agentWritten: true,
          material: { private: true, forAgentOnly: 'The student never sees this.', available: true, input: SPLIT_MAIN, line: 14, lineText: 'parts.push_back(str.substr(start, pos - start));', variables: [{ name: 'piece', expr: 'str.substr(start, pos - start)' }], stops: ['piece=""', 'piece="a"', 'piece=""'] },
        },
      },
      case4: none('their code is right for this function (cases 1 and 3 apply)'),
    },
  });
}

function crapsQuestion(over = {}) {
  return mainQ('playCraps', 'What does playCraps return for {2, 2, 3, 4}?', '1', CRAPS_MAIN, {
    codeRight: true, codeRightChecked: 7, codeRightFailing: [],
    cases: {
      case1: {
        available: true,
        followUp1: { type: 'predict', input: CRAPS_STD, text: 'What does your playCraps return for the dice values {2, 2, 1, 2, 3, 4}?', answer: '1', answerType: 'code' },
        followUp2: { type: 'whatIf', input: CRAPS_STD, line: 23, find: '-1', replace: '-2', oldLine: 'return rolls.empty() ? -1 : 1;', newLine: 'return rolls.empty() ? -2 : 1;', text: 'Suppose line 23 of your playCraps were changed from `return rolls.empty() ? -1 : 1;` to `return rolls.empty() ? -2 : 1;`. With that change, what would your playCraps return for the dice values {2, 2, 1, 2, 3, 4}?', answer: '1', answerType: 'code' },
      },
      case2: none('their code is right for this function (cases 1 and 3 apply)'),
      case3: {
        available: true,
        followUp1: { type: 'predict', input: CRAPS_MAIN, text: 'What does your playCraps return for {2, 2, 3, 4}?', answer: '1', answerBasis: 'their output on the main input', answerType: 'code' },
        followUp2: {
          type: 'smallStep', agentWritten: true,
          material: { private: true, forAgentOnly: 'The student never sees this.', available: true, input: CRAPS_MAIN, line: 23, lineText: 'return rolls.empty() ? -1 : 1;', variables: [{ name: 'dice count', expr: 'rolls.size()' }], stops: ['dice count=4'] },
        },
      },
      case4: none('their code is right for this function (cases 1 and 3 apply)'),
    },
    ...over,
  });
}

/** The plan of a student with three functions: reverseList code wrong, splitString and playCraps code right. */
function formAPlan() {
  const questions = [reverseQuestion(), splitQuestion(), crapsQuestion()].map((q, i) => ({ ...q, index: i + 1 }));
  return {
    version: 3, importId: IMPORT_ID, githubUsername: USERNAME, form: 'A', status: 'ok', notes: [], log: [], questions,
    referenceAnswers: {},
  };
}

/** A student whose reverseList does not compile (compile-error question) and whose other two functions have no code to ask about. */
function brokenPlan() {
  const noCode = (fn, text, key) => ({ ...mainQ(fn, text, key, { cmd: 'x', display: 'x' }, { codeRight: null, followUps: false, reason: 'no interview function compiles: logic question only' }), cases: null });
  return {
    version: 3, importId: IMPORT_ID, githubUsername: USERNAME, form: 'B', status: 'nothing_compiles', notes: [], log: [],
    questions: [
      { slot: 'reverseList', function: 'reverseList', formType: 'tracing', kind: 'compileError', text: "Your reverseList doesn't compile. The compiler points to line 6. What is wrong on that line, and how would you fix it?", line: 6, answerKey: "expected ';' before '}' token", answerType: 'compile', cases: null, followUps: false, index: 1 },
      { ...noCode('splitString', 'What does splitString return for ",a,,b" with delimiter \',\'?', '"", "a", "", "b"'), index: 2 },
      { ...noCode('playCraps', 'What does playCraps return for {2, 2, 3, 4}?', '1'), index: 3 },
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

/** What the fixture student's code prints (and traces) on the planned inputs. */
const RUNTIME = {
  plain: {
    'reverseList 3 5 8': '[3, 5, 8]',
    'reverseList 1 2 3 4 5': '[1, 2, 3, 4, 5]',
    'splitString , a,b,c': '["a", "b", "c"]',
    'splitString , ,a,,b': '["", "a", "", "b"]',
    'playCraps 2 2 1 2 3 4': '1',
    'playCraps 2 2 3 4': '1',
  },
  stops: {
    'reverseList 1 2 3 4 5': ['left number=1, right number=5', 'left number=2, right number=4', 'left number=3, right number=3', 'left number=4, right number=2', 'left number=5, right number=1'],
    'splitString , a,b,c': ['piece="a"', 'piece="b"'],
    'splitString , ,a,,b': ['piece=""', 'piece="a"', 'piece=""'],
    'playCraps 2 2 3 4': ['dice count=4'],
  },
  changed: { 'splitString , a,b,c': '["x", "b", "c"]', 'playCraps 2 2 1 2 3 4': '1' },
};

module.exports = { IMPORT_ID, USERNAME, CODE, formAPlan, brokenPlan, crapsQuestion, okRecord, MILESTONE, RUNTIME, REV_BAD, SPLIT_MAIN };
