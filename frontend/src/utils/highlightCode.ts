/**
 * A small C/C++ tokenizer for read-only code. It only colors; it never changes the text (joining the tokens of every line
 * gives back the original source). The editor's own highlighter (Monaco) is loaded from a CDN, so it is not used here.
 */
export type CodeTokenType = 'plain' | 'keyword' | 'type' | 'string' | 'number' | 'comment' | 'preproc';

export interface CodeToken {
  text: string;
  type: CodeTokenType;
}

const KEYWORDS = new Set(
  `alignas alignof and asm auto break case catch class const consteval constexpr constinit const_cast continue co_await co_return co_yield
decltype default delete do dynamic_cast else enum explicit export extern false for friend goto if inline mutable namespace new noexcept not nullptr
operator or private protected public register reinterpret_cast return sizeof static static_assert static_cast struct switch template this
thread_local throw true try typedef typeid typename union using virtual volatile while`.split(/\s+/),
);

const TYPES = new Set(
  `bool char char8_t char16_t char32_t double float int long short signed unsigned void wchar_t size_t ssize_t int8_t int16_t int32_t int64_t
uint8_t uint16_t uint32_t uint64_t string vector map set array pair unordered_map unordered_set queue stack deque list`.split(/\s+/),
);

const TOKEN = new RegExp(
  [
    String.raw`(?<comment>/\*[\s\S]*?(?:\*/|$)|//[^\n]*)`,
    String.raw`(?<preproc>^[ \t]*#[ \t]*[A-Za-z_]+)`,
    String.raw`(?<string>"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|(?<=#[ \t]*include[ \t]*)<[^>\n]*>)`,
    String.raw`(?<number>\b(?:0[xX][\da-fA-F']+|\d[\d']*\.?[\d']*(?:[eE][+-]?\d+)?)[uUlLfF]*)`,
    String.raw`(?<word>[A-Za-z_]\w*)`,
  ].join('|'),
  'gm',
);

function classify(match: RegExpExecArray): CodeTokenType {
  const groups = match.groups ?? {};
  if (groups.comment !== undefined) return 'comment';
  if (groups.preproc !== undefined) return 'preproc';
  if (groups.string !== undefined) return 'string';
  if (groups.number !== undefined) return 'number';
  if (KEYWORDS.has(match[0])) return 'keyword';
  if (TYPES.has(match[0])) return 'type';
  return 'plain';
}

/** The tokens of each line of the source. A comment that spans lines is split so every line holds its own part. */
export function highlightCode(source: string): CodeToken[][] {
  const text = source.replace(/\r\n/g, '\n').replace(/\n$/, '');
  const lines: CodeToken[][] = [[]];

  const push = (chunk: string, type: CodeTokenType) => {
    chunk.split('\n').forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part === '') return;
      const line = lines[lines.length - 1];
      const last = line[line.length - 1];
      if (last && last.type === type) last.text += part;
      else line.push({ text: part, type });
    });
  };

  TOKEN.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(text)) !== null) {
    if (match[0] === '') {
      TOKEN.lastIndex += 1;
      continue;
    }
    if (match.index > cursor) push(text.slice(cursor, match.index), 'plain');
    push(match[0], classify(match));
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) push(text.slice(cursor), 'plain');
  return lines;
}
