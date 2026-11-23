#!/usr/bin/env node
/**
 * Seed the "Code Interview" assessment (the interview-only assessment of the A2 pilot) on the dev backend.
 *
 * It is a HIDDEN C++ assessment with an interview-only setup: no code is submitted, the questions come from each imported student's plan
 * (see backend/scripts/a2-import/plan.js and shared/nodejs/services/a2-interview.js). Its title and description are neutral and do not
 * name the assignment. It is created the way seed-tank-assessment.js creates the tank problem (createMilestone, hidden from the first
 * write, because dev and production share the Milestones table). The users who may see it are the preview users of the tank problem
 * (milestone_cceb891e-decc-47ce-8e9e-97aa9f62cbe8), read from that milestone; admins always see it.
 *
 *   node scripts/seed-a2-assessment.js --dry-run     print what would be written, write nothing
 *   node scripts/seed-a2-assessment.js               create it (prints the new milestone id)
 *   node scripts/seed-a2-assessment.js --update      it exists: change only its interview setup, description and preview users
 *
 * Options:
 *   --dry-run                  print and write nothing (also with --update)
 *   --update                   the assessment exists: change only its interview setup, its description and its preview users
 *   --allow-duplicate          create it even if an assessment with the same title exists
 *   --preview-from <id>        the milestone whose previewUserIds are copied (default the tank problem)
 *   --course <label>           course label (default "ECE 2514")
 *   --profile <name>           AWS profile (default: the usual credential chain)
 *
 * Needs AWS credentials for the dev account with access to the Milestones table. Prints no names, emails or student data.
 */
const DEV = Object.freeze({ region: 'us-east-1', milestones: 'Milestones' });
const TANK_MILESTONE_ID = 'milestone_cceb891e-decc-47ce-8e9e-97aa9f62cbe8';
const TITLE = 'Code Interview';
const DEFAULT_COURSE = 'ECE 2514';
const DESCRIPTION = [
  'A short oral interview about code you wrote.',
  '',
  'You will be asked a few questions about your own code, one at a time, in a chat. Your code is shown next to the conversation.',
  'Answer in your own words. You have 20 minutes.',
].join('\n');
const SOURCE = 'a2-pilot';
const TIME_LIMIT_MINUTES = 20;
const PROMPT_VERSION = 'host.a2';

/** The interview setup: interview-only, source a2-pilot, 20 minutes, one follow-up per question, the prompt version of the A2 flow. */
function buildInterview() {
  const { parseInterview } = require('../shared/nodejs/utils/interview-config');
  const parsed = parseInterview(
    { enabled: true, interviewOnly: true, source: SOURCE, timeLimitMinutes: TIME_LIMIT_MINUTES, maxFollowUpsPerMainQuestion: 1, promptVersion: PROMPT_VERSION, themes: [] },
    { language: 'cpp' }
  );
  if (parsed.error) throw new Error(`Interview config is not valid: ${parsed.error}`);
  return parsed.value;
}

/** Everything that will be written, with no AWS access. */
function buildPlan({ previewUserIds = [], course = DEFAULT_COURSE } = {}) {
  return {
    milestone: {
      title: TITLE,
      description: DESCRIPTION,
      concept: 'Code interview',
      difficulty: 'medium',
      language: 'cpp',
      starterCode: '',
      timeLimit: 5000,
      memoryLimit: 256000,
      course: course || undefined,
      interview: buildInterview(),
      // Hidden from the first write: dev and production share this table.
      isHidden: true,
      previewUserIds: [...new Set(previewUserIds)],
    },
  };
}

/** What --update would change on the stored assessment. */
function updateChanges(existing, milestone) {
  const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  return {
    description: (existing.description || '') !== milestone.description,
    interview: !same(existing.interview, milestone.interview),
    previewUserIds: !same([...(existing.previewUserIds || [])].sort(), [...(milestone.previewUserIds || [])].sort()),
  };
}

function parseArgs(argv) {
  const args = { previewFrom: TANK_MILESTONE_ID };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => {
      i += 1;
      if (i >= argv.length || argv[i].startsWith('--')) throw new Error(`${a} needs a value`);
      return argv[i];
    };
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--update') args.update = true;
    else if (a === '--allow-duplicate') args.allowDuplicate = true;
    else if (a === '--preview-from') args.previewFrom = value();
    else if (a === '--course') args.course = value();
    else if (a === '--profile') args.profile = value();
    else throw new Error(`Unknown option ${a}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.profile) process.env.AWS_PROFILE = args.profile;
  process.env.AWS_REGION = DEV.region;
  process.env.MILESTONES_TABLE = DEV.milestones;

  const { getAllMilestones, getMilestone, createMilestone, updateMilestone } = require('../shared/nodejs/db/milestones');

  const tank = await getMilestone(args.previewFrom);
  if (!tank) throw new Error(`The milestone ${args.previewFrom} (the preview list is read from it) was not found`);
  const previewUserIds = Array.isArray(tank.previewUserIds) ? tank.previewUserIds : [];

  const { milestone } = buildPlan({ previewUserIds, course: args.course });
  const itv = milestone.interview;
  const write = args.dryRun !== true;
  console.log(write ? 'WRITING to the dev tables' : 'DRY RUN: nothing is written');
  console.log(`Region ${DEV.region}; table ${DEV.milestones} (shared with production, so the assessment stays hidden)`);
  console.log(`\nTitle:       ${milestone.title}`);
  console.log(`Course:      ${milestone.course || '(none)'}`);
  console.log(`Language:    ${milestone.language}`);
  console.log(`Hidden:      ${milestone.isHidden}   preview users: ${previewUserIds.length} (copied from ${args.previewFrom}; admins always see it)`);
  console.log(`Interview:   interviewOnly ${itv.interviewOnly}, source ${itv.source}, ${itv.promptVersion}, ${itv.timeLimitMinutes} min, ${itv.maxFollowUpsPerMainQuestion} follow-up per question`);
  console.log(`\n----- Description -----\n${milestone.description}\n`);

  const existing = (await getAllMilestones()).find((m) => m.title === milestone.title);
  if (args.update) {
    if (!existing) throw new Error(`--update: no assessment titled "${milestone.title}" exists`);
    const changes = updateChanges(existing, milestone);
    console.log(`Updating ${existing.milestoneId}: the interview setup, the description and the preview users. Everything else stays.`);
    Object.entries(changes).forEach(([field, changed]) => console.log(`  ${field}: ${changed ? 'changes' : 'already the same'}`));
    if (write) {
      await updateMilestone(existing.milestoneId, { interview: milestone.interview, description: milestone.description, previewUserIds: milestone.previewUserIds });
      console.log('Updated.');
    }
    return;
  }
  if (existing && !args.allowDuplicate) {
    throw new Error(`An assessment titled "${milestone.title}" already exists (${existing.milestoneId}). Use --update to change it or --allow-duplicate to create another.`);
  }
  if (!write) return;
  const created = await createMilestone(milestone);
  console.log(`Created hidden assessment. milestoneId: ${created.milestoneId}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { buildPlan, buildInterview, updateChanges, parseArgs, DEV, TITLE, DESCRIPTION, TANK_MILESTONE_ID, SOURCE, TIME_LIMIT_MINUTES, PROMPT_VERSION };
