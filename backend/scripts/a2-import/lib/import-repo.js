// Importing one repository: pick the version, read the two files from git, analyse, then (unless it is a dry run) upload and write the record.
// Everything with side effects is injected through `deps`, so tests use fakes.
const { pickCommit, parseDeadline } = require('./pick');
const { buildRecord, newImportId, STATUS } = require('./record');
const { analyzeSubmission } = require('./analyze');
const { normalizeUsername, s3KeysFor } = require('./common');

/**
 * @param {object} args
 * @param {{ name: string, gitDir?: string, url?: string }} args.repo
 * @param {string} args.username        lower-case GitHub username
 * @param {string|null} args.rosterIdentifier
 * @param {string} args.deadlineIso
 * @param {{ officialHeader: string, driver: string, inputs: object[] }} args.assets
 * @param {boolean} args.dryRun
 * @param {object} deps  { git: { listCommits, showFile, cloneBare }, makeDocker, store (null in a dry run), newId, now }
 * @returns {Promise<{ record: object, uploaded: boolean, skipped?: string }>}
 */
async function importRepo({ repo, username, rosterIdentifier = null, deadlineIso, assets, dryRun }, deps) {
  const { git, makeDocker, store, newId = newImportId, now = () => new Date().toISOString() } = deps;
  const deadline = parseDeadline(deadlineIso);
  const user = normalizeUsername(username);
  const base = { username: user, rosterIdentifier, deadlineIso, now: now() };

  let gitDir = repo.gitDir;
  let cleanupClone = null;
  const docker = makeDocker();
  try {
    if (!gitDir) {
      const clone = git.cloneBare(repo.url);
      if (!clone.ok) throw new Error(clone.reason);
      gitDir = clone.gitDir;
      cleanupClone = clone.cleanup;
    }

    // 1. the version: the last commit made before the deadline
    const commit = pickCommit(git.listCommits(gitDir), deadline);
    const importId = newId();
    if (!commit) return { record: buildRecord({ ...base, importId, status: STATUS.NO_VERSION, hasFiles: false }), uploaded: false };

    // 2. the two files at that commit (read with git show; nothing is checked out)
    const header = git.showFile(gitDir, commit.hash, 'functions.h');
    const code = git.showFile(gitDir, commit.hash, 'functions.cpp');
    if (code === null || !code.trim()) return { record: buildRecord({ ...base, importId, commit, status: STATUS.MISSING_FILES, hasFiles: false }), uploaded: false };

    // 3 to 6. header, functions, sanitizers, plain runs
    const analysis = await analyzeSubmission({ studentHeader: header, studentCode: code, officialHeader: assets.officialHeader, driver: assets.driver, inputs: assets.inputs, docker });
    const status = analysis.status;
    const record = buildRecord({ ...base, importId, commit, status, analysis, hasFiles: true });

    // 7. upload the files, then write the record
    if (dryRun) return { record, uploaded: false, files: { header, source: code } };
    const existing = await store.findByUsername(user);
    if (existing.length > 0) return { record, uploaded: false, skipped: 'already imported (delete it first with delete.js)' };
    await store.putFiles(s3KeysFor(importId), header, code);
    await store.putRecord(record);
    return { record, uploaded: true };
  } finally {
    docker.cleanup(); // the container and the temporary copies of the student's files
    if (cleanupClone) cleanupClone();
  }
}

/** One short line per excluded input: "reverseList (empty input): sanitizer: sanitizer". */
function excludedSummary(record) {
  return record.inputs.filter((i) => i.excludeFromQuestions).map((i) => `${i.function} (${i.cmd.replace(/^\S+ ?/, '').replace(/^, /, '') || 'empty input'}): ${i.excludeReason}${i.sanitizer.report ? ` [${i.sanitizer.report.slice(0, 80)}]` : ''}`);
}

module.exports = { importRepo, excludedSummary };
