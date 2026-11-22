const lib = '../../../scripts/a2-import/lib';
const { splitFunctions, helpersOf, composeFile, calledNames } = require(`${lib}/split`);
const { analyzeSubmission, firstError } = require(`${lib}/analyze`);
const { importRepo } = require(`${lib}/import-repo`);
const { STATUS } = require(`${lib}/record`);

const OFFICIAL = '#ifndef FUNCTIONS_H\n#define FUNCTIONS_H\n#include <vector>\n#include <string>\nusing namespace std;\nvoid reverseList(vector<int>& vec);\nvector<string> splitString(string str, char delim);\nint playCraps(const vector<int>& rolls);\nint mode(const vector<int>& vec);\n#endif\n';
const DRIVER = '#include "functions.h"\nint main() { return 0; }\n';
const INPUTS = [
  { function: 'reverseList', cmd: 'reverseList 1 2', spec: '[2, 1]' },
  { function: 'splitString', cmd: 'splitString , a,b', spec: '["a", "b"]' },
  { function: 'playCraps', cmd: 'playCraps 5 6', spec: '0' },
  { function: 'mode', cmd: 'mode 5', spec: '5' },
];

// A whole student file. Line numbers (1-based) matter in the tests below.
const FILE = [
  '#include "functions.h"', // 1
  '#include <algorithm>', // 2
  'using namespace std;', // 3
  'const int LIMIT = 6;', // 4
  'struct Pair { int a; int b; };', // 5
  '', // 6
  'void reverseList(vector<int>& vec) {', // 7
  '    reverse(vec.begin(), vec.end()); // { not a brace', // 8
  '}', // 9
  '', // 10
  'vector<string> splitString(string str, char delim) {', // 11
  '    string brace = "}{";', // 12
  '    return {str};', // 13
  '}', // 14
  '', // 15
  'int playCraps(const vector<int>& rolls) {', // 16
  '    return rolls.empty() ? 2 : 0;', // 17
  '}', // 18
  '', // 19
  'int mode(const vector<int>& vec) {', // 20
  '    return vec[0];', // 21
  '}', // 22
  '',
].join('\n');

describe('splitFunctions', () => {
  test('finds every top-level function with its name and its first and last line', () => {
    const split = splitFunctions(FILE);
    expect(split.ok).toBe(true);
    expect(split.functions.map((f) => [f.name, f.startLine, f.endLine])).toEqual([
      ['reverseList', 7, 9], ['splitString', 11, 14], ['playCraps', 16, 18], ['mode', 20, 22],
    ]);
  });

  test('braces inside comments and strings do not count, and a struct, a global and a preprocessor line are not functions', () => {
    const code = [
      '#define TWICE(x) \\', // 1
      '    ((x) * 2)', // 2
      'int table[] = { 1, 2, 3 };', // 3
      'struct Box { int w; int h() const { return w; } };', // 4
      'namespace util { int one() { return 1; } }', // 5
      '/* } } } */', // 6
      'int f(int x) {', // 7
      '    const char* s = "}}}";', // 8
      '    char c = \'}\';', // 9
      '    return x; // }', // 10
      '}', // 11
    ].join('\n');
    const split = splitFunctions(code);
    expect(split.ok).toBe(true);
    expect(split.functions.map((f) => [f.name, f.startLine, f.endLine])).toEqual([['f', 7, 11]]);
  });

  test('a function with const, templates and a trailing return type is found by its name', () => {
    const code = 'template <class T>\nT biggest(T a, T b) {\n  return a > b ? a : b;\n}\nauto twice(int x) -> int {\n  return x * 2;\n}\n';
    expect(splitFunctions(code).functions.map((f) => f.name)).toEqual(['biggest', 'twice']);
  });

  test('braces that never balance are a reason, not a guess', () => {
    const open = splitFunctions('int f() {\n  if (1) {\n  return 1;\n}\n');
    expect(open.ok).toBe(false);
    expect(open.reason).toContain('never closed');
    const extra = splitFunctions('int f() { return 1; }\n}\n');
    expect(extra.ok).toBe(false);
    expect(extra.reason).toContain('no "{"');
  });

  test('a syntax error inside a function body does not stop the split', () => {
    const split = splitFunctions('int f(int x) {\n  int y = ;\n  return x\n}\nint g() { return 1; }\n');
    expect(split.ok).toBe(true);
    expect(split.functions.map((f) => f.name)).toEqual(['f', 'g']);
  });

  test('CRLF files are split the same way', () => {
    expect(splitFunctions(FILE.replace(/\n/g, '\r\n')).functions.map((f) => f.startLine)).toEqual([7, 11, 16, 20]);
  });
});

describe('helper detection', () => {
  const code = [
    'int leaf(int x) { return x + 1; }', // leaf
    'int middle(int x) { return leaf(x) * 2; }',
    'int other(int x) { return x; }',
    'int top(int x) {',
    '    for (int i = 0; i < 3; i++) { if (i == 1) continue; }',
    '    return middle(x) + sizeof(int);',
    '}',
  ].join('\n');
  const split = splitFunctions(code);
  const byName = (n) => split.functions.find((f) => f.name === n);

  test('calledNames ignores keywords', () => {
    expect([...calledNames(byName('top').body)]).toEqual(['middle']);
  });

  test('the helpers of a function are the functions it calls and, in turn, they call (in file order)', () => {
    expect(helpersOf(byName('top'), split.functions).map((f) => f.name)).toEqual(['leaf', 'middle']);
    expect(helpersOf(byName('leaf'), split.functions)).toEqual([]);
  });

  test('recursion and a call to itself are not a helper', () => {
    const rec = splitFunctions('int f(int n) { return n ? f(n - 1) : 0; }\n');
    expect(helpersOf(rec.functions[0], rec.functions)).toEqual([]);
  });
});

describe('composeFile keeps the student\'s line numbers', () => {
  const split = splitFunctions(FILE);
  const keep = (...names) => split.functions.filter((f) => names.includes(f.name));

  test('every function that is not kept is blanked line by line; the top part and the kept ones are untouched', () => {
    const lines = composeFile(split, keep('playCraps')).split('\n');
    expect(lines).toHaveLength(FILE.split('\n').length);
    const original = FILE.split('\n');
    [1, 2, 3, 4, 5, 16, 17, 18].forEach((n) => expect(lines[n - 1]).toBe(original[n - 1]));
    [7, 8, 9, 11, 12, 13, 14, 20, 21, 22].forEach((n) => expect(lines[n - 1].trim()).toBe(''));
  });

  test('keeping nothing leaves only the top part', () => {
    const out = composeFile(split, []);
    expect(out).toContain('const int LIMIT = 6;');
    expect(out).not.toMatch(/reverseList|splitString|playCraps|mode/);
  });
});

describe('firstError', () => {
  test('is the first error in functions.cpp: its line and the message, without any source line', () => {
    const out = "functions.cpp: In function 'x':\nfunctions.cpp:24:19: error: expected ';' before 'current'\n   24 |             parts.push_back(current)\n      |                                     ^\nfunctions.cpp:30:5: error: second\n";
    expect(firstError(out)).toEqual({ line: 24, message: "expected ';' before 'current'" });
  });

  test('an error that is not in functions.cpp has no line; no error at all says so', () => {
    expect(firstError("driver.cpp:75:20: error: call of overloaded 'f()' is ambiguous")).toEqual({ line: null, message: "driver.cpp: call of overloaded 'f()' is ambiguous" });
    expect(firstError('')).toEqual({ line: null, message: 'did not compile' });
  });
});

describe('analyzeSubmission when the whole file does not compile', () => {
  // A fake compiler: the source fails when it contains BROKEN (the error is on the line where BROKEN is, as the #line directive makes it),
  // or when it calls brokenHelper without defining it.
  const fakeDocker = () => ({
    compile: jest.fn(async (source) => {
      const lines = source.split('\n');
      const start = lines.indexOf('#line 1 "functions.cpp"');
      const at = lines.findIndex((l, i) => i > start && l.includes('BROKEN'));
      if (at >= 0) return { ok: false, errors: `functions.cpp:${at - start}:5: error: expected ';' before 'BROKEN'\n   ${at - start} | BROKEN\n` };
      if (source.includes('brokenHelper(') && !source.includes('int brokenHelper')) return { ok: false, errors: "functions.cpp:5:5: error: 'brokenHelper' was not declared in this scope\n" };
      return { ok: true, errors: '' };
    }),
    runInputs: jest.fn(async ({ cmds }) => ({ sanCompile: { ok: true }, plainCompile: { ok: true }, runs: cmds.map(() => ({ san: { code: 0, stderr: '' }, plain: { code: 0, stdout: 'x\n' } })) })),
    cleanup: jest.fn(),
  });
  const run = (code, docker) => analyzeSubmission({ studentHeader: OFFICIAL, studentCode: code, officialHeader: OFFICIAL, driver: DRIVER, inputs: INPUTS, docker });
  const lineOf = (code, text) => code.split('\n').findIndex((l) => l.includes(text)) + 1;

  test('only splitString is broken: the other three compile alone, splitString has its error and its line, status file_does_not_compile', async () => {
    const code = FILE.replace('    return {str};', '    BROKEN return {str};');
    const docker = fakeDocker();
    const a = await run(code, docker);
    expect(a.status).toBe(STATUS.FILE_DOES_NOT_COMPILE);
    expect(a.functions.reverseList).toMatchObject({ present: true, compilesAlone: true, firstError: null });
    expect(a.functions.playCraps.compilesAlone).toBe(true);
    expect(a.functions.mode.compilesAlone).toBe(true);
    expect(a.functions.splitString).toMatchObject({ present: true, compilesAlone: false, compiles: false });
    expect(a.functions.splitString.firstError).toEqual({ line: lineOf(code, 'BROKEN'), message: "expected ';' before 'BROKEN'" });
    expect(a.functions.splitString.firstError.line).toBe(13); // the line in the student's own file
    expect(a.modeNeeded).toBe(false); // splitString exists, it only does not compile: that gets a compile-error question, not mode
    expect(a.outsideFunctionsError).toBeNull();
    expect(JSON.stringify(a.functions)).not.toContain('return {str}'); // no source line is stored
  });

  test('the line number of an error matches the student\'s file in the program that was compiled', async () => {
    const code = FILE.replace('    return {str};', '    BROKEN return {str};');
    const docker = fakeDocker();
    await run(code, docker);
    const broken = docker.compile.mock.calls.map((c) => c[0]).find((s) => s.includes('BROKEN'));
    const lines = broken.split('\n');
    const start = lines.indexOf('#line 1 "functions.cpp"');
    expect(lines[start + 13]).toContain('BROKEN'); // line 13 of the student's file is 13 lines after the #line directive
    expect(lines[start + 7]).toBe('    reverse(vec.begin(), vec.end()); // { not a brace'.replace(/.*/, lines[start + 7])); // sanity: the line exists
    expect(lines[start + 1]).toBe(''); // line 1 (the include of functions.h) is blanked, not deleted
  });

  test('sanitizer and plain runs happen only for the functions that compile alone, each with its own program', async () => {
    const docker = fakeDocker();
    const a = await run(FILE.replace('    return {str};', '    BROKEN return {str};'), docker);
    const ran = docker.runInputs.mock.calls.map((c) => c[0]);
    expect(ran.map((r) => r.cmds[0].split(' ')[0]).sort()).toEqual(['mode', 'playCraps', 'reverseList']);
    const forMode = ran.find((r) => r.cmds[0].startsWith('mode')).source;
    expect(forMode).toContain('#define A2_NO_REVERSELIST 1');
    expect(forMode).not.toContain('#define A2_NO_MODE');
    expect(forMode).toContain('return vec[0];');
    expect(forMode).not.toContain('reverse(vec.begin()'); // the other functions are blanked
    expect(a.inputs.map((i) => i.function).sort()).toEqual(['mode', 'playCraps', 'reverseList']);
    expect(a.inputs.every((i) => i.sanitizer.status === 'ok')).toBe(true);
  });

  test('every function broken: nothing_compiles, each function has its error, nothing is run', async () => {
    const code = FILE.split('\n').map((l) => (/^\s+(reverse|return|string brace)/.test(l) ? `${l} BROKEN` : l)).join('\n');
    const docker = fakeDocker();
    const a = await run(code, docker);
    expect(a.status).toBe(STATUS.NOTHING_COMPILES);
    expect(FUNCTIONS_ALL.every((fn) => a.functions[fn].compilesAlone === false && a.functions[fn].firstError.line > 0)).toBe(true);
    expect(a.functions.reverseList.firstError.line).toBe(8);
    expect(a.functions.mode.firstError.line).toBe(21);
    expect(a.modeNeeded).toBe(false); // every function exists, so mode is not needed
    expect(docker.runInputs).not.toHaveBeenCalled();
  });

  test('a helper that compiles on its own is kept with the function that calls it; a broken helper is left out and reported', async () => {
    const code = [
      '#include "functions.h"', // 1
      'int goodHelper(int x) { return x + 1; }', // 2
      'int brokenHelper(int x) { BROKEN return x; }', // 3
      'void reverseList(vector<int>& vec) { vec.push_back(goodHelper(1)); }', // 4
      'vector<string> splitString(string str, char delim) { return {str}; }', // 5
      'int playCraps(const vector<int>& rolls) { return brokenHelper(2); }', // 6
      'int mode(const vector<int>& vec) { return vec[0]; }', // 7
    ].join('\n');
    const docker = fakeDocker();
    const a = await run(code, docker);
    expect(a.status).toBe(STATUS.FILE_DOES_NOT_COMPILE);
    expect(a.functions.reverseList.compilesAlone).toBe(true);
    const forReverse = docker.runInputs.mock.calls.map((c) => c[0]).find((r) => r.cmds[0].startsWith('reverseList')).source;
    expect(forReverse).toContain('int goodHelper'); // the helper it calls is in the program
    expect(forReverse).not.toContain('int brokenHelper');
    expect(a.functions.playCraps).toMatchObject({ compilesAlone: false, brokenHelpers: ['brokenHelper'] });
    expect(a.functions.splitString.compilesAlone).toBe(true);
  });

  test('a file whose braces do not balance cannot be split: nothing_compiles with that reason', async () => {
    const docker = { compile: jest.fn(async () => ({ ok: false, errors: "functions.cpp:3:1: error: expected '}' at end of input" })), runInputs: jest.fn(), cleanup: jest.fn() };
    const a = await run('#include "functions.h"\nint mode(const vector<int>& vec) {\n  return 1;\n', docker);
    expect(a.status).toBe(STATUS.NOTHING_COMPILES);
    expect(a.functions.mode.firstError.message).toContain('could not split');
    expect(a.splitNote).toContain('never closed');
    expect(a.modeNeeded).toBeNull(); // not known: the file could not be split
    expect(docker.runInputs).not.toHaveBeenCalled();
  });

  test('a function that is not in the file at all does not compile alone and says so', async () => {
    const a = await run(FILE.replace(/int mode[\s\S]*?\n\}\n/, '').replace('    return {str};', '    BROKEN return {str};'), fakeDocker());
    expect(a.functions.mode).toMatchObject({ present: false, compilesAlone: false });
    expect(a.functions.mode.firstError.message).toContain('no definition of mode');
    expect(a.modeNeeded).toBe(false); // mode is the backup itself
  });

  test('mode is needed when an interview function has no definition at all', async () => {
    const a = await run(FILE.replace(/int playCraps[\s\S]*?\n\}\n/, '').replace('    return {str};', '    BROKEN return {str};'), fakeDocker());
    expect(a.functions.playCraps).toMatchObject({ present: false, compilesAlone: false });
    expect(a.functions.splitString).toMatchObject({ present: true, compilesAlone: false }); // exists, does not compile
    expect(a.modeNeeded).toBe(true);
  });

  test('a file that compiles as a whole is still "ok" and is not split', async () => {
    const docker = fakeDocker();
    const a = await run(FILE, docker);
    expect(a.status).toBe('ok');
    expect(a.functions.splitString.present).toBe(true);
    expect(a.functions.splitString).not.toHaveProperty('compilesAlone');
    expect(docker.compile).toHaveBeenCalledTimes(1);
  });
});

const FUNCTIONS_ALL = ['reverseList', 'splitString', 'playCraps', 'mode'];

describe('an error outside the functions', () => {
  const fakeDocker = () => ({
    compile: jest.fn(async (source) => {
      const lines = source.split('\n');
      const start = lines.indexOf('#line 1 "functions.cpp"');
      const at = lines.findIndex((l, i) => i > start && l.includes('BROKEN'));
      if (at >= 0) return { ok: false, errors: 'functions.cpp:' + (at - start) + ":5: error: expected ';' before 'BROKEN'\n" };
      return { ok: true, errors: '' };
    }),
    runInputs: jest.fn(async ({ cmds }) => ({ sanCompile: { ok: true }, plainCompile: { ok: true }, runs: cmds.map(() => ({ san: { code: 0, stderr: '' }, plain: { code: 0, stdout: 'x\n' } })) })),
    cleanup: jest.fn(),
  });
  const run = (code, docker) => analyzeSubmission({ studentHeader: OFFICIAL, studentCode: code, officialHeader: OFFICIAL, driver: DRIVER, inputs: INPUTS, docker });
  // FILE with a broken global between the struct and the first function (line 6)
  const WITH_BAD_GLOBAL = FILE.split('\n').map((l, i) => (i === 5 ? 'int broken = BROKEN;' : l)).join('\n');

  test('composeFile with a minimal top keeps only the #include and using lines outside the functions, and every line number', () => {
    const code = ['#include <algorithm>', '#define LIMIT 6', 'using namespace std;', 'int global = 3;', 'struct P { int a; };', 'int f() {', '  return LIMIT;', '}', ''].join('\n');
    const split = splitFunctions(code);
    const out = composeFile(split, split.functions, { minimalTop: true }).split('\n');
    expect(out).toHaveLength(code.split('\n').length);
    expect(out[0]).toBe('#include <algorithm>');
    expect(out[2]).toBe('using namespace std;');
    [1, 3, 4].forEach((n) => expect(out[n].trim()).toBe(''));
    expect(out.slice(5, 8)).toEqual(['int f() {', '  return LIMIT;', '}']);
  });

  test('the error in the top part is recorded once at file level; every function then compiles alone; status file_does_not_compile', async () => {
    const docker = fakeDocker();
    const a = await run(WITH_BAD_GLOBAL, docker);
    expect(a.status).toBe(STATUS.FILE_DOES_NOT_COMPILE);
    expect(a.outsideFunctionsError).toEqual({ line: 6, message: "expected ';' before 'BROKEN'" });
    FUNCTIONS_ALL.forEach((fn) => expect(a.functions[fn]).toMatchObject({ present: true, compilesAlone: true, firstError: null }));
    expect(JSON.stringify(a.functions)).not.toContain('BROKEN'); // not repeated on each function
    expect(a.modeNeeded).toBe(false);
    // the sanitizer and plain runs use the reduced test build, which has no broken global
    expect(docker.runInputs.mock.calls.every((c) => !c[0].source.includes('BROKEN'))).toBe(true);
    expect(a.inputs.map((i) => i.function).sort()).toEqual(['mode', 'playCraps', 'reverseList', 'splitString']);
  });

  test('line numbers in the reduced build still match the student\'s file', async () => {
    const docker = fakeDocker();
    await run(WITH_BAD_GLOBAL, docker);
    const lines = docker.runInputs.mock.calls.map((c) => c[0].source).find((s) => s.includes('return vec[0];')).split('\n');
    const start = lines.indexOf('#line 1 "functions.cpp"');
    expect(lines[start + 21]).toBe('    return vec[0];'); // line 21 of the student's file
    expect(lines[start + 6].trim()).toBe(''); // the broken global (line 6) is blanked, not deleted
  });

  test('a function with its own error keeps it even when the top part is broken too', async () => {
    const code = WITH_BAD_GLOBAL.replace('    return {str};', '    BROKEN return {str};');
    const a = await run(code, fakeDocker());
    expect(a.status).toBe(STATUS.FILE_DOES_NOT_COMPILE);
    expect(a.outsideFunctionsError.line).toBe(6);
    expect(a.functions.splitString).toMatchObject({ compilesAlone: false, firstError: { line: 13 } });
    expect(a.functions.mode.compilesAlone).toBe(true);
  });

  test('an #include line that is itself broken still blocks everything: nothing_compiles, error recorded once', async () => {
    const code = FILE.replace('#include <algorithm>', '#include <BROKEN>');
    const a = await run(code, fakeDocker());
    expect(a.status).toBe(STATUS.NOTHING_COMPILES);
    expect(a.outsideFunctionsError).toEqual({ line: 2, message: "expected ';' before 'BROKEN'" });
    FUNCTIONS_ALL.forEach((fn) => expect(a.functions[fn]).toMatchObject({ compilesAlone: false, firstError: null, blockedByOutsideError: true }));
    expect(a.modeNeeded).toBe(false);
  });

  test('the stored code is never changed: the import keeps the student\'s file as it is', async () => {
    const docker = { ...fakeDocker() };
    const git = { listCommits: () => [{ hash: 'h', committedAt: 1, committedAtIso: '2026-01-01T00:00:00Z' }], showFile: (d, h, f) => (f === 'functions.h' ? OFFICIAL : WITH_BAD_GLOBAL), cloneBare: jest.fn() };
    const result = await importRepo({ repo: { name: 'r', gitDir: '/x' }, username: 'u', deadlineIso: '2026-03-01T23:59:00Z', assets: { officialHeader: OFFICIAL, driver: DRIVER, inputs: INPUTS }, dryRun: true }, { git, makeDocker: () => docker, store: null, newId: () => 'id-2' });
    expect(result.files.source).toBe(WITH_BAD_GLOBAL);
    expect(result.record.status).toBe('file_does_not_compile');
    expect(result.record.outsideFunctionsError).toEqual({ line: 6, message: "expected ';' before 'BROKEN'" });
  });
});

describe('importRepo with a file that does not compile as a whole', () => {
  test('the record gets the split status, the per-function errors, and the files are still stored', async () => {
    const code = FILE.replace('    return {str};', '    BROKEN return {str};');
    const docker = {
      compile: jest.fn(async (source) => (source.includes('BROKEN') ? { ok: false, errors: "functions.cpp:13:5: error: expected ';'\n" } : { ok: true, errors: '' })),
      runInputs: jest.fn(async ({ cmds }) => ({ sanCompile: { ok: true }, plainCompile: { ok: true }, runs: cmds.map(() => ({ san: { code: 0, stderr: '' }, plain: { code: 0, stdout: 'x\n' } })) })),
      cleanup: jest.fn(),
    };
    const git = { listCommits: () => [{ hash: 'h', committedAt: 1, committedAtIso: '2026-01-01T00:00:00Z' }], showFile: (d, h, f) => (f === 'functions.h' ? OFFICIAL : code), cloneBare: jest.fn() };
    const { record } = await importRepo({ repo: { name: 'r', gitDir: '/x' }, username: 'u', deadlineIso: '2026-03-01T23:59:00Z', assets: { officialHeader: OFFICIAL, driver: DRIVER, inputs: INPUTS }, dryRun: true }, { git, makeDocker: () => docker, store: null, newId: () => 'id-1' });
    expect(record.status).toBe('file_does_not_compile');
    expect(record.functions.splitString).toMatchObject({ compilesAlone: false, firstError: { line: 13, message: "expected ';'" } });
    expect(record.s3Keys).toEqual({ header: 'a2-pilot/id-1/functions.h', source: 'a2-pilot/id-1/functions.cpp' });
    expect(record.inputs.map((i) => i.function).sort()).toEqual(['mode', 'playCraps', 'reverseList']);
    expect(record.modeNeeded).toBe(false);
    expect(record.outsideFunctionsError).toBeNull();
  });
});
