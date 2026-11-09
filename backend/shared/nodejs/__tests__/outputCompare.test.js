// Each case is derived from Judge0's rule:  strip(t) = t.split("\n").collect(&:rstrip).join("\n").rstrip
// and  expected.nil? || strip(expected) == strip(stdout)   (empty stdout counts as nil).
const { outputMatches, judge0Strip } = require('../utils/outputCompare');

const out = text => Buffer.from(text, 'utf-8');

describe('Judge0-matching output comparison', () => {
  it('trailing whitespace on every line is ignored', () => {
    expect(outputMatches('a\nb', out('a  \nb\t\n'))).toBe(true);
    expect(outputMatches('a  \nb', out('a\nb'))).toBe(true);
  });

  it('CRLF equals LF (the \\r is trailing whitespace)', () => {
    expect(outputMatches('1\n2\n', out('1\r\n2\r\n'))).toBe(true);
  });

  it('trailing blank lines and a missing final newline are ignored', () => {
    expect(outputMatches('x', out('x\n\n\n'))).toBe(true);
    expect(outputMatches('x\n\n', out('x'))).toBe(true);
    expect(outputMatches('x \n \n', out('x'))).toBe(true);
  });

  it('NUL, \\v and \\f count as trailing whitespace like Ruby rstrip', () => {
    expect(outputMatches('x', out('x\0\0'))).toBe(true);
    expect(outputMatches('x', out('x\v\f'))).toBe(true);
  });

  it('leading whitespace, inner blank lines, inner spaces and case are significant', () => {
    expect(outputMatches('x', out(' x'))).toBe(false);
    expect(outputMatches('a\nb', out('a\n\nb'))).toBe(false);
    expect(outputMatches('a b', out('a  b'))).toBe(false);
    expect(outputMatches('yes', out('Yes'))).toBe(false);
  });

  it('no expected output means accepted, whatever the program printed', () => {
    expect(outputMatches(undefined, out('anything'))).toBe(true);
    expect(outputMatches(null, out(''))).toBe(true);
    expect(outputMatches('', out('anything'))).toBe(true);
  });

  it('empty stdout is nil, so it only matches a nil expected output', () => {
    expect(outputMatches('x', out(''))).toBe(false);
    expect(outputMatches('\n', out(''))).toBe(false); // strip("\n") is "" but strip(nil) is nil
    expect(outputMatches('\n', out('\n'))).toBe(true); // "" == ""
  });

  it('invalid UTF-8 is compared byte for byte (Ruby raises ArgumentError and returns the text as is)', () => {
    const bad = Buffer.from([0xff, 0xfe, 0x0a]);
    expect(Buffer.isBuffer(judge0Strip(bad))).toBe(true);
    expect(outputMatches('x', bad)).toBe(false);
    expect(outputMatches('��', bad)).toBe(false);
  });
});
