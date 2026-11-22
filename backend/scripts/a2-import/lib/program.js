// The program parts of one student's function, for the plan: the header text (with the driver macros that leave out the functions that are
// not there) and the student source to build from. For a file that compiles as a whole that is the file itself. For a file that was split
// (it did not compile as a whole) it is the file with every other function blanked (line numbers stay the student's), keeping the helpers
// the function calls that compile on their own, and, when the error was outside the functions, only the top part's #include and using lines.
// This is for the test build only: the stored code is never changed.
const { FUNCTIONS } = require('./common');
const { splitFunctions, helpersOf, composeFile } = require('./split');
const { definesFor } = require('./analyze');

/**
 * @returns {(fn: string) => { header: string, studentSource: string } | { error: string }}
 */
function programFactory({ record, code, studentHeader, officialHeader }) {
  const headerOf = (name) => (name === 'student' && typeof studentHeader === 'string' && studentHeader.trim() ? studentHeader : officialHeader);
  if (record.status === 'ok') {
    const missing = FUNCTIONS.filter((fn) => record.functions[fn] && record.functions[fn].present === false);
    return () => ({ header: definesFor(missing) + headerOf(record.headerUsed), studentSource: code });
  }
  const split = splitFunctions(code);
  return (fn) => {
    if (!split.ok) return { error: `the file could not be split: ${split.reason}` };
    const f = record.functions[fn];
    const def = split.functions.find((d) => d.name === fn);
    if (!f || !def || !f.compilesAlone) return { error: `${fn} does not compile on its own` };
    const broken = new Set(f.brokenHelpers || []);
    const helpers = helpersOf(def, split.functions).filter((h) => !broken.has(h.name));
    return {
      header: definesFor(FUNCTIONS.filter((x) => x !== fn)) + headerOf(f.headerUsed),
      studentSource: composeFile(split, [def, ...helpers], { minimalTop: Boolean(record.outsideFunctionsError) }),
    };
  };
}

module.exports = { programFactory };
