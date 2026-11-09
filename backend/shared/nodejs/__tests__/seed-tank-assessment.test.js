// The seed script's plan (no AWS access): what would be written for the hidden tank fill controller problem.
const fs = require('fs');
const path = require('path');
const { buildPlan, parseArgs, resolveUsers, readStatementAndStarter, DEV, TITLE } = require('../../../scripts/seed-tank-assessment');
const { parseInterview } = require('../utils/interview-config');

const CASES = path.join(__dirname, '../../../scripts/eval/cases');
const read = (f) => JSON.parse(fs.readFileSync(path.join(CASES, f), 'utf8'));

describe('buildPlan', () => {
  const { milestone, testCases } = buildPlan({ previewUserIds: ['u-1', 'u-1', 'u-2'] });

  it('is a hidden C++ problem with the preview users, and the create form\'s defaults', () => {
    expect(milestone).toMatchObject({
      title: TITLE, language: 'cpp', difficulty: 'medium', timeLimit: 5000, memoryLimit: 256000,
      isHidden: true, previewUserIds: ['u-1', 'u-2'],
    });
  });

  it('has the statement and the starter code of the design, as plain text and as code', () => {
    const { statement, starterCode } = readStatementAndStarter();
    expect(milestone.description).toBe(statement);
    expect(milestone.starterCode).toBe(starterCode);
    expect(statement).not.toMatch(/\*\*|`/);
    expect(statement).toContain('Pump starts: 2');
    expect(starterCode).toContain('TankState step(TankState current, double reading, const Settings& s)');
    expect(starterCode).toContain('// your code here');
    // The reference solution must not leak into what students see.
    expect(starterCode).not.toContain('return reading >= 0');
    expect(statement + starterCode).not.toContain('return current;');
  });

  it('stores the 7 tests of tank-controller.tests.json in the shape the batch-create handler uses', () => {
    const source = read('tank-controller.tests.json').tests;
    expect(testCases).toHaveLength(7);
    testCases.forEach((tc, i) => {
      expect(tc).toMatchObject({
        input: source[i].input,
        expectedOutput: source[i].expected.join('\n'),
        isHidden: false, includeInJudge0: true, weight: 1, order: i, testTier: 'standard',
      });
    });
  });

  it('can hide named tests from students, and refuses an unknown name', () => {
    const plan = buildPlan({ hiddenTests: ['T3', 'T7'] });
    expect(plan.testCases.filter((t) => t.isHidden).map((t) => t._id)).toEqual(['T3', 'T7']);
    expect(() => buildPlan({ hiddenTests: ['T9'] })).toThrow('unknown tests');
  });

  it('has the interview of tank-controller.json with the rubric, host.v5, 10 minutes and one follow-up', () => {
    const config = read('tank-controller.json');
    const itv = milestone.interview;
    expect(itv).toMatchObject({ enabled: true, promptVersion: 'host.v5', timeLimitMinutes: 10, maxFollowUpsPerMainQuestion: 1 });
    expect(itv.themes).toHaveLength(config.themes.length);
    itv.themes.forEach((theme, i) => {
      expect(theme.mainQuestions).toEqual(config.themes[i].mainQuestions);
      expect(theme.criteria).toEqual(config.themes[i].criteria);
      expect(theme.rubric).toEqual(config.themes[i].rubric);
    });
    // It is accepted by the same validation the create and update handlers use, unchanged.
    expect(parseInterview(itv, { language: 'cpp' })).toEqual({ provided: true, value: itv, error: null });
  });
});

describe('arguments and users', () => {
  it('parses the options', () => {
    expect(parseArgs(['--preview-user', 'a', '--preview-user', 'b@x.edu', '--yes', '--hidden-tests', 'T1, T2']))
      .toMatchObject({ previewUsers: ['a', 'b@x.edu'], yes: true, hiddenTests: ['T1', 'T2'] });
    expect(parseArgs([]).yes).toBeUndefined();
    expect(() => parseArgs(['--nope'])).toThrow('Unknown option');
    expect(() => parseArgs(['--preview-user'])).toThrow('needs a value');
  });

  it('takes an id as it is and looks an email up, keeping only the id', async () => {
    const lookup = jest.fn(async (email) => (email === 'someone@virginia.edu' ? 'user-42' : null));
    await expect(resolveUsers(['user-1', 'someone@virginia.edu', 'user-1'], lookup)).resolves.toEqual(['user-1', 'user-42']);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('does not echo the email when nobody has it', async () => {
    await expect(resolveUsers(['nobody@virginia.edu'], async () => null)).rejects.toThrow(/^No user with that email/);
    await expect(resolveUsers(['nobody@virginia.edu'], async () => null)).rejects.not.toThrow('nobody@virginia.edu');
  });

  it('uses the dev region and the shared table names', () => {
    expect(DEV).toEqual({ region: 'us-east-1', milestones: 'Milestones', testCases: 'TestCases', users: 'Users' });
  });
});
