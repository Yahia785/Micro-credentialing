// The dev reset script's plan (no AWS access): what would be deleted, and when it refuses.
const { parseArgs, planReset, DEV } = require('../../../scripts/reset-test-submission');

const milestone = { milestoneId: 'm1', title: 'Tank', isHidden: true };
const user = {
  userId: 'u1',
  completedMilestones: [{ milestoneId: 'm1', submissionId: 'sub1' }, { milestoneId: 'm9', submissionId: 'sub9', score: 80 }],
};
const submissions = [{ submissionId: 'sub1' }];
const interviewsBySubmission = { sub1: [{ interviewId: 'int_sub1' }, { interviewId: 'intp_a' }] };

describe('planReset', () => {
  it('lists the submission, all its interviews (practice too) and the profile entry, and keeps the other milestones', () => {
    expect(planReset({ milestone, user, submissions, interviewsBySubmission })).toEqual({
      submissionIds: ['sub1'],
      interviewIds: ['int_sub1', 'intp_a'],
      completedEntries: 1,
      remainingMilestones: [{ milestoneId: 'm9', submissionId: 'sub9', score: 80 }],
    });
  });

  it('refuses a problem that is not hidden', () => {
    expect(() => planReset({ milestone: { ...milestone, isHidden: false }, user, submissions, interviewsBySubmission })).toThrow('not hidden');
    expect(() => planReset({ milestone: { milestoneId: 'm1' }, user, submissions, interviewsBySubmission })).toThrow('not hidden');
  });

  it('refuses when the problem or the user does not exist', () => {
    expect(() => planReset({ milestone: undefined, user, submissions, interviewsBySubmission })).toThrow('does not exist');
    expect(() => planReset({ milestone, user: undefined, submissions, interviewsBySubmission })).toThrow('does not exist');
  });

  it('refuses when a credential was already issued', () => {
    expect(() => planReset({ milestone, user, submissions: [{ submissionId: 'sub1', credentialIssued: true }], interviewsBySubmission })).toThrow('credential');
  });

  it('plans nothing for an account that never took the problem', () => {
    const plan = planReset({ milestone, user: { userId: 'u2', completedMilestones: [] }, submissions: [], interviewsBySubmission: {} });
    expect(plan).toMatchObject({ submissionIds: [], interviewIds: [], completedEntries: 0 });
  });
});

describe('arguments', () => {
  it('needs a user and a problem, and is a dry run unless --yes', () => {
    expect(parseArgs(['--user', 'a@b.edu', '--problem', 'm1'])).toEqual({ user: 'a@b.edu', problem: 'm1' });
    expect(parseArgs(['--user', 'u1', '--problem', 'm1', '--yes']).yes).toBe(true);
    expect(() => parseArgs(['--user', 'u1'])).toThrow('required');
    expect(() => parseArgs(['--nope'])).toThrow('Unknown option');
  });

  it('uses the dev tables', () => {
    expect(DEV).toMatchObject({ region: 'us-east-1', interviews: 'Interviews-dev', submissions: 'Submissions' });
  });
});
