/**
 * The evaluation cases. Case 1 is the sample program used by the mock interview script; the others
 * live in this folder. Each case: a C++ program, an interview config (same format as the
 * `interview` field on an assessment) and a scripted-student file.
 */
const fs = require('fs');
const path = require('path');
const { parseInterview } = require('../../../shared/nodejs/utils/interview-config');

const scripts = path.resolve(__dirname, '../..');
const students = path.resolve(__dirname, '../students');

const CASES = [
  {
    id: 'case1',
    title: 'Linked list (sample)',
    codeFile: path.join(scripts, 'sample.cpp'),
    configFile: path.join(scripts, 'sample-interview.json'),
    studentsFile: path.join(students, 'case1.json'),
  },
  {
    id: 'case2',
    title: 'Array-based stack with a capacity check',
    codeFile: path.join(__dirname, 'array-stack.cpp'),
    configFile: path.join(__dirname, 'array-stack.json'),
    studentsFile: path.join(students, 'case2.json'),
  },
  {
    id: 'case3',
    title: 'Word counter (contains a bug)',
    codeFile: path.join(__dirname, 'word-count.cpp'),
    configFile: path.join(__dirname, 'word-count.json'),
    studentsFile: path.join(students, 'case3.json'),
  },
  {
    id: 'case4',
    title: 'Tank fill controller (state machine)',
    codeFile: path.join(__dirname, 'tank-controller.cpp'),
    configFile: path.join(__dirname, 'tank-controller.json'),
    testsFile: path.join(__dirname, 'tank-controller.tests.json'),
    studentsFile: path.join(students, 'case4.json'),
  },
  {
    // Same problem, statement, questions and tests as case 4; the student's step ends with `return TankState::IDLE;`.
    id: 'case5',
    title: 'Tank fill controller (bug: returns IDLE between the levels)',
    codeFile: path.join(__dirname, 'tank-controller-bug.cpp'),
    configFile: path.join(__dirname, 'tank-controller.json'),
    testsFile: path.join(__dirname, 'tank-controller.tests.json'),
    studentsFile: path.join(students, 'case5.json'),
  },
  // Cases 6 to 9: the same problem, statement, questions, rubric and gaps as case 4, each submission with ONE bug. The tests file of each
  // holds what that buggy program prints (the lines the statement expects are in tank-controller.tests.json).
  ...[
    ['case6', 'Tank fill controller (bug: reading > s.high, 80 does not stop the pump)', 'tank-controller-gt.cpp'],
    ['case7', 'Tank fill controller (bug: ALARM does not stick)', 'tank-controller-alarm.cpp'],
    ['case8', 'Tank fill controller (bug: isValid rejects exactly max)', 'tank-controller-max.cpp'],
    ['case9', 'Tank fill controller (bug: a pump start is counted on every FILLING reading)', 'tank-controller-count.cpp'],
  ].map(([id, title, codeFile]) => ({
    id,
    title,
    codeFile: path.join(__dirname, codeFile),
    configFile: path.join(__dirname, 'tank-controller.json'),
    testsFile: path.join(__dirname, `tank-controller.tests.${id}.json`),
    studentsFile: path.join(students, `${id}.json`),
  })),
];

// Cases 10 and 11 (host.v6 material): the tank controller with unfinished code. They are extra cases: `--cases all` and the
// established tests do not include them, `--cases case10,case11` does. The scripted students are case 4's (the strong answers describe
// how the controller should work, which is exactly "how I intended it to work"), and the submission carries what the grader would have
// stored, so the engine can classify the code.
const EXTRA_CASES = [
  {
    id: 'case10',
    title: 'Tank fill controller (unfinished: step is an empty function with a TODO)',
    codeFile: path.join(__dirname, 'tank-controller-stub.cpp'),
    configFile: path.join(__dirname, 'tank-controller.json'),
    testsFile: path.join(__dirname, 'tank-controller.tests.json'),
    studentsFile: path.join(students, 'case4.json'),
    extra: true,
    submission: { passedTests: 1, totalTests: 7, testResults: [{ status: 'Runtime Error' }, { status: 'Accepted' }] },
  },
  {
    id: 'case11',
    title: 'Tank fill controller (unfinished: does not compile, a semicolon is missing)',
    codeFile: path.join(__dirname, 'tank-controller-nocompile.cpp'),
    configFile: path.join(__dirname, 'tank-controller.json'),
    testsFile: path.join(__dirname, 'tank-controller.tests.json'),
    studentsFile: path.join(students, 'case4.json'),
    extra: true,
    submission: { passedTests: 0, totalTests: 7, testResults: [{ status: 'Compilation Error' }, { status: 'Compilation Error' }] },
  },
];
const ALL_CASES = [...CASES, ...EXTRA_CASES]; // CASES (exported) stays the established set

/** The ids of the established cases (what `--cases all` means); with includeExtra also the host.v6 material (cases 10 and 11). */
function caseIds({ includeExtra = false } = {}) {
  return (includeExtra ? ALL_CASES : CASES).map((c) => c.id);
}

/** Flat list of the main questions in the order they are asked. */
function mainQuestionsOf(config) {
  const list = [];
  config.themes.forEach((theme) => {
    theme.mainQuestions.forEach((question, index) => {
      list.push({
        themeId: theme.id,
        themeTitle: theme.title,
        question,
        criteria: theme.criteria,
        // What a full answer must say, [{ id: 'r1', text }] (host.v4 only; empty when the case has none)
        rubric: (theme.rubric && theme.rubric[index]) || [],
      });
    });
  });
  return list;
}

/** The rubric of a theme: one list of { id, text } per main question, ids r1, r2, ... in order. */
function checkRubric(rubric, theme, where) {
  if (!Array.isArray(rubric) || rubric.length !== theme.mainQuestions.length) {
    throw new Error(`${where}: rubric needs one list per main question (${theme.mainQuestions.length})`);
  }
  rubric.forEach((list, q) => {
    const ok = Array.isArray(list) && list.length > 0
      && list.every((item, i) => item && item.id === `r${i + 1}` && typeof item.text === 'string' && item.text.trim());
    if (!ok) throw new Error(`${where}: rubric for main question ${q + 1} must be a list of { id: "r1", text }, { id: "r2", text }, ...`);
  });
  return rubric;
}

/** Load a case: program, validated config and scripted students. */
function loadCase(id) {
  const entry = ALL_CASES.find((c) => c.id === id);
  if (!entry) throw new Error(`Unknown case "${id}". Available: ${caseIds({ includeExtra: true }).join(', ')}`);

  const parsed = parseInterview(JSON.parse(fs.readFileSync(entry.configFile, 'utf8')), { language: 'cpp' });
  if (parsed.error) throw new Error(`Case ${id}: invalid interview config: ${parsed.error}`);

  const rawConfig = JSON.parse(fs.readFileSync(entry.configFile, 'utf8'));
  // The rubric sits next to the criteria in the theme: one list per main question. The shared config parser
  // does not know it, so it is copied over here and travels with the config snapshot of the interview.
  parsed.value.themes.forEach((theme, i) => {
    const rubric = rawConfig.themes[i].rubric;
    if (rubric !== undefined) theme.rubric = checkRubric(rubric, theme, `${id} theme ${theme.id}`);
  });
  return {
    id: entry.id,
    // One question per main question, asked by the fixed-survey baseline (the engine ignores this key).
    fixedFollowUps: rawConfig.fixedFollowUps || [],
    title: entry.title,
    codeFile: entry.codeFile,
    configFile: entry.configFile,
    code: fs.readFileSync(entry.codeFile, 'utf8'),
    config: parsed.value,
    mains: mainQuestionsOf(parsed.value),
    studentsRaw: JSON.parse(fs.readFileSync(entry.studentsFile, 'utf8')),
    // What the grader stored for this submission (compile result, tests passed), for the cases where it matters (10 and 11).
    submission: entry.submission || {},
    // Input and expected output of the program's tests. Stored for later: nothing runs them yet.
    tests: entry.testsFile ? JSON.parse(fs.readFileSync(entry.testsFile, 'utf8')).tests : [],
    // The tests the statement expects (the tank controller's seven tests), for the grader's result the interview is given (host.v7 reads it).
    officialTests: /tank-controller\.json$/.test(entry.configFile)
      ? JSON.parse(fs.readFileSync(path.join(__dirname, 'tank-controller.tests.json'), 'utf8')).tests
      : [],
  };
}

module.exports = { CASES, caseIds, loadCase, mainQuestionsOf };
