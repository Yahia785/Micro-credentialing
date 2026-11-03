/**
 * Output comparison identical to Judge0's (app/jobs/isolate_job.rb):
 *
 *   elsif submission.expected_output.nil? || strip(submission.expected_output) == strip(submission.stdout)
 *     Status.ac
 *   else Status.wa
 *
 *   def strip(text)
 *     return nil unless text
 *     text.split("\n").collect(&:rstrip).join("\n").rstrip
 *   rescue ArgumentError
 *     return text
 *   end
 *
 * So Judge0 ignores: trailing whitespace on every line (space, \t, \v, \f, \r and NUL, so CRLF
 * output matches LF), and trailing blank lines at the end. It keeps leading whitespace, blank
 * lines in the middle, and case. An empty stdout is stored as nil, so it only matches when the
 * expected output is nil too (our backend never sends an empty expected output, it sends none).
 * Text that is not valid UTF-8 makes Ruby raise ArgumentError, and strip then returns it unchanged.
 */

const RUBY_RSTRIP = /[\t\n\v\f\r \0]+$/;
const rstrip = text => text.replace(RUBY_RSTRIP, '');

function isValidUtf8(buffer) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/** @param {Buffer|null} buffer @returns {string|Buffer|null} */
function judge0Strip(buffer) {
  if (buffer === null) return null;
  if (!isValidUtf8(buffer)) return buffer;
  return rstrip(buffer.toString('utf-8').split('\n').map(rstrip).join('\n'));
}

const same = (a, b) => (Buffer.isBuffer(a) || Buffer.isBuffer(b)
  ? Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b)
  : a === b);

/**
 * @param {string|null|undefined} expectedOutput  '' / null / undefined means "no expected output" (always accepted)
 * @param {Buffer} stdout                         raw program output; empty is treated as nil
 * @returns {boolean} true when Judge0 would answer Accepted
 */
function outputMatches(expectedOutput, stdout) {
  if (expectedOutput === undefined || expectedOutput === null || expectedOutput === '') return true;
  const actual = stdout.length === 0 ? null : stdout;
  return same(judge0Strip(Buffer.from(expectedOutput, 'utf-8')), judge0Strip(actual));
}

module.exports = { outputMatches, judge0Strip };
