// Approving a held submission (a problem with the interview) is what counts the credential: it is no longer counted at 100%.
jest.mock('../db/proctoring-reviews', () => ({ approveReview: jest.fn(async () => ({ submissionId: 'sub1' })) }));
jest.mock('../db/users');
jest.mock('../db/submissions');
jest.mock('../db/milestones');
jest.mock('../db/credentials', () => ({ createCredential: jest.fn(async (c) => ({ ...c, credentialId: 'cred1' })) }));
jest.mock('../utils/bcdiploma', () => ({
  pushCertificate: jest.fn(async () => ({ campaignId: 'camp1' })),
  pullCertificate: jest.fn(async () => ({ data: [{ ID: 'sub1', key: 'k', url: 'https://example.test/c', firstName: 'A', lastName: 'B' }] })),
}));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { getUser, updateUser } = require('../db/users');
const { getSubmission, updateSubmission } = require('../db/submissions');
const { getMilestone } = require('../db/milestones');
const { approveAndIssueCredential } = require('../services/credential-service');

const student = { userId: 'u1', email: 'a@b.edu', name: 'A B', credentialsCount: 2, milestonesCompleted: 4, completedMilestones: [] };

beforeEach(() => {
  jest.clearAllMocks();
  getUser.mockResolvedValue(student);
  getMilestone.mockResolvedValue({ milestoneId: 'm1', title: 'Tank', bcdiplomaTemplateId: 'tpl' });
  updateSubmission.mockResolvedValue({});
  updateUser.mockResolvedValue({});
});

const approve = (submission, extra = {}) => {
  getSubmission.mockResolvedValue({ submissionId: 'sub1', userId: 'u1', milestoneId: 'm1', score: 100, ...submission });
  return approveAndIssueCredential({ submissionId: 'sub1', adminUserId: 'admin1', ...extra });
};
const countUpdates = () => updateUser.mock.calls.filter(([, fields]) => 'credentialsCount' in fields);

it('counts the credential when the instructor approves a held submission with a passing score', async () => {
  await approve({ heldForReview: true });
  expect(countUpdates()).toEqual([['u1', { credentialsCount: 3, milestonesCompleted: 5 }]]);
});

it('counts nothing when a held submission is approved below the threshold', async () => {
  await approve({ heldForReview: true, score: 40 });
  expect(countUpdates()).toHaveLength(0);
});

it('does not count again for a submission that was not held (it was counted when it was submitted)', async () => {
  await approve({});
  expect(countUpdates()).toHaveLength(0);
});
