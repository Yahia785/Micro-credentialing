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
];

function caseIds() {
  return CASES.map((c) => c.id);
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
  const entry = CASES.find((c) => c.id === id);
  if (!entry) throw new Error(`Unknown case "${id}". Available: ${caseIds().join(', ')}`);

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
    // Input and expected output of the program's tests. Stored for later: nothing runs them yet.
    tests: entry.testsFile ? JSON.parse(fs.readFileSync(entry.testsFile, 'utf8')).tests : [],
  };
}

module.exports = { CASES, caseIds, loadCase, mainQuestionsOf };
