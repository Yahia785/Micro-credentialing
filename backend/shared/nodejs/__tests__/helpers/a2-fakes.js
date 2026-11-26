// Fakes for the A2 interview tests and the scripted local run: a code runner that answers from a table, and a deterministic model that plays
// the checker, the judge of case 2 and the writer of the smaller code step. Neither runs anything real.
const { squash } = require('../../agent/rubric-check');

/**
 * A runBatch (the shape of codeRunner.runCppBatch). `plain[cmd]` is what a plain run of that command prints; `stops[cmd]` the trace stops
 * ("name=value, ..." texts) a trace run of it reports on stderr; `changed[cmd]` what a changed copy (what-if, recognised by `changedWhen(source)`) prints.
 * A program that holds a trace marker is a trace copy. `calls` records every run.
 */
function fakeRunBatch({ plain = {}, stops = {}, status = {}, changed = {}, changedWhen = () => false } = {}) {
  const calls = [];
  const fn = async (runs) => runs.map((run) => {
    const cmd = String(run.stdin).trim();
    const marker = (/@@TRACE-[0-9a-f]+@@/.exec(run.source) || [])[0];
    calls.push({ cmd, trace: Boolean(marker) });
    if (changedWhen(run.source) && changed[cmd] !== undefined) return { status: 'accepted', stdout: `${changed[cmd]}\n`, stderr: '', compileOutput: '', timeMs: 3, memoryKb: 1 };
    if (status[cmd]) return { status: status[cmd], stdout: '', stderr: '', compileOutput: '', timeMs: 3, memoryKb: 1 };
    const lines = marker ? (stops[cmd] || []).map((text, i) => `${marker}\t${i + 1}\t${text.split(', ').join('\t')}`) : [];
    return { status: 'accepted', stdout: `${plain[cmd] === undefined ? '' : plain[cmd]}\n`, stderr: lines.join('\n'), compileOutput: '', timeMs: 3, memoryKb: 1 };
  });
  fn.calls = calls;
  return fn;
}

const CHECKER_START = 'You check one short answer';
const JUDGE_START = "You judge a student's short answer";
const WRITER_START = 'You choose what ONE short';
const EXTRACT_START = 'You read one short answer';
const answerOf = (message) => (/<student_answer>\n([\s\S]*?)\n<\/student_answer>/.exec(message) || [])[1] || '';

const HEDGE = /not sure|depends|maybe|\bor\b|somebody|at some point|splits it at|a few/i;

/**
 * The stand-in checker (it is not a language model). unclear for a hedge; for a compile error yes when the compiler's message is in the answer;
 * for a number yes when the FIRST number of the answer is the value; for a list of pieces yes when the pieces the answer names (quoted, or the
 * words "empty", "a", "b" ...) are exactly the expected ones; otherwise yes when the text is in the answer.
 */
function defaultDecide(message, answer) {
  const compile = /The compiler reports this on line \d+: (.*)/.exec(message);
  // a compile answer names the mistake: the compiler's message, or what is missing
  if (compile) return squash(answer).includes(squash(compile[1])) || /\bmissing\b/i.test(answer) ? 'yes' : 'no';
  if (HEDGE.test(answer)) return 'unclear';
  const value = /does this answer give the value (.*?)\? \(/.exec(message);
  const target = value ? value[1] : null;
  if (target === null) return squash(answer).includes('correct') ? 'yes' : 'no';
  if (/^-?\d+$/.test(target.trim())) return (answer.match(/-?\d+/) || [])[0] === target.trim() ? 'yes' : 'no';
  const expectedPieces = [...target.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (expectedPieces.length > 0) {
    const quoted = [...answer.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (quoted.length > 0) return JSON.stringify(quoted) === JSON.stringify(expectedPieces) ? 'yes' : 'no';
    const names = new Set(expectedPieces.map((x) => x || 'empty'));
    const said = (answer.toLowerCase().match(/[a-z]+/g) || []).filter((w) => names.has(w));
    return JSON.stringify(said) === JSON.stringify(expectedPieces.map((x) => x || 'empty')) ? 'yes' : 'no';
  }
  return squash(answer).includes(squash(target)) ? 'yes' : 'no';
}

const NUMBER_WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const CORRECTION = /\b(no wait|actually|sorry|i mean|scratch that)\b[\s,:-]*/gi;

/**
 * The stand-in reader (it is not a language model; it only reads, it never sees a key). It reports the final value the answer states, the way
 * the real reader is told to: the part after a self-correction, a value after "returns" / "so" / "is" / "=", a list of quoted pieces, or the words
 * empty / nothing / blank and single letters in order. It reports null for two different answers with no choice, a hedge, or no value.
 * Returns { value, quote }.
 */
function defaultExtract(message) {
  const answer = answerOf(message);
  const type = (/^Expected type of the final value: (.*)$/m.exec(message) || [])[1] || '';
  let text = answer;
  const cuts = [...answer.matchAll(CORRECTION)];
  if (cuts.length) { const last = cuts[cuts.length - 1]; text = answer.slice(last.index + last[0].length); }
  const nothing = { value: null, quote: '' };
  const quotedPieces = [...text.matchAll(/"([^"]*)"/g)];
  if (/list/.test(type) || /one value per variable/.test(type)) {
    if (quotedPieces.length) {
      const first = quotedPieces[0].index;
      const last = quotedPieces[quotedPieces.length - 1];
      return { value: quotedPieces.map((m) => m[1]), quote: text.slice(first, last.index + last[0].length) };
    }
    if (/integers|one value per variable/.test(type)) {
      const numbers = text.match(/-?\d+/g) || [];
      return numbers.length ? { value: numbers.map(Number), quote: text.slice(text.indexOf(numbers[0]), text.lastIndexOf(numbers[numbers.length - 1]) + numbers[numbers.length - 1].length) } : nothing;
    }
    if (HEDGE.test(text) && !/\bempty\b/i.test(text)) return nothing;
    // the words "empty", "nothing", "blank" and single letters, in the order they are said (after the last colon, when there is one)
    const after = text.lastIndexOf(':') >= 0 ? text.slice(text.lastIndexOf(':') + 1) : text;
    const from = after.split(/\b(?:because|since)\b/i)[0]; // what comes after "because" explains, it is not the answer
    const found = [...from.matchAll(/\b(empty|nothing|blank|[a-hj-z])\b/gi)];
    if (found.length === 0) return nothing;
    const first = found[0].index;
    const last = found[found.length - 1];
    return { value: found.map((m) => (/^(empty|nothing|blank)$/i.test(m[1]) ? '' : m[1])), quote: from.slice(first, last.index + last[0].length) };
  }
  if (HEDGE.test(text) && !/\d/.test(text)) return nothing;
  // a single value: a number (digits or a word) or a string
  if (/integer|number/.test(type) || /\d/.test(text)) {
    const cue = [...text.matchAll(/\b(?:returns?|so|is|=|answer is|gives?)\s*(-?\d+)/gi)];
    const all = [...text.matchAll(/-?\d+/g)].map((m) => m[0]);
    const words = [...text.toLowerCase().matchAll(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/g)];
    if (cue.length) { const m = cue[cue.length - 1]; return { value: Number(m[1]), quote: m[0] }; }
    if (new Set(all).size === 1) return { value: Number(all[0]), quote: all[0] };
    if (all.length === 0 && words.length === 1) return { value: NUMBER_WORDS[words[0][1]], quote: words[0][1] };
    return nothing;
  }
  if (quotedPieces.length === 1) return { value: quotedPieces[0][1], quote: quotedPieces[0][0] };
  const bare = text.trim().replace(/[.?!]+$/, '');
  return /^\S+$/.test(bare) ? { value: bare, quote: bare } : nothing;
}

/** The judge of case 2: wrong for the kinds of answer the scripted wrong answers use, right for any other explanation. */
const defaultJudge = (answer) => (/my code looks fine|function header|compiler or the test/i.test(answer) ? 'wrong' : 'right');

/** The writer of the smaller code step: the first listed variable at stop 1. */
function defaultWrite(message) {
  const first = /^- (.*?): (.*)$/m.exec(message);
  return { variable: first[1], stop: 1 };
}

/**
 * A converse function. \`decide({ ask, answer, message })\` plays the checker ('yes' | 'no' | 'unclear'); \`judge({ answer })\` the judge
 * ('right' | 'partly' | 'wrong' | 'unclear'); \`extract({ message, answer, attempt })\` the reader of a value answer (an object { value, quote }, or a string sent as it is); \`write({ message })\` the writer (an object { variable, stop }, or a string that is
 * sent as it is). \`requests\` records every request, so a test can look at what a model was sent; \`kinds\` counts the calls by kind.
 */
function fakeModel({ decide, judge, write, extract } = {}) {
  const requests = [];
  const kinds = { check: 0, judge: 0, write: 0, extract: 0 };
  const quoteOf = (answer) => answer.replace(/\s+/g, ' ').slice(0, 60);
  const converseFn = async (request) => {
    requests.push(request);
    const system = String(request.system);
    const first = request.messages[0].content[0].text;
    if (system.startsWith(CHECKER_START)) {
      kinds.check += 1;
      const answer = answerOf(first);
      const verdict = decide ? decide({ ask: first, answer, message: first }) : defaultDecide(first, answer);
      return { text: JSON.stringify({ verdict, quote: verdict === 'unclear' ? '' : quoteOf(answer) }), inputTokens: 10, outputTokens: 5, latencyMs: 1 };
    }
    if (system.startsWith(EXTRACT_START)) {
      kinds.extract += 1;
      const attempt = Math.ceil(request.messages.length / 2);
      const made = extract ? extract({ message: first, answer: answerOf(first), attempt }) : defaultExtract(first);
      return { text: typeof made === 'string' ? made : JSON.stringify(made), inputTokens: 12, outputTokens: 9, latencyMs: 1 };
    }
    if (system.startsWith(JUDGE_START)) {
      kinds.judge += 1;
      const answer = answerOf(first);
      const verdict = judge ? judge({ answer, message: first }) : defaultJudge(answer);
      return { text: JSON.stringify({ verdict, quote: verdict === 'unclear' ? '' : quoteOf(answer) }), inputTokens: 10, outputTokens: 5, latencyMs: 1 };
    }
    if (system.startsWith(WRITER_START)) {
      kinds.write += 1;
      // a retry carries the reply that failed as a second message: the writer function gets the number of the attempt
      const attempt = Math.ceil(request.messages.length / 2);
      const made = write ? write({ message: first, attempt }) : defaultWrite(first);
      return { text: typeof made === 'string' ? made : JSON.stringify(made), inputTokens: 20, outputTokens: 8, latencyMs: 1 };
    }
    throw new Error('the fake model does not know this prompt');
  };
  converseFn.requests = requests;
  converseFn.kinds = kinds;
  return converseFn;
}

module.exports = { fakeRunBatch, fakeModel, answerOf, defaultJudge, defaultWrite, defaultExtract };
