// The item stored in ImportedSubmissions-<env>. No grades, no names, no emails: only the GitHub handle, the roster identifier from the
// roster CSV, and what the import found. The student's code is in S3 (s3Keys), never in the item.
const crypto = require('crypto');
const { s3KeysFor, normalizeUsername } = require('./common');

const COMMIT_DATE_NOTE = 'Commit dates come from git and can be edited by the student (known limit).';
const newImportId = () => crypto.randomUUID();

/** The statuses a record can have. */
const STATUS = Object.freeze({
  OK: 'ok',
  NO_VERSION: 'no_version_before_deadline',
  MISSING_FILES: 'missing_files',
  FILE_DOES_NOT_COMPILE: 'file_does_not_compile', // the whole file does not compile, but some interview functions compile alone
  NOTHING_COMPILES: 'nothing_compiles', // no interview function compiles
});

/** One analysed input as it is stored (the sanitizer and the plain run, in short). */
const storedInput = (i) => ({
  function: i.function,
  cmd: i.cmd,
  sanitizer: i.sanitizer,
  plainStatus: i.plain.status,
  output: i.output,
  matchesSpec: i.matchesSpec,
  unclearSpec: i.unclearSpec,
  excludeFromQuestions: i.excludeFromQuestions,
  excludeReason: i.excludeReason,
});

/**
 * @param {{ importId: string, username: string, rosterIdentifier?: string|null, commit?: {hash:string, committedAtIso:string}|null,
 *           deadlineIso: string, status: string, analysis?: object|null, hasFiles: boolean, now: string }} a
 */
function buildRecord({ importId, username, rosterIdentifier = null, commit = null, deadlineIso, status, analysis = null, hasFiles, now }) {
  const functions = analysis ? analysis.functions : null;
  return {
    importId,
    githubUsername: normalizeUsername(username),
    rosterIdentifier: rosterIdentifier || null,
    commitHash: commit ? commit.hash : null,
    commitDate: commit ? commit.committedAtIso : null,
    commitDateNote: COMMIT_DATE_NOTE,
    deadline: deadlineIso,
    status,
    headerUsed: analysis ? analysis.headerUsed : null,
    studentHeaderProblem: analysis ? analysis.studentHeaderProblem : null,
    compileError: analysis ? analysis.compileError : null,
    outsideFunctionsError: analysis ? analysis.outsideFunctionsError || null : null, // an error outside the functions that blocked the whole file: { line, message }
    functions,
    modeNeeded: analysis ? analysis.modeNeeded : null,
    inputs: analysis ? analysis.inputs.map(storedInput) : [],
    s3Keys: hasFiles ? s3KeysFor(importId) : null,
    importedAt: now,
    linkedUserId: null, // set when the student is matched to an account (M6)
    consent: 'unknown', // "yes" or "no" once the student has answered
  };
}

module.exports = { buildRecord, newImportId, storedInput, STATUS, COMMIT_DATE_NOTE };
