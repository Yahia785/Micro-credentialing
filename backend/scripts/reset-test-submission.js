#!/usr/bin/env node
/**
 * Reset one account's attempt at one HIDDEN problem on the dev backend, so the account can take the problem again.
 *
 * For one user and one problem it deletes:
 *   - the user's submission(s) of that problem (Submissions table),
 *   - every interview of those submissions, practice ones included, with all their turns (Interviews-dev table),
 *   - the problem's entry in the user's completedMilestones (Users table).
 *
 * It refuses unless the problem is hidden (isHidden): dev and production share the Milestones, Submissions and Users tables, so
 * this must never touch a problem students can see. It also refuses if a credential was already issued for the submission.
 * Recordings in S3 are not touched.
 *
 * Dry run by default. Nothing is deleted without --yes.
 *
 *   node scripts/reset-test-submission.js --user <userId | email> --problem <milestoneId>          (dry run)
 *   node scripts/reset-test-submission.js --user <userId | email> --problem <milestoneId> --yes    (delete)
 *
 * Options:
 *   --user <id|email>   the account (a user id, or an email that is looked up in the Users table; the email is never printed)
 *   --problem <id>      the milestone id of the hidden problem
 *   --profile <name>    AWS profile (default: the usual credential chain)
 *
 * Never prints code, answers, names or emails.
 */
const path = require('path');

// The dev setup: region and table names from backend/samconfig-dev.toml and template.yaml.
const DEV = Object.freeze({ region: 'us-east-1', users: 'Users', milestones: 'Milestones', submissions: 'Submissions', interviews: 'Interviews-dev' });

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => {
      i += 1;
      if (i >= argv.length || argv[i].startsWith('--')) throw new Error(`${a} needs a value`);
      return argv[i];
    };
    if (a === '--yes') args.yes = true;
    else if (a === '--user') args.user = value();
    else if (a === '--problem') args.problem = value();
    else if (a === '--profile') args.profile = value();
    else throw new Error(`Unknown option ${a}`);
  }
  if (!args.user || !args.problem) throw new Error('--user and --problem are required');
  return args;
}

/**
 * What would be deleted. Pure: takes what was read from the tables.
 * @throws when the reset is not allowed
 */
function planReset({ milestone, user, submissions, interviewsBySubmission }) {
  if (!milestone) throw new Error('That problem does not exist.');
  if (milestone.isHidden !== true) {
    throw new Error('Refusing: that problem is not hidden. This script only resets hidden problems, because dev and production share these tables.');
  }
  if (!user) throw new Error('That user does not exist.');
  const issued = submissions.filter((s) => s.credentialIssued === true);
  if (issued.length) {
    throw new Error('Refusing: a credential was already issued for this submission. Remove that credential by hand first.');
  }
  const entries = (user.completedMilestones || []).filter((m) => m.milestoneId === milestone.milestoneId);
  return {
    submissionIds: submissions.map((s) => s.submissionId),
    interviewIds: submissions.flatMap((s) => (interviewsBySubmission[s.submissionId] || []).map((i) => i.interviewId)),
    completedEntries: entries.length,
    remainingMilestones: (user.completedMilestones || []).filter((m) => m.milestoneId !== milestone.milestoneId),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.profile) process.env.AWS_PROFILE = args.profile;
  process.env.AWS_REGION = DEV.region;
  process.env.USERS_TABLE = DEV.users;
  process.env.MILESTONES_TABLE = DEV.milestones;
  process.env.SUBMISSIONS_TABLE = DEV.submissions;
  process.env.INTERVIEWS_TABLE = DEV.interviews;

  // The AWS SDK is installed with the shared layer, not next to this script.
  const sharedRequire = require('module').createRequire(path.join(__dirname, '../shared/nodejs/package.json'));
  const { DynamoDBClient } = sharedRequire('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, ScanCommand, QueryCommand, DeleteCommand } = sharedRequire('@aws-sdk/lib-dynamodb');
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: DEV.region }));

  const { getMilestone } = require('../shared/nodejs/db/milestones');
  const { getUser, updateUser } = require('../shared/nodejs/db/users');
  const { getUserSubmissionsForMilestone } = require('../shared/nodejs/db/submissions');
  const { listInterviewsBySubmission } = require('../shared/nodejs/db/interviews');

  // An email is looked up in the Users table; only the id is kept.
  let userId = args.user;
  if (args.user.includes('@')) {
    const wanted = [args.user, args.user.toLowerCase()];
    userId = null;
    let lastKey;
    do {
      const result = await doc.send(new ScanCommand({
        TableName: DEV.users,
        FilterExpression: 'email IN (:a, :b)',
        ExpressionAttributeValues: { ':a': wanted[0], ':b': wanted[1] },
        ProjectionExpression: 'userId',
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      if (result.Items && result.Items.length) { userId = result.Items[0].userId; break; }
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
    if (!userId) throw new Error('No user with that email was found in the Users table.');
  }

  const milestone = await getMilestone(args.problem);
  const user = await getUser(userId);
  const submissions = await getUserSubmissionsForMilestone(userId, args.problem, 100);
  // Also the one the profile points at, in case the index does not list it.
  const entry = user && (user.completedMilestones || []).find((m) => m.milestoneId === args.problem);
  if (entry && entry.submissionId && !submissions.some((s) => s.submissionId === entry.submissionId)) {
    submissions.push({ submissionId: entry.submissionId });
  }
  const interviewsBySubmission = {};
  for (const s of submissions) interviewsBySubmission[s.submissionId] = await listInterviewsBySubmission(s.submissionId);

  const plan = planReset({ milestone, user, submissions, interviewsBySubmission });

  console.log(args.yes ? 'DELETING from the dev tables' : 'DRY RUN: nothing is deleted (add --yes to delete)');
  console.log(`Problem:       ${milestone.title} (${milestone.milestoneId}, hidden)`);
  console.log(`User:          ${userId}`);
  console.log(`Submissions:   ${plan.submissionIds.length ? plan.submissionIds.join(', ') : 'none'}`);
  console.log(`Interviews:    ${plan.interviewIds.length ? plan.interviewIds.join(', ') : 'none'} (with all their turns)`);
  console.log(`Completed entry in the profile: ${plan.completedEntries ? 'yes, will be removed' : 'none'}`);
  if (!plan.submissionIds.length && !plan.interviewIds.length && !plan.completedEntries) {
    console.log('\nNothing to reset.');
    return;
  }
  if (!args.yes) return;

  let deletedItems = 0;
  for (const interviewId of plan.interviewIds) {
    let lastKey;
    do {
      const page = await doc.send(new QueryCommand({
        TableName: DEV.interviews,
        KeyConditionExpression: 'interviewId = :id',
        ExpressionAttributeValues: { ':id': interviewId },
        ProjectionExpression: 'interviewId, sk',
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      for (const item of page.Items || []) {
        await doc.send(new DeleteCommand({ TableName: DEV.interviews, Key: { interviewId: item.interviewId, sk: item.sk } }));
        deletedItems += 1;
      }
      lastKey = page.LastEvaluatedKey;
    } while (lastKey);
  }
  for (const submissionId of plan.submissionIds) {
    await doc.send(new DeleteCommand({ TableName: DEV.submissions, Key: { submissionId } }));
  }
  if (plan.completedEntries) {
    await updateUser(userId, { completedMilestones: plan.remainingMilestones });
  }
  console.log(`\nDeleted ${plan.submissionIds.length} submission(s), ${plan.interviewIds.length} interview(s) (${deletedItems} items), ${plan.completedEntries} profile entry.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, planReset, DEV };
