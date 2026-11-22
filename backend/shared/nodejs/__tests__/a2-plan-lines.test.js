const fs = require('fs');
const path = require('path');
const { suggestLine, splitArgs, callArgs } = require('../../../scripts/a2-import/lib/lines');

const A2 = path.join(__dirname, '../../../scripts/eval/a2');
const FNS = ['reverseList', 'splitString', 'playCraps', 'mode'];

describe('suggestLine agrees with the hand-set lines of the fake submissions', () => {
  const dirs = [['reference', path.join(A2, 'reference')], ...fs.readdirSync(path.join(A2, 'variants')).filter((d) => /^v\d\d-/.test(d)).sort().map((d) => [d, path.join(A2, 'variants', d)])];
  test.each(dirs)('%s', (_name, dir) => {
    const code = fs.readFileSync(path.join(dir, 'functions.cpp'), 'utf8');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    for (const fn of FNS) {
      const hand = meta.interview[fn].tracing;
      const s = suggestLine(code, fn);
      if (hand.unavailable) { expect(s.status).toBe('manual'); continue; }
      expect([fn, s.status, s.line]).toEqual([fn, 'confident', hand.pauseLine]);
      expect(s.variables.map((v) => v.expr)).toEqual(hand.variables.map((v) => v.expr));
    }
  });
});

const wrap = (body, header = 'void reverseList(vector<int>& vec) {') => `#include "functions.h"\n${header}\n${body}\n}\n`;

describe('reverseList: the swap line', () => {
  test('a swap( call, with its two arguments as the traced numbers', () => {
    const s = suggestLine(wrap('    for (int i = 0; i < 2; i++) {\n        std::swap(vec[i], vec[vec.size() - 1 - i]);\n    }'), 'reverseList');
    expect(s).toMatchObject({ status: 'confident', line: 4 });
    expect(s.variables).toEqual([{ name: 'left number', expr: 'vec[i]' }, { name: 'right number', expr: 'vec[vec.size() - 1 - i]' }]);
  });

  test('the first line of a temp-variable swap', () => {
    const s = suggestLine(wrap('    int a = 0, b = 1;\n    int t = vec[a];\n    vec[a] = vec[b];\n    vec[b] = t;'), 'reverseList');
    expect(s).toMatchObject({ status: 'confident', line: 4 });
    expect(s.variables.map((v) => v.expr)).toEqual(['vec[a]', 'vec[b]']);
  });

  test('the unbraced body of a for loop is accepted (the trace builder wraps it in braces)', () => {
    const s = suggestLine(wrap('    for (int i = 0; i < 2; i++)\n        swap(vec[i], vec[3 - i]);'), 'reverseList');
    expect(s).toMatchObject({ status: 'confident', line: 4 });
  });

  test('two swaps in the function: needs manual', () => {
    const s = suggestLine(wrap('    swap(vec[0], vec[1]);\n    swap(vec[1], vec[2]);'), 'reverseList');
    expect(s.status).toBe('manual');
    expect(s.reason).toContain('2 lines could be the one');
  });

  test('no swap at all (a library call): needs manual', () => {
    const s = suggestLine(wrap('    reverse(vec.begin(), vec.end());'), 'reverseList');
    expect(s).toMatchObject({ status: 'manual', reason: 'no line matches the pattern' });
  });

  test('a temp pattern whose lines do not swap is not a swap', () => {
    expect(suggestLine(wrap('    int t = vec[0];\n    vec[0] = vec[1];\n    vec[2] = t;'), 'reverseList').status).toBe('manual');
  });

  test('a swap( in a comment or a string does not count', () => {
    expect(suggestLine(wrap('    // swap(vec[0], vec[1]);\n    string s = "swap(a, b)";'), 'reverseList').status).toBe('manual');
  });
});

describe('splitString: the line that adds a piece', () => {
  const head = 'vector<string> splitString(string str, char delim) {';
  test('prefers the one inside the loop over the one after it', () => {
    const body = '    vector<string> parts;\n    string cur;\n    for (char c : str) {\n        if (c == delim) {\n            parts.push_back(cur);\n            cur = "";\n        } else cur += c;\n    }\n    parts.push_back(cur);\n    return parts;';
    const s = suggestLine(wrap(body, head), 'splitString');
    expect(s).toMatchObject({ status: 'confident', line: 7 });
    expect(s.variables).toEqual([{ name: 'piece', expr: 'cur' }]);
  });

  test('emplace_back and a while loop', () => {
    const body = '    vector<string> out;\n    size_t at = 0;\n    while (at < str.size()) {\n        out.emplace_back(str.substr(at, 1));\n        at++;\n    }\n    return out;';
    const s = suggestLine(wrap(body, head), 'splitString');
    expect(s).toMatchObject({ status: 'confident', line: 6 });
    expect(s.variables[0].expr).toBe('str.substr(at, 1)');
  });

  test('a single push_back outside any loop is the one', () => {
    const s = suggestLine(wrap('    vector<string> r;\n    r.push_back(str);\n    return r;', head), 'splitString');
    expect(s).toMatchObject({ status: 'confident', line: 4 });
  });

  test('two push_backs inside loops: needs manual', () => {
    const body = '    vector<string> r;\n    for (int i = 0; i < 2; i++) {\n        r.push_back(str);\n        r.push_back(str.substr(1));\n    }\n    return r;';
    const s = suggestLine(wrap(body, head), 'splitString');
    expect(s.status).toBe('manual');
  });

  test('a stub has no line: needs manual', () => {
    expect(suggestLine(wrap('    return {};', head), 'splitString')).toMatchObject({ status: 'manual', reason: 'no line matches the pattern' });
  });

  test('a piece that is a string literal cannot be traced: needs manual with the reason', () => {
    const s = suggestLine(wrap('    vector<string> r;\n    for (int i = 0; i < 2; i++) {\n        r.push_back("x");\n    }\n    return r;', head), 'splitString');
    expect(s.status).toBe('manual');
    expect(s.candidates[0].rejected).toContain('not a plain read-only expression');
  });
});

describe('playCraps: the first line after a roll\'s sum', () => {
  const head = 'int playCraps(const vector<int>& rolls) {';
  test('the sum of two rolls[...] in the loop, not the first roll outside it', () => {
    const body = '    int first = rolls[0] + rolls[1];\n    if (first == 7) return 0;\n    for (size_t i = 2; i + 1 < rolls.size(); i += 2) {\n        int sum = rolls[i] + rolls[i + 1];\n        if (sum == first) return 0;\n    }\n    return 2;';
    const s = suggestLine(wrap(body, head), 'playCraps');
    expect(s).toMatchObject({ status: 'confident', line: 7 });
    expect(s.variables).toEqual([{ name: 'sum', expr: 'sum' }]);
  });

  test('a sum of two dice variables', () => {
    const body = '    for (int i = 0; i + 1 < rolls.size(); i += 2) {\n        int d1 = rolls[i];\n        int d2 = rolls[i + 1];\n        int total = d1 + d2;\n        if (total == 7) return 1;\n    }\n    return 2;';
    const s = suggestLine(wrap(body, head), 'playCraps');
    expect(s).toMatchObject({ status: 'confident', line: 7 });
    expect(s.variables[0].expr).toBe('total');
  });

  test('two sums in the loop: needs manual', () => {
    const body = '    for (int i = 0; i + 1 < rolls.size(); i += 2) {\n        int a = rolls[i] + rolls[i + 1];\n        if (a == 7) return 1;\n        int b = rolls[i] + rolls[i + 1];\n        if (b == 2) return 0;\n    }\n    return 2;';
    expect(suggestLine(wrap(body, head), 'playCraps').status).toBe('manual');
  });

  test('a sum that is the last statement has no line after it', () => {
    const s = suggestLine(wrap('    int s = rolls[0] + rolls[1];', head), 'playCraps');
    expect(s.status).toBe('manual');
    expect(s.candidates[0].rejected).toBeDefined();
  });

  test('no two-dice sum: needs manual', () => {
    expect(suggestLine(wrap('    return rolls.size();', head), 'playCraps')).toMatchObject({ status: 'manual', reason: 'no line matches the pattern' });
  });
});

describe('mode: the line that compares a count with the best count', () => {
  const head = 'int mode(const vector<int>& vec) {';
  test('count > best count, with the value taken from the assignment that follows', () => {
    const body = '    int best = vec[0];\n    int bestCount = 0;\n    for (int i = 0; i < 3; i++) {\n        int c = 1;\n        if (c > bestCount) {\n            best = vec[i];\n            bestCount = c;\n        }\n    }\n    return best;';
    const s = suggestLine(wrap(body, head), 'mode');
    expect(s).toMatchObject({ status: 'confident', line: 7 });
    expect(s.variables).toEqual([{ name: 'value', expr: 'vec[i]' }, { name: 'count', expr: 'c' }]);
  });

  test('the reversed comparison: best count < count', () => {
    const body = '    int best = 0, maxCount = 0;\n    for (int i = 0; i < 3; i++) {\n        int n = 2;\n        if (maxCount < n) {\n            best = vec[i];\n        }\n    }\n    return best;';
    expect(suggestLine(wrap(body, head), 'mode')).toMatchObject({ status: 'confident', line: 6 });
  });

  test('no best-so-far comparison: needs manual', () => {
    expect(suggestLine(wrap('    for (int i = 0; i < 3; i++) {\n        if (vec[i] > 3) return 1;\n    }\n    return 0;', head), 'mode').status).toBe('manual');
  });

  test('a comparison with no assignment after it cannot name the value: needs manual', () => {
    const s = suggestLine(wrap('    int bestCount = 0;\n    for (int c = 0; c < 3; c++) {\n        if (c > bestCount) {\n            return c;\n        }\n    }\n    return 0;', head), 'mode');
    expect(s.status).toBe('manual');
    expect(s.candidates[0].rejected).toBe('cannot tell which value is being counted');
  });
});

describe('suggestLine edge cases', () => {
  test('a function that is not in the file, or a file that cannot be split', () => {
    expect(suggestLine('int other() { return 1; }\n', 'mode')).toMatchObject({ status: 'manual', reason: 'no definition of mode found' });
    expect(suggestLine('int mode(const vector<int>& v) {\n  return 1;\n', 'mode').reason).toContain('could not be split');
  });

  test('helpers: splitArgs and callArgs', () => {
    expect(splitArgs('a, f(b, c), vec[i, j]')).toEqual(['a', 'f(b, c)', 'vec[i, j]']);
    expect(callArgs('x = f(1, g(2));', 'x = f(1, g(2));', 'f')).toBe('1, g(2)');
  });
});
