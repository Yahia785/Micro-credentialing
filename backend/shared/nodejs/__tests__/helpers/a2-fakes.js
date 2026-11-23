// Fakes for the A2 interview tests and the scripted local run: a code runner that answers from a table, and a model that plays the checker
// and the writer. Neither runs anything real.
const { squash } = require('../../agent/rubric-check');

/**
 * A runBatch (the shape of codeRunner.runCppBatch). `plain[cmd]` is what a plain run of that command prints; `stops[cmd]` the trace stops
 * ("name=value, ..." texts) a trace run of it reports on stderr. A program that holds a trace marker is a trace copy. `calls` records every run.
 */
function fakeRunBatch({ plain = {}, stops = {}, status = {} } = {}) {
  const calls = [];
  const fn = async (runs) => runs.map((run) => {
    const cmd = String(run.stdin).trim();
    calls.push({ cmd, trace: /@@TRACE-/.test(run.source) });
    if (status[cmd]) return { status: status[cmd], stdout: '', stderr: '', compileOutput: '', timeMs: 3, memoryKb: 1 };
    const marker = (/@@TRACE-[0-9a-f]+@@/.exec(run.source) || [])[0];
    const lines = marker ? (stops[cmd] || []).map((text, i) => `${marker}\t${i + 1}\t${text.split(', ').join('\t')}`) : [];
    return { status: 'accepted', stdout: `${plain[cmd] === undefined ? '' : plain[cmd]}\n`, stderr: lines.join('\n'), compileOutput: '', timeMs: 3, memoryKb: 1 };
  });
  fn.calls = calls;
  return fn;
}

const CHECKER_START = 'You check one short answer';
const answerOf = (message) => (/<student_answer>\n([\s\S]*?)\n<\/student_answer>/.exec(message) || [])[1] || '';

/**
 * A converse function. `decide({ ask, answer })` plays the checker: it returns 'yes', 'no' or 'unclear' (default: yes when the answer holds
 * the value or the key named in the check, no otherwise). `write({ message })` plays the writer and returns its question text.
 * `requests` records every request, so a test can look at what a model was sent.
 */
function fakeModel({ decide, write } = {}) {
  const requests = [];
  const converseFn = async (request) => {
    requests.push(request);
    const message = request.messages[request.messages.length - 1].content[0].text;
    if (String(request.system).startsWith(CHECKER_START)) {
      const first = request.messages[0].content[0].text;
      const ask = (/^(Check:.*|Answer key:.*\nCheck:.*)$/m.exec(first) || [first])[0];
      const answer = answerOf(first);
      const verdict = decide ? decide({ ask, answer, message: first }) : defaultDecide(first, answer);
      const quote = verdict === 'unclear' ? '' : answer.replace(/\s+/g, ' ').slice(0, 60);
      return { text: JSON.stringify({ verdict, quote }), inputTokens: 10, outputTokens: 5, latencyMs: 1 };
    }
    const question = write ? write({ message }) : 'Walk me through what the loop does on the first pass with this input.';
    return { text: JSON.stringify({ target: 'r1', isHint: false, question }), inputTokens: 20, outputTokens: 8, latencyMs: 1 };
  };
  converseFn.requests = requests;
  return converseFn;
}

/** yes when the answer holds the value ("the value X") or the answer key the check names. */
function defaultDecide(message, answer) {
  const value = /does this answer give the value (.*?)\? \(/.exec(message);
  const key = /Answer key: (.*)\n/.exec(message);
  const target = value ? value[1] : key ? key[1] : null;
  if (target === null) return squash(answer).includes('correct') ? 'yes' : 'no';
  return squash(answer).includes(squash(target)) ? 'yes' : 'no';
}

module.exports = { fakeRunBatch, fakeModel, answerOf };
