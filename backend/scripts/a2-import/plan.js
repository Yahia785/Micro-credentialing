#!/usr/bin/env node
// Builds every student's interview plan (M4a) and a review file to read.
//
//   node scripts/a2-import/plan.js                                  records from the dry-run folder, code from the local repos, plans local only
//   node scripts/a2-import/plan.js --env dev                        records from the ImportedSubmissions-dev table, code from S3; also writes
//                                                                   the plan to each record as a new field "plan" (nothing else is changed)
//
// --records     folder of dry-run record JSON files (default D:/a2-pilot-test/out)
// --repos       folder of the fake/real repositories the records came from (local mode; default D:/a2-pilot-test/repos)
// --out         where plans and plan-review.md go (default D:/a2-pilot-test/plans). Never inside the repo.
// --overrides   JSON keyed by GitHub username: { "user": { "reverseList": { "pauseLine": 7, "variables": [{ "name": "left number", "expr": "vec[left]" }],
//               "k": 2 } } }   (default <out>/overrides.json, optional)
// --only        build the plan of one GitHub username only
// --refresh-reference   compute the reference answers again (they are saved in <out>/reference.json)
//
// Needs Docker (gcc:13, --network none): the student's code runs only there.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dockerAvailable, makeDocker } = require('./lib/docker');
const git = require('./lib/git');
const { makeStore } = require('./lib/store');
const { tableFor, DEFAULT_BUCKET, DEFAULT_REGION, normalizeUsername } = require('./lib/common');
const { assignForms, PLANNABLE } = require('./lib/plan-rules');
const { buildPlan } = require('./lib/plan-build');
const { computeReference } = require('./lib/reference');
const { renderReview } = require('./lib/plan-review');
const { outcomeFor, summaryLines } = require('./lib/plan-report');

const A2 = path.join(__dirname, '..', 'eval', 'a2');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const BASE = process.platform === 'win32' ? 'D:/a2-pilot-test' : path.join(os.tmpdir(), 'a2-pilot-test');
const insideRepo = (p) => { const rel = path.relative(REPO_ROOT, path.resolve(p)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

function parseArgs(argv) {
  const args = { records: `${BASE}/out`, repos: `${BASE}/repos`, out: `${BASE}/plans`, region: DEFAULT_REGION, bucket: DEFAULT_BUCKET };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--refresh-reference') args.refreshReference = true;
    else if (['--records', '--repos', '--out', '--overrides', '--only', '--env', '--table', '--bucket', '--region'].includes(a)) { args[a.slice(2)] = argv[i + 1]; i += 1; } else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

/** The plan as it is stored in the table: no line text (a line of the student's code) outside the question texts. */
function planForRecord(plan) {
  return JSON.parse(JSON.stringify(plan, (key, value) => (key === 'lineText' ? undefined : value)));
}

async function loadRecords(args, store) {
  if (store) return (await store.scanAll()).map((record) => ({ record }));
  return fs.readdirSync(args.records).filter((f) => f.endsWith('.json')).map((f) => {
    const parsed = JSON.parse(fs.readFileSync(path.join(args.records, f), 'utf8'));
    return { record: parsed.record || parsed };
  });
}

/** The student's two files: from S3 (store) or from the local repository at the recorded commit. */
async function loadFiles(record, args, store) {
  if (!record.s3Keys) return null;
  if (store) return { header: await store.getFile(record.s3Keys.header), code: await store.getFile(record.s3Keys.source) };
  const gitDir = path.join(args.repos, `assignment-02-${record.githubUsername}`);
  return { header: git.showFile(gitDir, record.commitHash, 'functions.h'), code: git.showFile(gitDir, record.commitHash, 'functions.cpp') };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (insideRepo(args.out) || insideRepo(args.records) || insideRepo(args.repos)) throw new Error('plans, records and repositories must be outside the repo folder (the repo is public)');
  if (!dockerAvailable()) { console.error('Docker is not running. Start Docker Desktop and run this again.'); process.exit(2); }
  const store = args.env ? makeStore({ table: args.table || tableFor(args.env), bucket: args.bucket, region: args.region }) : null;
  const questions = JSON.parse(fs.readFileSync(path.join(A2, 'questions.json'), 'utf8'));
  const assets = { questions, officialHeader: fs.readFileSync(path.join(A2, 'reference', 'functions.h'), 'utf8'), driver: fs.readFileSync(path.join(A2, 'driver', 'main.cpp'), 'utf8') };
  fs.mkdirSync(args.out, { recursive: true });

  // reference answers, computed once and saved with the plans
  const refPath = path.join(args.out, 'reference.json');
  let reference;
  if (!args.refreshReference && fs.existsSync(refPath)) reference = JSON.parse(fs.readFileSync(refPath, 'utf8'));
  else {
    const docker = makeDocker();
    try { reference = await computeReference({ docker, questions }); } finally { docker.cleanup(); }
    fs.writeFileSync(refPath, JSON.stringify(reference, null, 2));
    console.log(`reference answers computed: ${refPath}`);
  }

  const overridesPath = args.overrides || path.join(args.out, 'overrides.json');
  const overridesAll = fs.existsSync(overridesPath) ? Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(overridesPath, 'utf8'))).map(([u, v]) => [normalizeUsername(u), v])) : {};
  if (Object.keys(overridesAll).length) console.log(`overrides for ${Object.keys(overridesAll).length} students from ${overridesPath}`);

  let loaded = await loadRecords(args, store);
  const everyone = loaded.map((l) => l.record);
  const forms = assignForms(everyone); // forms are assigned over everyone, so --only does not change them
  const outcomes = [];
  if (args.only) {
    const wanted = normalizeUsername(args.only);
    everyone.filter((r) => r.githubUsername !== wanted).forEach((r) => outcomes.push(outcomeFor(r, null, { selected: false })));
    loaded = loaded.filter((l) => l.record.githubUsername === wanted);
    if (loaded.length === 0) console.log(`No record for "${wanted}" among the ${everyone.length} records read.`);
  }
  console.log(`${everyone.length} records read${store ? ` from ${store.table}` : ''}`);
  loaded.sort((a, b) => (a.record.importId < b.record.importId ? -1 : 1));

  const plans = [];
  const records = {};
  for (const { record } of loaded) {
    records[record.importId] = record;
    const prefix = `  ${record.githubUsername} (${record.status}) ... `;
    let plan;
    if (!PLANNABLE.has(record.status)) plan = { version: 1, importId: record.importId, githubUsername: record.githubUsername, status: record.status, noPlan: `status ${record.status}: there is no code to ask about`, questions: [], notes: [], log: [] };
    else {
      const files = await loadFiles(record, args, store);
      if (!files || files.code === null) throw new Error(`${record.githubUsername}: the code could not be read`);
      const docker = makeDocker();
      try {
        plan = await buildPlan({ record, code: files.code, studentHeader: files.header, form: forms.get(record.importId), assets, reference, docker, overrides: overridesAll[record.githubUsername] || {} });
      } finally { docker.cleanup(); }
    }
    fs.writeFileSync(path.join(args.out, `${record.importId}.json`), JSON.stringify(plan, null, 2));
    const written = Boolean(store && !plan.noPlan);
    if (written) await store.setPlan(record.importId, planForRecord(plan));
    plans.push(plan);
    outcomes.push(outcomeFor(record, plan, { written }));
    console.log(prefix + (plan.noPlan ? `NO PLAN: ${plan.noPlan}` : `form ${plan.form}, ${plan.questions.length} questions${written ? ', plan written' : ''}${plan.log.length ? `, ${plan.log.length} log lines` : ''}`));
  }
  plans.sort((a, b) => (a.githubUsername < b.githubUsername ? -1 : 1));
  fs.writeFileSync(path.join(args.out, 'plan-review.md'), renderReview(plans, { records }));
  console.log(`\n${summaryLines(everyone, outcomes).join('\n')}`);
  console.log(`\nplans and plan-review.md in ${args.out}${store ? `; plan written to the ${args.env} records` : ' (local only)'}`);
}

module.exports = { parseArgs, planForRecord };

if (require.main === module) main().catch((error) => { console.error(error.message); process.exit(1); });
