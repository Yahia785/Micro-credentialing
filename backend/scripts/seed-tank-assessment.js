#!/usr/bin/env node
/**
 * Seed the tank fill controller (eval case 4) as a new HIDDEN C++ coding problem on the dev backend.
 *
 * It stores the problem the way the admin create form does: createMilestone (the same db function the POST /milestones
 * handler calls, with the form's defaults), then createTestCasesBatch for the tests (the same call the batch-create
 * handler makes: one record per test, order = position, includeInJudge0 true, weight 1, tier standard), then the
 * milestone's testCaseCount. The only difference is that the milestone is hidden from the start (isHidden, previewUserIds),
 * because dev and production share the Milestones and TestCases tables: it must never be visible to a student, even for a moment.
 *
 * Dry run by default. Nothing is written without --yes.
 *
 *   node scripts/seed-tank-assessment.js --preview-user <userId | email>          (dry run)
 *   node scripts/seed-tank-assessment.js --preview-user <userId | email> --yes    (write, prints the new milestone id)
 *
 * Options:
 *   --preview-user <id|email>  the user who may see, open and submit the hidden problem (a user id, or an email that is looked up in
 *                              the Users table; only the id is ever printed). Repeat the option for more than one user.
 *   --course <label>           course label (default "ECE 2514")
 *   --hidden-tests <T1,T3>     tests to hide from students (default: none, see tank-controller.tests.json)
 *   --allow-duplicate          create it even if a problem with the same title already exists
 *   --prompt <host.vN>         the Host prompt version of the interview (default host.v5; host.v6 adds the run results, the unfinished-code
 *                              and the manipulation handling). The interview config always carries the runs for Q1 and Q3 of the tank.
 *   --update                   the problem already exists: change only its interview setup (prompt version, runs, rubric) and nothing else.
 *                              Interviews that already started keep the version they started with.
 *   --profile <name>           AWS profile (default: the usual credential chain)
 *
 * Needs AWS credentials for the dev account with access to the Users (only with an email), Milestones and TestCases tables.
 * Never prints prompts, answers, code of students, names or emails.
 */
const fs = require('fs');
const path = require('path');

// The dev setup: region and table names from backend/samconfig-dev.toml and template.yaml (the Milestones, TestCases and Users
// tables are shared by dev and production).
const DEV = Object.freeze({ region: 'us-east-1', milestones: 'Milestones', testCases: 'TestCases', users: 'Users' });

const CASES = path.join(__dirname, 'eval', 'cases');
const DESIGN_FILE = path.join(CASES, 'case4-tank-controller.md');
const CONFIG_FILE = path.join(CASES, 'tank-controller.json');
const TESTS_FILE = path.join(CASES, 'tank-controller.tests.json');

const TITLE = 'Tank Fill Controller (state machine)';
const CONCEPT = 'State machines: enum class, struct, functions, switch/if, loops';
const DEFAULT_COURSE = 'ECE 2514';
const PROMPT_VERSION = 'host.v5'; // the default; --prompt chooses another

/** The text between a heading and the next rule, from the design file. */
function section(markdown, heading) {
  const start = markdown.indexOf(heading);
  if (start === -1) throw new Error(`The design file has no "${heading}" section`);
  const after = markdown.slice(start + heading.length);
  const end = after.indexOf('\n---');
  return (end === -1 ? after : after.slice(0, end)).trim();
}

/**
 * The statement is shown as plain text (the problem page keeps line breaks but does not render Markdown), so the Markdown
 * marks of the design file are removed: bold, code ticks and the fence around the example output.
 */
function toPlainText(markdown) {
  return markdown
    .replace(/```[a-z]*\n([\s\S]*?)```/g, (_m, body) => body.replace(/\s+$/, ''))
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The student-facing statement and the starter code, taken from the design file (section 1 and 2). */
function readStatementAndStarter(file = DESIGN_FILE) {
  const markdown = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const statement = toPlainText(section(markdown, '## 1. Problem statement (what students see)'));
  const starterSection = section(markdown, '## 2. Starter code (provided to students)');
  const fence = starterSection.match(/```cpp\n([\s\S]*?)```/);
  if (!fence) throw new Error('The design file has no C++ starter code in section 2');
  return { statement, starterCode: fence[1].replace(/\s+$/, '') + '\n' };
}

function readTests(file = TESTS_FILE, hiddenIds = []) {
  const { tests } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const unknown = hiddenIds.filter((id) => !tests.some((t) => t.id === id));
  if (unknown.length) throw new Error(`--hidden-tests names unknown tests: ${unknown.join(', ')}`);
  return tests.map((t, index) => ({
    // Same shape the batch-create handler stores.
    input: t.input,
    expectedOutput: t.expected.join('\n'),
    isHidden: t.isHidden === true || hiddenIds.includes(t.id),
    includeInJudge0: true,
    weight: 1,
    order: index,
    testTier: 'standard',
    // For the printout only; not stored.
    _id: t.id,
    _checks: t.checks,
  }));
}

/** The interview setup: the eval case's config, with the rubric and the runs kept, 10 minutes, one follow-up per main question. */
function buildInterview(file = CONFIG_FILE, promptVersion = PROMPT_VERSION) {
  const { parseInterview } = require('../shared/nodejs/utils/interview-config');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const parsed = parseInterview(
    { ...raw, enabled: true, promptVersion, timeLimitMinutes: 10, maxFollowUpsPerMainQuestion: 1 },
    { language: 'cpp' }
  );
  if (parsed.error) throw new Error(`Interview config is not valid: ${parsed.error}`);
  return parsed.value;
}

/**
 * Everything that will be written, with no AWS access.
 * @param {{ previewUserIds?: string[], course?: string, hiddenTests?: string[], promptVersion?: string }} options
 */
function buildPlan({ previewUserIds = [], course = DEFAULT_COURSE, hiddenTests = [], promptVersion = PROMPT_VERSION } = {}) {
  const { statement, starterCode } = readStatementAndStarter();
  const milestone = {
    // The fields the admin create form sends, with its defaults (difficulty medium, 5000 ms, 256000 KB).
    title: TITLE,
    description: statement,
    concept: CONCEPT,
    difficulty: 'medium',
    language: 'cpp',
    starterCode,
    timeLimit: 5000,
    memoryLimit: 256000,
    course: course || undefined,
    interview: buildInterview(CONFIG_FILE, promptVersion),
    // Hidden from the first write: dev and production share these tables.
    isHidden: true,
    previewUserIds: [...new Set(previewUserIds)],
  };
  return { milestone, testCases: readTests(TESTS_FILE, hiddenTests) };
}

// ---------------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { previewUsers: [], hiddenTests: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => {
      i += 1;
      if (i >= argv.length || argv[i].startsWith('--')) throw new Error(`${a} needs a value`);
      return argv[i];
    };
    if (a === '--yes') args.yes = true;
    else if (a === '--allow-duplicate') args.allowDuplicate = true;
    else if (a === '--update') args.update = true;
    else if (a === '--prompt') args.prompt = value();
    else if (a === '--preview-user') args.previewUsers.push(value());
    else if (a === '--course') args.course = value();
    else if (a === '--profile') args.profile = value();
    else if (a === '--hidden-tests') args.hiddenTests = value().split(',').map((s) => s.trim()).filter(Boolean);
    else throw new Error(`Unknown option ${a}`);
  }
  return args;
}

/** Turn what was given to --preview-user into user ids: an email is looked up in the Users table, anything else is taken as the id. */
async function resolveUsers(values, lookupByEmail) {
  const ids = [];
  for (const value of values) {
    if (!value.includes('@')) {
      ids.push(value);
      continue;
    }
    const id = await lookupByEmail(value);
    if (!id) throw new Error('No user with that email was found in the Users table');
    ids.push(id);
  }
  return [...new Set(ids)];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.profile) process.env.AWS_PROFILE = args.profile;
  process.env.AWS_REGION = DEV.region;
  process.env.MILESTONES_TABLE = DEV.milestones;
  process.env.TESTCASES_TABLE = DEV.testCases;
  process.env.USERS_TABLE = DEV.users;

  // The AWS SDK is installed with the shared layer, not next to this script.
  const sharedRequire = require('module').createRequire(path.join(__dirname, '../shared/nodejs/package.json'));
  const { DynamoDBClient } = sharedRequire('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, ScanCommand } = sharedRequire('@aws-sdk/lib-dynamodb');
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: DEV.region }));

  const lookupByEmail = async (email) => {
    const wanted = [email, email.toLowerCase()];
    let lastKey;
    do {
      const result = await doc.send(new ScanCommand({
        TableName: DEV.users,
        FilterExpression: 'email IN (:a, :b)',
        ExpressionAttributeValues: { ':a': wanted[0], ':b': wanted[1] },
        ProjectionExpression: 'userId',
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      if (result.Items && result.Items.length) return result.Items[0].userId; // only the id leaves this function
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
    return null;
  };

  const previewUserIds = await resolveUsers(args.previewUsers, lookupByEmail);
  const plan = buildPlan({ previewUserIds, course: args.course, hiddenTests: args.hiddenTests, ...(args.prompt && { promptVersion: args.prompt }) });
  const { milestone, testCases } = plan;

  console.log(args.yes ? 'WRITING to the dev tables' : 'DRY RUN: nothing is written (add --yes to write)');
  console.log(`Region ${DEV.region}; tables ${DEV.milestones}, ${DEV.testCases} (shared with production, so the problem stays hidden)`);
  console.log(`\nTitle:       ${milestone.title}`);
  console.log(`Course:      ${milestone.course || '(none)'}`);
  console.log(`Language:    ${milestone.language}   difficulty ${milestone.difficulty}   time ${milestone.timeLimit} ms   memory ${milestone.memoryLimit} KB`);
  console.log(`Hidden:      ${milestone.isHidden}   preview users: ${previewUserIds.length ? previewUserIds.join(', ') : '(none: admins only)'}`);
  const itv = milestone.interview;
  const runCount = itv.themes.reduce((n, theme) => n + (theme.runs || []).reduce((m, list) => m + list.length, 0), 0);
  console.log(`Interview:   enabled, ${itv.promptVersion}, ${itv.timeLimitMinutes} min, ${itv.maxFollowUpsPerMainQuestion} follow-up per main question, ${itv.themes.length} main questions with rubrics, ${runCount} code runs`);
  console.log(`Tests:       ${testCases.map((t) => `${t._id}${t.isHidden ? ' (hidden)' : ''}`).join(', ')}`);
  console.log('\n----- Statement (what students see) -----\n' + milestone.description);
  console.log('\n----- Starter code -----\n' + milestone.starterCode);

  if (!previewUserIds.length) console.log('Note: no --preview-user given. Only admins will be able to see this problem.\n');

  const { getAllMilestones, createMilestone, updateMilestone, deleteMilestoneWithCleanup } = require('../shared/nodejs/db/milestones');
  const { createTestCasesBatch } = require('../shared/nodejs/db/testcases');

  const existing = (await getAllMilestones()).find((m) => m.title === milestone.title);
  if (args.update) {
    if (!existing) throw new Error(`--update: no problem titled "${milestone.title}" exists`);
    console.log(`\nUpdating the interview setup of ${existing.milestoneId} (${itv.promptVersion}); nothing else changes.`);
    if (args.yes) {
      await updateMilestone(existing.milestoneId, { interview: milestone.interview });
      console.log('Updated.');
    }
    return;
  }
  if (!args.allowDuplicate) {
    if (existing) {
      throw new Error(`A problem titled "${milestone.title}" already exists (${existing.milestoneId}). Use --allow-duplicate to create another.`);
    }
  }
  if (!args.yes) return;

  const created = await createMilestone(milestone);
  const milestoneId = created.milestoneId;
  try {
    const stored = testCases.map(({ _id, _checks, ...record }) => ({ ...record, milestoneId }));
    const made = await createTestCasesBatch(stored);
    await updateMilestone(milestoneId, { testCaseCount: made.length });
  } catch (error) {
    console.error(`Writing the tests failed (${error.name}). Removing the new problem ${milestoneId}.`);
    await deleteMilestoneWithCleanup(milestoneId);
    throw error;
  }
  console.log(`\nCreated hidden problem. milestoneId: ${milestoneId}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { buildPlan, parseArgs, resolveUsers, readStatementAndStarter, readTests, buildInterview, toPlainText, DEV, TITLE };
