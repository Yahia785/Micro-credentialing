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
const WRITER_START = 'You write ONE question';
const answerOf = (message) => (/<student_answer>\n([\s\S]*?)\n<\/student_answer>/.exec(message) || [])[1] || '';

const HEDGE = /not sure|depends|maybe|\bor\b|somebody|at some point|splits it at|a few/i;

/**
 * The stand-in checker (it is not a language model). unclear for a hedge; for a compile error yes when the compiler's message is in the answer;
 * for a number yes when the FIRST number of the answer is the value; for a list of pieces yes when the pieces the answer names (quoted, or the
 * words "empty", "a", "b" ...) are exactly the expected ones; otherwise yes when the text is in the answer.
 */
function defaultDecide(message, answer) {
  if (HEDGE.test(answer)) return 'unclear';
  const compile = /The compiler reports this on line \d+: (.*)/.exec(message);
  if (compile) return squash(answer).includes(squash(compile[1])) ? 'yes' : 'no';
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

/** The judge of case 2: wrong for the kinds of answer the scripted wrong answers use, right for any other explanation. */
const defaultJudge = (answer) => (/my code looks fine|first line of the function|compiler or the test/i.test(answer) ? 'wrong' : 'right');

/** The writer of the smaller code step: the first listed variable at stop 1. */
function defaultWrite(message) {
  const line = (/Line to ask about: (\d+)/.exec(message) || [])[1];
  const input = (/Input: (.*)/.exec(message) || [])[1];
  const first = /^- (.*?): (.*)$/m.exec(message);
  return { variable: first[1], stop: 1, question: `At line ${line}, the 1st time it runs on ${input}, what is the value of \`${first[2]}\`?` };
}

/**
 * A converse function. \`decide({ ask, answer, message })\` plays the checker ('yes' | 'no' | 'unclear'); \`judge({ answer })\` the judge
 * ('right' | 'partly' | 'wrong' | 'unclear'); \`write({ message })\` the writer (an object { variable, stop, question }, or a string that is
 * sent as it is). \`requests\` records every request, so a test can look at what a model was sent; \`kinds\` counts the calls by kind.
 */
function fakeModel({ decide, judge, write } = {}) {
  const requests = [];
  const kinds = { check: 0, judge: 0, write: 0 };
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

module.exports = { fakeRunBatch, fakeModel, answerOf, defaultJudge, defaultWrite };
