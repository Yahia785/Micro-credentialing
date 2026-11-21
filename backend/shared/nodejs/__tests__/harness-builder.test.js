const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const hb = require('../services/harness-builder');

const HEADER = '#ifndef FUNCTIONS_H\n#define FUNCTIONS_H\n#include <vector>\n#include <string>\nusing namespace std;\nint f(int x);\n#endif\n';
const DRIVER = '#include "functions.h"\n#include <iostream>\nint main() { std::cout << f(3) << std::endl; }\n';

const STUDENT = [
  '#include "functions.h"', // 1
  '#include <algorithm>', // 2
  '', // 3
  'int f(int x) {', // 4
  '    int y = x;', // 5
  '    for (int i = 0; i < 2; i++)', // 6
  '        y += i;', // 7
  '    if (y > 100)', // 8
  '        y = 0;', // 9
  '    else', // 10
  '        y += 1;', // 11
  '    return y;', // 12
  '}', // 13
].join('\n');

const build = (over = {}) => hb.buildProgram({ header: HEADER, studentSource: STUDENT, driver: DRIVER, ...over });
const trace = (over = {}) => hb.buildTraceProgram({ header: HEADER, studentSource: STUDENT, driver: DRIVER, pauseLine: 5, variables: ['y'], ...over });
const whatIf = (over = {}) => hb.buildWhatIfProgram({ header: HEADER, studentSource: STUDENT, driver: DRIVER, line: 5, find: 'x', replace: '7', ...over });

/** The student's lines as they appear in the built source: everything between `#line 1 "functions.cpp"` and `#line 1 "driver.cpp"`. */
const studentPart = (source) => {
  const lines = source.split('\n');
  const from = lines.indexOf('#line 1 "functions.cpp"');
  const to = lines.indexOf('#line 1 "driver.cpp"');
  return lines.slice(from + 1, to);
};

describe('buildProgram', () => {
  test('puts the header first, then the student code, then the driver', () => {
    const r = build();
    expect(r.ok).toBe(true);
    const at = (text) => r.source.indexOf(text);
    expect(at('#ifndef FUNCTIONS_H')).toBeLessThan(at('int f(int x) {'));
    expect(at('int f(int x) {')).toBeLessThan(at('int main()'));
  });

  test('#line 1 comes right before the student code, so the student line numbers are kept', () => {
    const part = studentPart(build().source);
    expect(part.slice(0, STUDENT.split('\n').length)).toHaveLength(STUDENT.split('\n').length);
    expect(part[4]).toBe('    int y = x;'); // line 5 of the student's file is index 4
    expect(part[11]).toBe('    return y;');
    expect(build().source).toContain('#line 1 "driver.cpp"\n');
  });

  test('removes the include of functions.h in every spelling, keeping the line', () => {
    const spellings = ['#include "functions.h"', '#include <functions.h>', '#include"functions.h"', '#  include   "functions.h"  ', '# include < functions.h >', '#include "./functions.h"'];
    spellings.forEach((spelling) => {
      const code = `${spelling}\n#include <vector>\nint f(int x) { return x; }\n`;
      const part = studentPart(build({ studentSource: code }).source);
      expect(part.join('\n')).not.toMatch(/functions\.h/);
      expect(part[1]).toBe('#include <vector>'); // the line was blanked, not deleted
    });
  });

  test('keeps the student\'s other includes, and leaves a functions.h that is only inside a comment alone', () => {
    const code = '#include <algorithm>\n// #include "functions.h"\n/*\n#include "functions.h"\n*/\nint f(int x) { return x; }\n';
    const part = studentPart(build({ studentSource: code }).source).join('\n');
    expect(part).toContain('#include <algorithm>');
    expect(part).toContain('// #include "functions.h"');
    expect(part).toContain('/*\n#include "functions.h"\n*/');
  });

  test('removes the include from the driver too, and turns CRLF into LF', () => {
    const r = build({ studentSource: '#include "functions.h"\r\nint f(int x) { return x; }\r\n' });
    const driverPart = r.source.slice(r.source.indexOf('#line 1 "driver.cpp"'));
    expect(driverPart).not.toMatch(/functions\.h/);
    expect(r.source).not.toContain('\r');
  });

  test('never throws: missing pieces give a reason', () => {
    expect(build({ header: '' })).toEqual({ ok: false, reason: 'header is missing' });
    expect(build({ studentSource: '  ' })).toEqual({ ok: false, reason: 'the student code is empty' });
    expect(build({ driver: undefined })).toEqual({ ok: false, reason: 'driver is missing' });
    expect(hb.buildProgram()).toEqual({ ok: false, reason: 'header is missing' });
    expect(build({ studentSource: 42 }).ok).toBe(false);
  });
});

describe('buildTraceProgram', () => {
  test('puts the print on the same physical line, before the line, and adds the prelude', () => {
    const r = trace();
    expect(r.ok).toBe(true);
    const part = studentPart(r.source);
    expect(part).toHaveLength(STUDENT.split('\n').length);
    expect(part[4]).toBe('    harness_trace::emit("y", (y)); int y = x;');
    expect(part.filter((l) => l.includes('harness_trace')).length).toBe(1);
    expect(r.source).toContain('namespace harness_trace');
    expect(r.source.indexOf('namespace harness_trace')).toBeLessThan(r.source.indexOf('#line 1 "functions.cpp"'));
  });

  test('prints each variable as name=expression, and accepts { name, expr }', () => {
    const r = trace({ variables: ['y', { name: 'twice', expr: 'y * 2' }, { name: 'piece', expr: 'str.substr(a, b - a)' }] });
    expect(r.ok).toBe(true);
    expect(studentPart(r.source)[4]).toContain('harness_trace::emit("y", (y), "twice", (y * 2), "piece", (str.substr(a, b - a)));');
  });

  test('wraps an unbraced body of for, if, else in braces together with the print', () => {
    const forBody = studentPart(trace({ pauseLine: 7 }).source)[6];
    expect(forBody).toBe('        { harness_trace::emit("y", (y)); y += i; }');
    expect(studentPart(trace({ pauseLine: 9 }).source)[8]).toBe('        { harness_trace::emit("y", (y)); y = 0; }');
    expect(studentPart(trace({ pauseLine: 11 }).source)[10]).toBe('        { harness_trace::emit("y", (y)); y += 1; }');
  });

  test('wraps a while and a do body, and keeps a trailing comment outside the braces', () => {
    const code = ['int f(int x) {', '    while (x > 0)', '        x--; // count down', '    do', '        x++;', '    while (x < 3);', '    return x;', '}'].join('\n');
    const r1 = hb.buildTraceProgram({ header: HEADER, studentSource: code, driver: DRIVER, pauseLine: 3, variables: ['x'] });
    expect(studentPart(r1.source)[2]).toBe('        { harness_trace::emit("x", (x)); x--; } // count down');
    const r2 = hb.buildTraceProgram({ header: HEADER, studentSource: code, driver: DRIVER, pauseLine: 5, variables: ['x'] });
    expect(studentPart(r2.source)[4]).toBe('        { harness_trace::emit("x", (x)); x++; }');
  });

  test('does not wrap a line that is inside braces', () => {
    const code = 'int f(int x) {\n    if (x > 0) {\n        x--;\n    }\n    return x;\n}\n';
    const r = hb.buildTraceProgram({ header: HEADER, studentSource: code, driver: DRIVER, pauseLine: 3, variables: ['x'] });
    expect(studentPart(r.source)[2]).toBe('        harness_trace::emit("x", (x)); x--;');
  });

  test.each([
    ['a blank line', 3, 'is blank'],
    ['a comment', 2, 'is a comment'],
    ['a preprocessor line', 1, 'is a preprocessor line'],
    ['a line with only braces', 7, 'has only braces'],
    ['a closing brace followed by else', 4, 'starts with a closing brace'],
    ['an else line', 6, 'starts with "else"'],
    ['a for loop header', 9, 'for loop header'],
    ['a while loop header', 10, 'while loop header'],
    ['a line past the end of the file', 99, 'does not exist'],
    ['line 0', 0, 'does not exist'],
  ])('refuses %s', (_name, pauseLine, reason) => {
    const code = [
      '#include <vector>', // 1
      '// a comment', // 2
      '', // 3
      '} else {', // 4 (never reached as code, only analyzed)
      'int f(int x) {', // 5
      '    else x = 1;', // 6
      '}', // 7
      'int g(int x) {', // 8
      '    for (int i = 0; i < 3; i++) {', // 9
      '    while (x > 0) {', // 10
      '    }', // 11
      '    }', // 12
      '}', // 13
    ].join('\n');
    const r = hb.buildTraceProgram({ header: HEADER, studentSource: code, driver: DRIVER, pauseLine, variables: ['x'] });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(reason);
  });

  test('refuses a line outside any function', () => {
    const code = ['int a;', 'int b = 1;', 'int f(int x) {', '  return x;', '}'].join('\n');
    const r = hb.buildTraceProgram({ header: HEADER, studentSource: code, driver: DRIVER, pauseLine: 2, variables: ['x'] });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('not inside a function body');
  });

  test('refuses a line inside a statement that spans several lines', () => {
    const code = ['int f(int x) {', '    int y = x +', '        2;', '    int z = g(x,', '        y);', '    return y + z;', '}'].join('\n');
    const at = (pauseLine) => hb.buildTraceProgram({ header: HEADER, studentSource: code, driver: DRIVER, pauseLine, variables: ['x'] });
    expect(at(3).ok).toBe(false); // continues after "+"
    expect(at(3).reason).toContain('spans several lines');
    expect(at(5).ok).toBe(false); // inside the parentheses
    expect(at(5).reason).toContain('spans several lines');
    expect(at(2).ok).toBe(true); // the FIRST line of the statement is fine
    expect(at(6).ok).toBe(true);
  });

  test('refuses an unbraced body that does not end on its own line', () => {
    const code = ['int f(int x) {', '    if (x > 0)', '        x = x +', '            1;', '    return x;', '}'].join('\n');
    const r = hb.buildTraceProgram({ header: HEADER, studentSource: code, driver: DRIVER, pauseLine: 3, variables: ['x'] });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('does not end on that line');
  });

  test('a comment-only line and a line inside a block comment are comments', () => {
    const code = 'int f(int x) {\n    /* start\n       middle */\n    return x;\n}\n';
    const at = (pauseLine) => hb.buildTraceProgram({ header: HEADER, studentSource: code, driver: DRIVER, pauseLine, variables: ['x'] });
    expect(at(2).reason).toContain('is a comment');
    expect(at(3).reason).toContain('is a comment');
    expect(at(4).ok).toBe(true);
  });

  test('braces and keywords inside strings and comments do not confuse the analysis', () => {
    const code = ['int f(int x) {', '    string s = "{ if ( for";', '    // {{{', '    x++;', '    return x;', '}'].join('\n');
    const r = hb.buildTraceProgram({ header: HEADER, studentSource: code, driver: DRIVER, pauseLine: 4, variables: ['x'] });
    expect(r.ok).toBe(true);
    expect(r.wrapped).toBe(false);
  });

  test('refuses variables that are not plain read-only expressions', () => {
    ['y = 5', 'y++', '--y', 'f(y); g()', 'y; return', '"s"', '', '(y'].forEach((expr) => {
      expect(trace({ variables: [expr] }).ok).toBe(false);
    });
    expect(trace({ variables: [] }).reason).toBe('no variables to print');
    expect(trace({ variables: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }).reason).toContain('at most');
    expect(trace({ variables: [{ name: '', expr: 'y' }] }).ok).toBe(false);
  });

  test('never throws on bad input', () => {
    expect(hb.buildTraceProgram()).toEqual({ ok: false, reason: 'header is missing' });
    expect(trace({ pauseLine: 'five' }).ok).toBe(false);
    expect(trace({ variables: 'y' }).ok).toBe(false);
  });
});

describe('buildWhatIfProgram', () => {
  test('replaces the text on that line only, and keeps every line number', () => {
    const r = whatIf({ line: 5, find: 'x', replace: '7' });
    expect(r.ok).toBe(true);
    const part = studentPart(r.source);
    expect(part[4]).toBe('    int y = 7;');
    expect(part).toHaveLength(STUDENT.split('\n').length);
    expect(part[11]).toBe('    return y;');
  });

  test('fails with a reason when the text is not on that line', () => {
    expect(whatIf({ line: 5, find: 'nothing' })).toEqual({ ok: false, reason: 'the text to change is not on line 5' });
    expect(whatIf({ line: 12, find: 'x' }).ok).toBe(false); // x is on line 5, not 12
  });

  test('fails with a reason when the text is on the line more than once', () => {
    const r = whatIf({ line: 6, find: 'i' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('the text to change is on line 6 4 times');
    expect(whatIf({ studentSource: 'int f(int x) { return aaa; }', line: 1, find: 'aa' }).ok).toBe(false); // overlapping matches count
  });

  test('refuses an empty find, a change that changes nothing, multi-line text and a line that does not exist', () => {
    expect(whatIf({ find: '' }).reason).toBe('the text to find is empty');
    expect(whatIf({ find: 'x', replace: 'x' }).reason).toBe('the change would not change anything');
    expect(whatIf({ replace: 'a\nb' }).reason).toContain('one line');
    expect(whatIf({ line: 99 }).reason).toContain('does not exist');
    expect(whatIf({ replace: undefined }).reason).toBe('the replacement text is missing');
  });

  test('treats the replacement as plain text ($ patterns are not special)', () => {
    expect(studentPart(whatIf({ find: 'x', replace: "$& $1 $'" }).source)[4]).toBe("    int y = $& $1 $';");
  });
});

describe('parseTrace', () => {
  const stderr = [
    `${hb.MARKER}\t1\tleft=10\tright=50`,
    'some student output',
    `${hb.MARKER}\t2\tleft=20\tright=40`,
    `text without newline${hb.MARKER}\t3\tleft=30\tright=30`,
  ].join('\n');

  test('returns the variables at the k-th stop', () => {
    const second = hb.parseTrace(stderr, 2);
    expect(second.values).toEqual({ left: '20', right: '40' });
    expect(second.text).toBe('left=20, right=40');
    expect(second.stop).toBe(2);
  });

  test('finds a stop that follows other output on the same line', () => {
    expect(hb.parseTrace(stderr, 3).values).toEqual({ left: '30', right: '30' });
  });

  test('a stop that never happens is { noStop: true } with the number of stops there were', () => {
    expect(hb.parseTrace(stderr, 4)).toEqual({ noStop: true, stops: 3 });
    expect(hb.parseTrace('', 1)).toEqual({ noStop: true, stops: 0 });
    expect(hb.parseTrace(undefined, 1)).toEqual({ noStop: true, stops: 0 });
    expect(hb.parseTrace(stderr, 0)).toEqual({ noStop: true, stops: 3 });
    expect(hb.parseTrace(stderr, 'two')).toEqual({ noStop: true, stops: 3 });
  });

  test('keeps values with spaces, equals signs, quotes and empty values as written', () => {
    const line = `${hb.MARKER}\t1\tpiece=""\tlist=[]\tword="a b=c"\tneg=-5`;
    expect(hb.parseTrace(line, 1).values).toEqual({ piece: '""', list: '[]', word: '"a b=c"', neg: '-5' });
    expect(hb.parseTrace(line, 1).text).toBe('piece="", list=[], word="a b=c", neg=-5');
  });

  test('ignores a marker line that is damaged', () => {
    expect(hb.parseTrace(`${hb.MARKER}\tx\ta=1`, 1)).toEqual({ noStop: true, stops: 0 });
  });
});

describe('value formatting in the prelude', () => {
  test('quotes strings and chars, prints bool as true/false, and has no generic overload', () => {
    expect(hb.TRACE_PRELUDE).toContain('quote(o, v)');
    expect(hb.TRACE_PRELUDE).toContain('"true" : "false"');
    expect(hb.TRACE_PRELUDE).toContain('std::vector<int>');
    expect(hb.TRACE_PRELUDE).toContain('std::vector<std::string>');
    expect(hb.TRACE_PRELUDE).toContain('std::vector<char>');
    expect(hb.TRACE_PRELUDE).toContain('std::vector<double>');
    expect(hb.TRACE_PRELUDE).not.toMatch(/template <class T> void put\(/); // an unsupported type must not compile
  });

  // Needs a C++ compiler: run with GXX=/path/to/g++ (the test is skipped when there is none).
  const gxx = process.env.GXX || 'g++';
  const env = { ...process.env, PATH: gxx.includes('/') || gxx.includes('\\') ? `${path.dirname(gxx)}${path.delimiter}${process.env.PATH}` : process.env.PATH };
  const hasCompiler = !spawnSync(gxx, ['--version'], { env }).error;
  (hasCompiler ? test : test.skip)('compiled, an empty string and an empty vector are visible, and an unsupported type is a compile error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-test-'));
    const run = (decls, exprs) => {
      const student = `#include "functions.h"\nint f(int x) {\n${decls}\n    int end = x;\n    return end;\n}\n`;
      const pauseLine = student.split('\n').findIndex((l) => l.includes('int end')) + 1;
      const built = hb.buildTraceProgram({ header: HEADER, studentSource: student, driver: DRIVER, pauseLine, variables: exprs });
      const src = path.join(dir, 'a.cpp');
      fs.writeFileSync(src, built.source);
      const exe = path.join(dir, process.platform === 'win32' ? 'a.exe' : 'a');
      const c = spawnSync(gxx, ['-std=c++17', '-o', exe, src], { encoding: 'utf8', env });
      if (c.status !== 0) return { compileError: c.stderr };
      return { stderr: spawnSync(exe, [], { encoding: 'utf8', env }).stderr };
    };
    const ok = run('    string e = ""; vector<int> v; vector<string> w = {"a", ""}; char c = \'x\'; bool b = true;', [{ name: 'e', expr: 'e' }, { name: 'v', expr: 'v' }, { name: 'w', expr: 'w' }, { name: 'c', expr: 'c' }, { name: 'b', expr: 'b' }]);
    expect(hb.parseTrace(ok.stderr, 1).values).toEqual({ e: '""', v: '[]', w: '["a", ""]', c: '"x"', b: 'true' });
    const bad = run('    int a = 1; int* p = &a;', ['p']);
    expect(bad.compileError).toContain('harness_trace');
    const nested = run('    vector<vector<int>> m = {{1}};', ['m']);
    expect(nested.compileError).toContain('harness_trace');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
