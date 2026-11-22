#!/usr/bin/env node
// Imports Assignment 02 submissions (GitHub Classroom repositories) for the interview pilot.
//
//   node scripts/a2-import/import.js --repos D:/a2-pilot-test/repos --deadline 2026-03-01T23:59:00Z --roster D:/a2-pilot-test/roster.csv --dry-run
//   node scripts/a2-import/import.js --repos D:/a2-pilot-test/repos --deadline 2026-03-01T23:59:00Z --roster D:/a2-pilot-test/roster.csv --env dev
//
// --repos      a folder with repository folders, one repository folder, a comma list of clone URLs, or a text file with one per line
// --deadline   ISO date-time; the version imported is the last commit with a committer date before it
// --roster     GitHub Classroom assignment export (CSV); only github_username and roster_identifier are read
// --dry-run    does everything except S3 and the table; writes the records as JSON to --out (default D:/a2-pilot-test/out, never inside the repo)
// --env        dev (default) or production: the table is ImportedSubmissions-<env>; --table, --bucket, --region override
//
// Needs Docker (image gcc:13, run with --network none) for the compiler and the sanitizer runs. Real runs need AWS credentials with
// s3:PutObject on the bucket under a2-pilot/ and dynamodb:PutItem / Query on the table (your own credentials, not a Lambda's).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dockerAvailable, makeDocker } = require('./lib/docker');
const git = require('./lib/git');
const { parseRoster } = require('./lib/roster');
const { importRepo, excludedSummary } = require('./lib/import-repo');
const { makeStore } = require('./lib/store');
const { FUNCTIONS, DEFAULT_BUCKET, DEFAULT_REGION, tableFor, normalizeUsername } = require('./lib/common');
const { parseDeadline } = require('./lib/pick');

const A2 = path.join(__dirname, '..', 'eval', 'a2');

function parseArgs(argv) {
  const args = { env: 'dev', region: DEFAULT_REGION, bucket: DEFAULT_BUCKET, out: process.platform === 'win32' ? 'D:/a2-pilot-test/out' : path.join(os.tmpdir(), 'a2-pilot-test', 'out') };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (['--repos', '--deadline', '--roster', '--out', '--env', '--table', '--bucket', '--region', '--questions'].includes(a)) { args[a.slice(2)] = argv[i + 1]; i += 1; } else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

/** The candidate inputs of every function from questions.json (the reference's answers are in "spec"). */
function loadAssets(questionsPath) {
  const questions = JSON.parse(fs.readFileSync(questionsPath || path.join(A2, 'questions.json'), 'utf8'));
  const inputs = [];
  for (const fn of FUNCTIONS) {
    const f = questions.functions[fn];
    for (const input of [...f.standardInputs, ...f.targetInputs]) {
      if (!inputs.some((x) => x.cmd === input.cmd)) inputs.push({ function: fn, cmd: input.cmd, spec: input.spec, unclearSpec: Boolean(input.unclearSpec) });
    }
  }
  return {
    officialHeader: fs.readFileSync(path.join(A2, 'reference', 'functions.h'), 'utf8'),
    driver: fs.readFileSync(path.join(A2, 'driver', 'main.cpp'), 'utf8'),
    inputs,
  };
}

const mark = (r, fn) => {
  const f = r.functions && r.functions[fn];
  if (!f) return '?';
  if (f.compilesAlone !== undefined) return f.compilesAlone ? 'yes' : 'NO'; // the file was split: compiles on its own
  return f.present === null ? '?' : f.present ? 'yes' : 'NO';
};

/** First compiler error of every function that does not compile alone: "splitString: line 24: expected ';'". */
const errorsOf = (r) => (r.outsideFunctionsError ? [`outside the functions: line ${r.outsideFunctionsError.line}: ${r.outsideFunctionsError.message}`] : []).concat(FUNCTIONS.filter((fn) => r.functions && r.functions[fn] && r.functions[fn].firstError).map((fn) => {
  const e = r.functions[fn].firstError;
  return `${fn}: ${e.line ? `line ${e.line}: ` : ''}${e.message}${r.functions[fn].brokenHelpers ? ` (calls broken helper ${r.functions[fn].brokenHelpers.join(', ')})` : ''}`;
}));

function summaryTable(rows) {
  const lines = [];
  lines.push(['repo user', 'status', 'commit', 'header', 'functions (R S P M)', 'mode needed', 'first error per broken function', 'inputs excluded'].join(' | '));
  for (const { record, excluded, skipped } of rows) {
    lines.push([
      record.githubUsername,
      record.status + (skipped ? ` (${skipped})` : ''),
      record.commitHash ? `${record.commitHash.slice(0, 7)} ${record.commitDate}` : '-',
      record.headerUsed || '-',
      FUNCTIONS.map((fn) => mark(record, fn)).join(' '),
      record.modeNeeded === null ? '-' : record.modeNeeded ? 'yes' : 'no',
      errorsOf(record).length ? errorsOf(record).join('; ') : '-',
      excluded.length ? excluded.join('; ') : '-',
    ].join(' | '));
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.repos || !args.deadline) throw new Error('--repos and --deadline are required');
  if (parseDeadline(args.deadline) === null) throw new Error(`--deadline is not a date: ${args.deadline}`);
  if (!dockerAvailable()) { console.error('Docker is not running. Start Docker Desktop and run this again.'); process.exit(2); }

  const roster = args.roster ? parseRoster(fs.readFileSync(args.roster, 'utf8')) : new Map();
  const repos = git.resolveRepos(args.repos);
  if (repos.length === 0) throw new Error(`no repositories found in ${args.repos}`);
  const assets = loadAssets(args.questions);
  const store = args.dryRun ? null : makeStore({ table: args.table || tableFor(args.env), bucket: args.bucket, region: args.region });
  if (args.dryRun) fs.mkdirSync(args.out, { recursive: true });
  console.log(`${args.dryRun ? 'DRY RUN: nothing goes to S3 or the table. ' : `Writing to s3://${args.bucket}/a2-pilot/ and ${args.table || tableFor(args.env)}. `}${repos.length} repositories, deadline ${args.deadline}`);

  const rows = [];
  for (const repo of repos) {
    const username = normalizeUsername(git.usernameFromRepoName(repo.name));
    const entry = roster.get(username);
    process.stdout.write(`  ${username} ... `);
    try {
      const result = await importRepo({ repo, username, rosterIdentifier: entry ? entry.rosterIdentifier : null, deadlineIso: args.deadline, assets, dryRun: Boolean(args.dryRun) }, { git, makeDocker, store });
      if (args.dryRun) fs.writeFileSync(path.join(args.out, `${result.record.importId}.json`), JSON.stringify({ dryRun: true, record: result.record }, null, 2));
      rows.push({ ...result, excluded: excludedSummary(result.record) });
      console.log(result.record.status);
    } catch (error) {
      console.log(`FAILED: ${error.message}`);
      rows.push({ record: { githubUsername: username, status: 'import_failed', functions: null, inputs: [], modeNeeded: null }, excluded: [error.message.slice(0, 120)] });
    }
  }
  console.log(`\n${summaryTable(rows)}\n`);
  if (args.dryRun) console.log(`Records written to ${args.out}`);
}

module.exports = { parseArgs, loadAssets, summaryTable };

if (require.main === module) main().catch((error) => { console.error(error.message); process.exit(1); });
