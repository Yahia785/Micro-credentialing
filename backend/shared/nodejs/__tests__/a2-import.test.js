const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const lib = '../../../scripts/a2-import/lib';
const { pickCommit, parseDeadline } = require(`${lib}/pick`);
const { buildRecord, STATUS } = require(`${lib}/record`);
const { s3KeysFor, tableFor, FUNCTIONS } = require(`${lib}/common`);
const { analyzeSubmission, parseCompilerOutput, classifySanitizerRun } = require(`${lib}/analyze`);
const { importRepo } = require(`${lib}/import-repo`);
const { makeStore } = require(`${lib}/store`);
const { parseRoster } = require(`${lib}/roster`);
const { selectForDeletion, keysOf } = require(`${lib}/select-delete`);
const del = require('../../../scripts/a2-import/delete');
const harness = require('../services/harness-builder');

const DEADLINE = '2026-03-01T23:59:00Z';
const DEADLINE_S = Date.parse(DEADLINE) / 1000;
const commit = (hash, offsetS) => ({ hash, committedAt: DEADLINE_S + offsetS, committedAtIso: new Date((DEADLINE_S + offsetS) * 1000).toISOString() });

const OFFICIAL = '#ifndef FUNCTIONS_H\n#define FUNCTIONS_H\n#include <vector>\n#include <string>\nusing namespace std;\nvoid reverseList(vector<int>& vec);\nvector<string> splitString(string str, char delim);\nint playCraps(const vector<int>& rolls);\nint mode(const vector<int>& vec);\n#endif\n';
const DRIVER_STUB = '#include "functions.h"\nint main() { return 0; }\n';
const INPUTS = [
  { function: 'reverseList', cmd: 'reverseList 1 2 3', spec: '[3, 2, 1]' },
  { function: 'reverseList', cmd: 'reverseList', spec: '[]' },
  { function: 'playCraps', cmd: 'playCraps 5 6', spec: '0' },
  { function: 'mode', cmd: 'mode 5', spec: '5', unclearSpec: false },
];

/** A fake docker: compile() answers from a function of the source; runInputs() from a function of the commands. */
const fakeDocker = ({ compile = () => ({ ok: true, errors: '' }), run } = {}) => ({
  compile: jest.fn(async (source) => compile(source)),
  runInputs: jest.fn(async ({ cmds }) => (run ? run(cmds) : {
    sanCompile: { ok: true }, plainCompile: { ok: true },
    runs: cmds.map(() => ({ san: { code: 0, stderr: '' }, plain: { code: 0, stdout: 'x\n' } })),
  })),
  cleanup: jest.fn(),
});

describe('pickCommit', () => {
  test('takes the commit with the latest committer date before the deadline', () => {
    const commits = [commit('late', 3600), commit('c', -86400), commit('b', -3 * 86400), commit('a', -10 * 86400)];
    expect(pickCommit(commits, DEADLINE_S).hash).toBe('c');
  });

  test('a commit made at the deadline is too late; one second before is fine', () => {
    expect(pickCommit([commit('at', 0), commit('before', -1)], DEADLINE_S).hash).toBe('before');
    expect(pickCommit([commit('at', 0)], DEADLINE_S)).toBeNull();
  });

  test('the order of the list does not matter, so a late commit cannot be pulled in by its position', () => {
    expect(pickCommit([commit('old', -5000), commit('late', 100), commit('new', -10)], DEADLINE_S).hash).toBe('new');
    expect(pickCommit([commit('new', -10), commit('late', 100), commit('old', -5000)], DEADLINE_S).hash).toBe('new');
  });

  test('no commit before the deadline, or no commits, is null', () => {
    expect(pickCommit([commit('x', 10), commit('y', 99999)], DEADLINE_S)).toBeNull();
    expect(pickCommit([], DEADLINE_S)).toBeNull();
    expect(pickCommit(undefined, DEADLINE_S)).toBeNull();
  });

  test('parseDeadline reads an ISO date and rejects other text', () => {
    expect(parseDeadline(DEADLINE)).toBe(DEADLINE_S);
    expect(parseDeadline('not a date')).toBeNull();
    expect(parseDeadline(undefined)).toBeNull();
  });
});

describe('parseCompilerOutput and the missing-function detection', () => {
  test('finds a function the driver cannot link (declared, never defined)', () => {
    const out = "/usr/bin/ld: driver.cpp:(.text+0x1): undefined reference to `mode(std::vector<int, std::allocator<int> > const&)'\ncollect2: error: ld returned 1 exit status";
    expect(parseCompilerOutput(out).missing).toEqual(['mode']);
    expect(parseCompilerOutput(out).linkError).toBe(true);
  });

  test('finds a function that is not even declared in the student header (an error in the driver)', () => {
    const out = "driver.cpp:91:24: error: 'mode' was not declared in this scope\n   91 |         cout << mode(numbers)";
    expect(parseCompilerOutput(out).missing).toEqual(['mode']);
    expect(parseCompilerOutput(out).files).toEqual(['driver.cpp']);
  });

  test('an error in the student code is not a missing function', () => {
    const out = "functions.cpp:12:5: error: 'mode' was not declared in this scope";
    expect(parseCompilerOutput(out).missing).toEqual([]);
    expect(parseCompilerOutput(out).files).toEqual(['functions.cpp']);
  });
});

describe('analyzeSubmission', () => {
  test('header fallback: the student header fails, the official header builds, and the record says which was used', async () => {
    const docker = fakeDocker({ compile: (source) => (source.includes('STUDENT_HEADER') ? { ok: false, errors: "driver.cpp:75:20: error: call of overloaded 'splitString(std::string&, char&)' is ambiguous" } : { ok: true, errors: '' }) });
    const a = await analyzeSubmission({ studentHeader: `${OFFICIAL}// STUDENT_HEADER\n`, studentCode: 'int x;\n', officialHeader: OFFICIAL, driver: DRIVER_STUB, inputs: INPUTS, docker });
    expect(a.status).toBe('ok');
    expect(a.headerUsed).toBe('official');
    expect(a.studentHeaderProblem).toContain('ambiguous');
    expect(docker.compile).toHaveBeenCalledTimes(2); // the student header first, then the official one
  });

  test('the student header is used when it builds, and the official header is never tried', async () => {
    const docker = fakeDocker();
    const a = await analyzeSubmission({ studentHeader: OFFICIAL, studentCode: 'int x;\n', officialHeader: OFFICIAL, driver: DRIVER_STUB, inputs: INPUTS, docker });
    expect(a.headerUsed).toBe('student');
    expect(a.studentHeaderProblem).toBeNull();
    expect(docker.compile).toHaveBeenCalledTimes(1);
  });

  test('a repository without functions.h is built with the official header', async () => {
    const a = await analyzeSubmission({ studentHeader: null, studentCode: 'int x;\n', officialHeader: OFFICIAL, driver: DRIVER_STUB, inputs: INPUTS, docker: fakeDocker() });
    expect(a.headerUsed).toBe('official');
    expect(a.studentHeaderProblem).toContain('missing');
  });

  test('a missing function is detected, the driver is rebuilt without it, and mode becomes needed', async () => {
    const link = "driver.cpp:(.text+0x9): undefined reference to `playCraps(std::vector<int, std::allocator<int> > const&)'";
    const docker = fakeDocker({ compile: (source) => (source.includes('#define A2_NO_PLAYCRAPS 1') ? { ok: true, errors: '' } : { ok: false, errors: link }) });
    const a = await analyzeSubmission({ studentHeader: OFFICIAL, studentCode: 'int x;\n', officialHeader: OFFICIAL, driver: DRIVER_STUB, inputs: INPUTS, docker });
    expect(a.status).toBe('ok');
    expect(a.functions.playCraps).toEqual({ present: false, compiles: false });
    expect(a.functions.reverseList).toEqual({ present: true, compiles: true });
    expect(a.modeNeeded).toBe(true);
    expect(docker.compile).toHaveBeenCalledTimes(2);
    // the missing function's inputs are not run
    expect(docker.runInputs.mock.calls[0][0].cmds).toEqual(['reverseList 1 2 3', 'reverseList', 'mode 5']);
    expect(docker.runInputs.mock.calls[0][0].source).toContain('#define A2_NO_PLAYCRAPS 1');
  });

  test('a missing mode does not make mode "needed" (it is the backup itself)', async () => {
    const docker = fakeDocker({ compile: (source) => (source.includes('#define A2_NO_MODE 1') ? { ok: true, errors: '' } : { ok: false, errors: "driver.cpp:91:24: error: 'mode' was not declared in this scope" }) });
    const a = await analyzeSubmission({ studentHeader: OFFICIAL, studentCode: 'int x;\n', officialHeader: OFFICIAL, driver: DRIVER_STUB, inputs: INPUTS, docker });
    expect(a.functions.mode.present).toBe(false);
    expect(a.modeNeeded).toBe(false);
  });

  test('code that does not compile with either header and has no interview function is nothing_compiles', async () => {
    const docker = fakeDocker({ compile: () => ({ ok: false, errors: ["functions.cpp:40:13: error: expected primary-expression before ';' token", '   40 | int secret = ;'].join('\n') }) });
    const a = await analyzeSubmission({ studentHeader: OFFICIAL, studentCode: 'int secret = ;\n', officialHeader: OFFICIAL, driver: DRIVER_STUB, inputs: INPUTS, docker });
    expect(a.status).toBe('nothing_compiles');
    expect(a.modeNeeded).toBe(true);
    expect(a.functions.reverseList).toMatchObject({ present: false, compilesAlone: false });
    expect(a.compileError).toContain('expected primary-expression');
    expect(a.compileError).not.toContain('secret'); // no source line is stored, only the compiler's message
    expect(docker.runInputs).not.toHaveBeenCalled();
  });

  test('inputs that are not ok under the sanitizers or the plain build are excluded, with the reason', async () => {
    const docker = fakeDocker({
      run: () => ({
        sanCompile: { ok: true },
        plainCompile: { ok: true },
        runs: [
          { san: { code: 0, stderr: '' }, plain: { code: 0, stdout: '[3, 2, 1]\n' } },
          { san: { code: 1, stderr: '==1==ERROR: AddressSanitizer: SEGV on unknown address\n    #0 0x1 in reverseList functions.cpp:7' }, plain: { code: 139, stdout: '' } },
          { san: { code: 124, stderr: '' }, plain: { code: 124, stdout: '' } },
          { san: { code: 0, stderr: 'functions.cpp:9:3: runtime error: signed integer overflow' }, plain: { code: 0, stdout: '5\n' } },
        ],
      }),
    });
    const a = await analyzeSubmission({ studentHeader: OFFICIAL, studentCode: 'int x;\n', officialHeader: OFFICIAL, driver: DRIVER_STUB, inputs: INPUTS, docker });
    const [ok, segv, slow, ub] = a.inputs;
    expect(ok).toMatchObject({ excludeFromQuestions: false, matchesSpec: true, output: '[3, 2, 1]' });
    expect(segv).toMatchObject({ excludeFromQuestions: true, excludeReason: 'sanitizer: sanitizer', matchesSpec: false });
    expect(segv.sanitizer.report).toContain('AddressSanitizer');
    expect(slow).toMatchObject({ excludeFromQuestions: true, sanitizer: { status: 'time_limit' } });
    expect(ub).toMatchObject({ excludeFromQuestions: true, sanitizer: { status: 'sanitizer' }, plain: { status: 'ok' }, matchesSpec: true });
    expect(ub.sanitizer.report).toContain('runtime error');
  });

  test('classifySanitizerRun: crash without a report, and only the first lines of a report are kept', () => {
    expect(classifySanitizerRun({ code: 139, stderr: '' })).toEqual({ status: 'crash', report: 'exit code 139' });
    const long = `==1==ERROR: AddressSanitizer: heap-buffer-overflow\n${Array.from({ length: 30 }, (_, i) => `    #${i} 0x1 in f`).join('\n')}`;
    expect(classifySanitizerRun({ code: 1, stderr: long }).report.split(' | ').length).toBeLessThanOrEqual(3);
  });
});

describe('importRepo', () => {
  const assets = { officialHeader: OFFICIAL, driver: DRIVER_STUB, inputs: INPUTS };
  const makeGit = (commits, files = { 'functions.h': OFFICIAL, 'functions.cpp': 'int x;\n' }) => ({
    listCommits: jest.fn(() => commits),
    showFile: jest.fn((dir, hash, file) => (file in files ? files[file] : null)),
    cloneBare: jest.fn(),
  });
  const deps = (git, over = {}) => ({ git, makeDocker: () => over.docker || fakeDocker(), store: over.store || null, newId: () => 'import-1', now: () => '2026-11-21T00:00:00.000Z' });

  test('uses the version before the deadline and ignores a later commit that changed the code', async () => {
    const git = makeGit([commit('late', 7200), commit('final', -86400), commit('early', -9 * 86400)]);
    const { record } = await importRepo({ repo: { name: 'assignment-02-octocat', gitDir: '/x' }, username: 'OctoCat', rosterIdentifier: 'S1', deadlineIso: DEADLINE, assets, dryRun: true }, deps(git));
    expect(git.showFile.mock.calls.map((c) => c[1])).toEqual(['final', 'final']);
    expect(record).toMatchObject({ commitHash: 'final', status: STATUS.OK, githubUsername: 'octocat', rosterIdentifier: 'S1' });
  });

  test('no commit before the deadline: no_version_before_deadline, no files read, nothing analysed or stored', async () => {
    const git = makeGit([commit('late', 60), commit('later', 99999)]);
    const docker = fakeDocker();
    const store = { findByUsername: jest.fn(), putFiles: jest.fn(), putRecord: jest.fn() };
    const { record, uploaded } = await importRepo({ repo: { name: 'r', gitDir: '/x' }, username: 'late', deadlineIso: DEADLINE, assets, dryRun: false }, deps(git, { docker, store }));
    expect(record).toMatchObject({ status: 'no_version_before_deadline', commitHash: null, s3Keys: null, inputs: [], functions: null });
    expect(uploaded).toBe(false);
    expect(git.showFile).not.toHaveBeenCalled();
    expect(docker.compile).not.toHaveBeenCalled();
    expect(store.putFiles).not.toHaveBeenCalled();
    expect(store.putRecord).not.toHaveBeenCalled();
    expect(docker.cleanup).toHaveBeenCalled();
  });

  test('a repository without functions.cpp at that commit is missing_files', async () => {
    const git = makeGit([commit('c', -10)], { 'functions.h': OFFICIAL });
    const { record } = await importRepo({ repo: { name: 'r', gitDir: '/x' }, username: 'u', deadlineIso: DEADLINE, assets, dryRun: true }, deps(git));
    expect(record).toMatchObject({ status: 'missing_files', commitHash: 'c', s3Keys: null });
  });

  test('a real run uploads the files first, then writes the record; a dry run does neither', async () => {
    const git = makeGit([commit('c', -10)]);
    const order = [];
    const store = { findByUsername: jest.fn(async () => []), putFiles: jest.fn(async () => order.push('files')), putRecord: jest.fn(async () => order.push('record')) };
    const real = await importRepo({ repo: { name: 'r', gitDir: '/x' }, username: 'u', deadlineIso: DEADLINE, assets, dryRun: false }, deps(git, { store }));
    expect(order).toEqual(['files', 'record']);
    expect(real.uploaded).toBe(true);
    expect(store.putFiles).toHaveBeenCalledWith(s3KeysFor('import-1'), OFFICIAL, 'int x;\n');
    const dry = await importRepo({ repo: { name: 'r', gitDir: '/x' }, username: 'u', deadlineIso: DEADLINE, assets, dryRun: true }, deps(git, { store }));
    expect(dry.uploaded).toBe(false);
    expect(store.putRecord).toHaveBeenCalledTimes(1);
  });

  test('a username that is already imported is skipped, not duplicated', async () => {
    const git = makeGit([commit('c', -10)]);
    const store = { findByUsername: jest.fn(async () => [{ importId: 'old' }]), putFiles: jest.fn(), putRecord: jest.fn() };
    const r = await importRepo({ repo: { name: 'r', gitDir: '/x' }, username: 'u', deadlineIso: DEADLINE, assets, dryRun: false }, deps(git, { store }));
    expect(r.skipped).toContain('already imported');
    expect(store.putFiles).not.toHaveBeenCalled();
  });

  test('a clone URL is cloned to a temporary folder that is removed afterwards', async () => {
    const cleanup = jest.fn();
    const git = { ...makeGit([commit('c', -10)]), cloneBare: jest.fn(() => ({ ok: true, gitDir: '/tmp/clone', cleanup })) };
    await importRepo({ repo: { name: 'r', url: 'https://example.invalid/r.git' }, username: 'u', deadlineIso: DEADLINE, assets, dryRun: true }, deps(git));
    expect(git.listCommits).toHaveBeenCalledWith('/tmp/clone');
    expect(cleanup).toHaveBeenCalled();
  });
});

describe('the record', () => {
  const analysis = { status: 'ok', headerUsed: 'student', studentHeaderProblem: null, compileError: null, modeNeeded: false, functions: { reverseList: { present: true, compiles: true } }, inputs: [{ function: 'mode', cmd: 'mode 5', sanitizer: { status: 'ok', report: null }, plain: { status: 'ok', output: '5' }, output: '5', matchesSpec: true, unclearSpec: false, excludeFromQuestions: false, excludeReason: null }] };
  const record = buildRecord({ importId: 'abc-123', username: 'Octo-Cat', rosterIdentifier: 'S42', commit: commit('h', -5), deadlineIso: DEADLINE, status: 'ok', analysis, hasFiles: true, now: 'NOW' });

  test('has exactly the planned fields', () => {
    expect(Object.keys(record).sort()).toEqual(['commitDate', 'commitDateNote', 'commitHash', 'compileError', 'consent', 'deadline', 'functions', 'githubUsername', 'headerUsed', 'importId', 'importedAt', 'inputs', 'linkedUserId', 'modeNeeded', 'outsideFunctionsError', 'rosterIdentifier', 'status', 's3Keys', 'studentHeaderProblem'].sort());
    expect(record).toMatchObject({ githubUsername: 'octo-cat', rosterIdentifier: 'S42', linkedUserId: null, consent: 'unknown', importedAt: 'NOW', deadline: DEADLINE });
    expect(record.commitDateNote).toContain('can be edited by the student');
  });

  test('has no grade, name, email or code', () => {
    const text = JSON.stringify(record).toLowerCase();
    ['points', 'grade', 'email', '"name"', 'fullname'].forEach((word) => expect(text).not.toContain(word));
    expect(record.inputs[0]).not.toHaveProperty('stdout');
  });

  test('the S3 keys hold the random importId and never the GitHub username', () => {
    expect(record.s3Keys).toEqual({ header: 'a2-pilot/abc-123/functions.h', source: 'a2-pilot/abc-123/functions.cpp' });
    expect(JSON.stringify(record.s3Keys).toLowerCase()).not.toContain('octo');
    expect(JSON.stringify(s3KeysFor('xyz'))).not.toContain('octo');
  });

  test('the table is named after the environment', () => {
    expect(tableFor('dev')).toBe('ImportedSubmissions-dev');
    expect(FUNCTIONS).toEqual(['reverseList', 'splitString', 'playCraps', 'mode']);
  });
});

describe('the store', () => {
  const sdk = {};
  ['PutObjectCommand', 'DeleteObjectCommand', 'PutCommand', 'QueryCommand', 'ScanCommand', 'DeleteCommand'].forEach((name) => { sdk[name] = class { constructor(input) { this.name = name; this.input = input; } }; });
  const sent = [];
  const client = { send: jest.fn(async (command) => { sent.push(command); return {}; }) };
  const store = makeStore({ table: 'ImportedSubmissions-dev', bucket: 'bucket-x', sdk, s3: client, ddb: client });
  beforeEach(() => { sent.length = 0; });

  test('uploads under a2-pilot/<importId>/ with server-side encryption, and the key has no username', async () => {
    await store.putFiles(s3KeysFor('id-9'), 'H', 'C');
    expect(sent.map((c) => c.input.Key)).toEqual(['a2-pilot/id-9/functions.h', 'a2-pilot/id-9/functions.cpp']);
    sent.forEach((c) => { expect(c.input.ServerSideEncryption).toBe('AES256'); expect(c.input.Bucket).toBe('bucket-x'); });
  });

  test('refuses to touch an S3 key outside a2-pilot/', async () => {
    await expect(store.deleteObject('recordings/other.webm')).rejects.toThrow('outside a2-pilot/');
    await expect(store.deleteObject('a2-pilot/../x')).rejects.toThrow('outside');
    expect(sent).toHaveLength(0);
  });

  test('writes a record only when its importId is new, and looks usernames up through the index in lower case', async () => {
    await store.putRecord({ importId: 'i' });
    expect(sent[0].input.ConditionExpression).toBe('attribute_not_exists(importId)');
    await store.findByUsername('OctoCat');
    expect(sent[1].input).toMatchObject({ IndexName: 'GithubUsernameIndex', ExpressionAttributeValues: { ':u': 'octocat' } });
  });
});

describe('the roster', () => {
  test('reads the GitHub handle and the roster identifier and nothing else', () => {
    const csv = 'assignment_name,github_username,roster_identifier,student_repository_name,points_awarded,points_available\n"Assignment 02, fake",OctoCat,S1,assignment-02-OctoCat,88,100\nA,,S2,x,,\nA,second-user,,y,,\n';
    const roster = parseRoster(csv);
    expect([...roster.keys()]).toEqual(['octocat', 'second-user']);
    expect(roster.get('octocat')).toEqual({ rosterIdentifier: 'S1' });
    expect(roster.get('second-user')).toEqual({ rosterIdentifier: null });
    expect(JSON.stringify([...roster])).not.toContain('88');
  });

  test('a CSV without a github_username column is an error', () => {
    expect(() => parseRoster('a,b\n1,2\n')).toThrow('github_username');
  });
});

describe('delete: which records are selected', () => {
  const items = [
    { importId: '1', githubUsername: 'amy', consent: 'yes', s3Keys: { header: 'a2-pilot/1/functions.h', source: 'a2-pilot/1/functions.cpp' } },
    { importId: '2', githubUsername: 'ben', consent: 'unknown', s3Keys: { header: 'a2-pilot/2/functions.h', source: 'a2-pilot/2/functions.cpp' } },
    { importId: '3', githubUsername: 'cat', consent: 'no', s3Keys: null },
    { importId: '4', githubUsername: 'dan' },
  ];

  test('by username (case-insensitive), whatever the consent', () => {
    expect(selectForDeletion({ items, usernames: ['AMY', 'dan'] }).map((i) => i.importId)).toEqual(['1', '4']);
    expect(selectForDeletion({ items, usernames: ['nobody'] })).toEqual([]);
  });

  test('everyone whose consent is not "yes" (unknown, no and missing)', () => {
    expect(selectForDeletion({ items, withoutConsent: true }).map((i) => i.importId)).toEqual(['2', '3', '4']);
  });

  test('exactly one mode', () => {
    expect(() => selectForDeletion({ items })).toThrow('exactly one');
    expect(() => selectForDeletion({ items, usernames: ['amy'], withoutConsent: true })).toThrow('exactly one');
  });

  test('keysOf lists the objects of a record, none when it has no files', () => {
    expect(keysOf(items[1])).toEqual(['a2-pilot/2/functions.h', 'a2-pilot/2/functions.cpp']);
    expect(keysOf(items[2])).toEqual([]);
    expect(keysOf(items[3])).toEqual([]);
  });
});

describe('delete: dry run and --confirm', () => {
  const items = [
    { importId: '1', githubUsername: 'amy', consent: 'yes', s3Keys: { header: 'a2-pilot/1/functions.h', source: 'a2-pilot/1/functions.cpp' } },
    { importId: '2', githubUsername: 'ben', consent: 'unknown', s3Keys: { header: 'a2-pilot/2/functions.h', source: 'a2-pilot/2/functions.cpp' } },
  ];
  const makeStoreFake = () => ({
    table: 't', bucket: 'b',
    findByUsername: jest.fn(async (u) => items.filter((i) => i.githubUsername === u)),
    scanAll: jest.fn(async () => items),
    deleteObject: jest.fn(async () => {}),
    deleteRecord: jest.fn(async () => {}),
  });
  const args = (over) => ({ ...del.parseArgs([]), ...over });

  test('the default is a dry run: it prints and deletes nothing', async () => {
    const store = makeStoreFake();
    const lines = [];
    const counts = await del.run(args({ usernames: ['ben'] }), store, (l) => lines.push(l));
    expect(counts).toMatchObject({ records: 1, objects: 2, deletedRecords: 0, deletedObjects: 0 });
    expect(store.deleteObject).not.toHaveBeenCalled();
    expect(store.deleteRecord).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('DRY RUN');
  });

  test('--confirm deletes the objects, then the record', async () => {
    const store = makeStoreFake();
    const order = [];
    store.deleteObject.mockImplementation(async (k) => order.push(k));
    store.deleteRecord.mockImplementation(async (id) => order.push(`record ${id}`));
    const counts = await del.run(args({ usernames: ['ben'], confirm: true }), store, () => {});
    expect(order).toEqual(['a2-pilot/2/functions.h', 'a2-pilot/2/functions.cpp', 'record 2']);
    expect(counts).toMatchObject({ deletedRecords: 1, deletedObjects: 2, failures: 0 });
  });

  test('without consent: the record with consent "yes" is kept', async () => {
    const store = makeStoreFake();
    await del.run(args({ withoutConsent: true, confirm: true }), store, () => {});
    expect(store.deleteRecord.mock.calls.map((c) => c[0])).toEqual(['2']);
  });

  test('a record whose objects could not be deleted is kept, and the failure is counted', async () => {
    const store = makeStoreFake();
    store.deleteObject.mockRejectedValueOnce(new Error('AccessDenied'));
    const counts = await del.run(args({ usernames: ['ben'], confirm: true }), store, () => {});
    expect(store.deleteRecord).not.toHaveBeenCalled();
    expect(counts).toMatchObject({ failures: 1, deletedRecords: 0 });
  });

  test('a username with no record is counted, and giving no selection or both is an error', async () => {
    const counts = await del.run(args({ usernames: ['ghost'] }), makeStoreFake(), () => {});
    expect(counts).toMatchObject({ records: 0, usernamesWithoutRecord: 1 });
    await expect(del.run(args({}), makeStoreFake(), () => {})).rejects.toThrow('not both and not neither');
    await expect(del.run(args({ usernames: ['a'], withoutConsent: true }), makeStoreFake(), () => {})).rejects.toThrow('not both');
  });

  test('parseArgs: --username, --usernames and a usernames file', () => {
    expect(del.parseArgs(['--username', 'Amy', '--usernames', 'ben,Cat']).usernames).toEqual(['amy', 'ben', 'cat']);
    const file = path.join(os.tmpdir(), `a2-del-${process.pid}.txt`);
    fs.writeFileSync(file, '# list\ndan\n\neve\n');
    expect(del.parseArgs(['--usernames-file', file]).usernames).toEqual(['dan', 'eve']);
    fs.rmSync(file);
    expect(() => del.parseArgs(['--nope'])).toThrow('unknown argument');
  });
});

describe('the driver builds without a function', () => {
  const driver = fs.readFileSync(path.join(__dirname, '../../../scripts/eval/a2/driver/main.cpp'), 'utf8');
  test('every function branch is guarded by its own macro', () => {
    ['A2_NO_REVERSELIST', 'A2_NO_SPLITSTRING', 'A2_NO_PLAYCRAPS', 'A2_NO_MODE'].forEach((m) => expect(driver).toContain(`#ifndef ${m}`));
  });

  // Needs a C++ compiler: run with GXX=/path/to/g++ (skipped when there is none).
  const gxx = process.env.GXX || 'g++';
  const env = { ...process.env, PATH: gxx.includes('/') || gxx.includes('\\') ? `${path.dirname(gxx)}${path.delimiter}${process.env.PATH}` : process.env.PATH };
  const hasCompiler = !spawnSync(gxx, ['--version'], { env }).error;
  (hasCompiler ? test : test.skip)('a header and code without mode compile and link when A2_NO_MODE is defined, and fail without it', () => {
    const header = OFFICIAL.replace('int mode(const vector<int>& vec);\n', '');
    const code = '#include "functions.h"\n#include <algorithm>\nvoid reverseList(vector<int>& v) { reverse(v.begin(), v.end()); }\nvector<string> splitString(string s, char d) { return {s}; }\nint playCraps(const vector<int>& r) { return 2; }\n';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-driver-'));
    const compile = (defines) => {
      const built = harness.buildProgram({ header: `${defines}${header}`, studentSource: code, driver });
      fs.writeFileSync(path.join(dir, 'a.cpp'), built.source);
      return spawnSync(gxx, ['-std=c++17', '-o', path.join(dir, process.platform === 'win32' ? 'a.exe' : 'a'), path.join(dir, 'a.cpp')], { encoding: 'utf8', env });
    };
    const without = compile('#define A2_NO_MODE 1\n');
    const withMode = compile('');
    fs.rmSync(dir, { recursive: true, force: true });
    expect(without.status).toBe(0);
    expect(withMode.status).not.toBe(0);
    expect(withMode.stderr).toContain("'mode' was not declared");
  });
});
