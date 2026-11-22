#!/usr/bin/env node
// Makes fake GitHub Classroom repositories from the fake submissions (v01 to v10) to test the import pipeline, and a fake roster CSV in the
// format of the GitHub Classroom assignment export. Everything is written OUTSIDE the repo folder (the repo is public): the script
// refuses an output folder inside it.
//
//   node scripts/eval/a2/make-test-repos.js [--out D:/a2-pilot-test/repos] [--roster D:/a2-pilot-test/roster.csv] [--deadline 2026-03-01T23:59:00Z]
//
// The cases (each repo is named assignment-02-<fakeusername>):
//   fakeuser01 v01  normal                                   fakeuser06 v06  every commit is AFTER the deadline (no usable version)
//   fakeuser02 v02  extra commit after the deadline          fakeuser07 v07  normal
//   fakeuser03 v03  extra commit after the deadline          fakeuser08 v08  playCraps is missing (mode is needed)
//   fakeuser04 v04  functions.h declares splitString          fakeuser09 v09  functions.cpp does not compile
//                   differently from the spec prototype      fakeuser10 v10  normal (unfinished splitString)
//   fakeuser05 v05  normal                                   fakeuser11 v01  only splitString has a syntax error (the rest is correct)
//                                                           fakeuser12 v02  every function has a syntax error
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const A2 = __dirname;
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DAY = 24 * 3600 * 1000;

function parseArgs(argv) {
  const base = process.platform === 'win32' ? 'D:/a2-pilot-test' : path.join(os.tmpdir(), 'a2-pilot-test');
  const args = { out: `${base}/repos`, roster: `${base}/roster.csv`, deadline: '2026-03-01T23:59:00Z' };
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--out', '--roster', '--deadline'].includes(argv[i])) throw new Error(`unknown argument ${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

const insideRepo = (p) => { const rel = path.relative(REPO_ROOT, path.resolve(p)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

const OFFICIAL_HEADER = fs.readFileSync(path.join(A2, 'reference', 'functions.h'), 'utf8');
const STARTER_CPP = `#include "functions.h"

// TODO: write the four functions of Assignment 02.
void reverseList(vector<int>& vec) {
}

vector<string> splitString(string str, char delim) {
    return {};
}

int playCraps(const vector<int>& rolls) {
    return -1;
}

int mode(const vector<int>& vec) {
    return 0;
}
`;
const MAIN_CPP = `#include <iostream>
#include "functions.h"

int main() {
    vector<int> v = {10, 20, 30};
    reverseList(v);
    for (int x : v) cout << x << " ";
    cout << endl;
    cout << mode(v) << endl;
    return 0;
}
`;

/** functions.cpp without the playCraps function. */
const withoutPlayCraps = (cpp) => cpp.replace(/int playCraps\(const vector<int>& rolls\) \{[\s\S]*?\n\}\n\n?/, '');
/** The same file with a late edit that would change the results if it were imported. */
const lateEdit = (cpp) => `${cpp}\n// late edit after the deadline\n`.replace(/(int mode\(const vector<int>& vec\) \{)/, '$1\n    return 0;  // late edit');
const brokenCpp = (cpp) => `${cpp}\nint oops = ;\n`;
/** A syntax error (a missing semicolon) inside splitString only. */
const brokenSplitString = (cpp) => cpp.replace(/(vector<string> splitString\([^)]*\) \{[\s\S]*?)(parts\.push_back\(current\));/, '$1$2');
/** A syntax error as the first statement of every function. */
const brokenEveryFunction = (cpp) => cpp.replace(/^((?:void|int|vector<string>) (?:reverseList|splitString|playCraps|mode)\([^)]*\) \{)$/gm, '$1\n    int oops = ;');
/** The header with splitString declared with a const reference (the spec prototype takes the string by value). */
const differentHeader = (h) => h.replace('vector<string> splitString(string str, char delim);', 'vector<string> splitString(const string& str, char delim);');

const PLAN = [
  { n: 1, variant: 'v01-correct-a' },
  { n: 2, variant: 'v02-correct-b', late: 'edit' },
  { n: 3, variant: 'v03-reverse-loop-to-end', late: 'edit' },
  { n: 4, variant: 'v04-reverse-sizet-empty', header: differentHeader },
  { n: 5, variant: 'v05-split-drops-last' },
  { n: 6, variant: 'v06-split-skips-empty', allLate: true },
  { n: 7, variant: 'v07-craps-validates-first-two' },
  { n: 8, variant: 'v08-craps-more-rolls-returns-0', cpp: withoutPlayCraps },
  { n: 9, variant: 'v09-mode-ties-larger', cpp: brokenCpp },
  { n: 10, variant: 'v10-split-stub' },
  { n: 11, variant: 'v01-correct-a', cpp: brokenSplitString },
  { n: 12, variant: 'v02-correct-b', cpp: brokenEveryFunction },
];

function git(dir, args, date) {
  const env = { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) };
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=Fake Student', '-c', 'user.email=fake@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function commitFiles(dir, files, message, date) {
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message], date);
}

function makeRepo(out, deadlineMs, item) {
  const user = `fakeuser${String(item.n).padStart(2, '0')}`;
  const dir = path.join(out, `assignment-02-${user}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  const vdir = path.join(A2, 'variants', item.variant);
  const finalCpp = (item.cpp || ((x) => x))(fs.readFileSync(path.join(vdir, 'functions.cpp'), 'utf8'));
  const finalHeader = (item.header || ((x) => x))(OFFICIAL_HEADER);
  const at = (offsetMs) => new Date(deadlineMs + offsetMs).toISOString();
  const early = item.allLate ? 3600 * 1000 : -14 * DAY; // the repo made after the deadline: nothing before it
  const mid = item.allLate ? DAY : -5 * DAY;
  const last = item.allLate ? 2 * DAY : -1 * DAY;
  commitFiles(dir, { 'functions.h': OFFICIAL_HEADER, 'functions.cpp': STARTER_CPP, 'main.cpp': MAIN_CPP, 'README.md': '# Assignment 02 (fake test repository)\n' }, 'Initial commit', at(early));
  commitFiles(dir, { 'functions.cpp': `${STARTER_CPP}\n// work in progress\n` }, 'work in progress', at(mid));
  commitFiles(dir, { 'functions.h': finalHeader, 'functions.cpp': finalCpp }, 'finish all four functions', at(last));
  if (item.late === 'edit') commitFiles(dir, { 'functions.cpp': lateEdit(finalCpp) }, 'late fix', at(2 * 3600 * 1000));
  return { user, dir, lastBeforeDeadline: at(last) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (insideRepo(args.out) || insideRepo(args.roster)) throw new Error('refusing to write fake repositories or the roster inside the repo folder (the repo is public)');
  const deadlineMs = Date.parse(args.deadline);
  if (Number.isNaN(deadlineMs)) throw new Error(`--deadline is not a date: ${args.deadline}`);
  fs.mkdirSync(args.out, { recursive: true });
  const made = PLAN.map((item) => makeRepo(args.out, deadlineMs, item));

  // The GitHub Classroom assignment export (CSV). Points are left empty: the import never reads them.
  const header = 'assignment_name,assignment_url,starter_code_url,github_username,roster_identifier,student_repository_name,student_repository_url,submission_timestamp,points_awarded,points_available';
  const rows = made.map((m, i) => ['Assignment 02 (fake)', 'https://classroom.example.invalid/a/fake', 'https://github.example.invalid/fake/starter', m.user, `F${String(1000 + i + 1)}`, `assignment-02-${m.user}`, `https://github.example.invalid/fake/assignment-02-${m.user}`, m.lastBeforeDeadline, '', ''].join(','));
  rows.push(['Assignment 02 (fake)', 'https://classroom.example.invalid/a/fake', 'https://github.example.invalid/fake/starter', 'fakeuser13', 'F1013', 'assignment-02-fakeuser13', 'https://github.example.invalid/fake/assignment-02-fakeuser13', '', '', ''].join(','));
  fs.mkdirSync(path.dirname(args.roster), { recursive: true });
  fs.writeFileSync(args.roster, `${header}\n${rows.join('\n')}\n`);

  console.log(`${made.length} fake repositories in ${args.out}\nroster: ${args.roster}\ndeadline: ${args.deadline}`);
  console.log(`\nnode scripts/a2-import/import.js --repos ${args.out} --deadline ${args.deadline} --roster ${args.roster} --dry-run`);
}

module.exports = { PLAN, parseArgs, insideRepo };

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exit(1); }
}
