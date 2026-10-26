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
];

function caseIds() {
  return CASES.map((c) => c.id);
}

/** Flat list of the main questions in the order they are asked. */
function mainQuestionsOf(config) {
  const list = [];
  config.themes.forEach((theme) => {
    theme.mainQuestions.forEach((question) => {
      list.push({ themeId: theme.id, themeTitle: theme.title, question, criteria: theme.criteria });
    });
  });
  return list;
}

/** Load a case: program, validated config and scripted students. */
function loadCase(id) {
  const entry = CASES.find((c) => c.id === id);
  if (!entry) throw new Error(`Unknown case "${id}". Available: ${caseIds().join(', ')}`);

  const parsed = parseInterview(JSON.parse(fs.readFileSync(entry.configFile, 'utf8')), { language: 'cpp' });
  if (parsed.error) throw new Error(`Case ${id}: invalid interview config: ${parsed.error}`);

  return {
    id: entry.id,
    title: entry.title,
    codeFile: entry.codeFile,
    configFile: entry.configFile,
    code: fs.readFileSync(entry.codeFile, 'utf8'),
    config: parsed.value,
    mains: mainQuestionsOf(parsed.value),
    studentsRaw: JSON.parse(fs.readFileSync(entry.studentsFile, 'utf8')),
  };
}

module.exports = { CASES, caseIds, loadCase, mainQuestionsOf };
