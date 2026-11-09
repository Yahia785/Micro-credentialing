// Submitting to a hidden problem is for admins and the users on its previewUserIds list only.
jest.mock('../db/submissions');
jest.mock('../db/testcases');
jest.mock('../db/milestones');
jest.mock('../db/users');
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { getTestCasesByMilestone } = require('../db/testcases');
const { getMilestone } = require('../db/milestones');
const { getUser } = require('../db/users');
const { processSubmission } = require('../services/submission-service');

const base = { userId: 'u1', milestoneId: 'm1', code: 'int main(){}', language: 'cpp' };

beforeEach(() => {
  jest.resetAllMocks();
  getTestCasesByMilestone.mockResolvedValue([]); // a visible problem then stops at "no test cases", which proves it got past the check
});

it.each([
  ['a student who is not on the list', { role: 'student' }, ['someone-else']],
  ['a student when there is no list', { role: 'student' }, undefined],
])('404s for %s', async (_name, user, previewUserIds) => {
  getMilestone.mockResolvedValue({ milestoneId: 'm1', isHidden: true, previewUserIds });
  getUser.mockResolvedValue({ userId: 'u1', ...user });
  await expect(processSubmission(base)).rejects.toMatchObject({ statusCode: 404 });
  expect(getTestCasesByMilestone).not.toHaveBeenCalled();
});

it.each([
  ['a student on the list', { role: 'student' }, ['u1']],
  ['an admin', { role: 'admin' }, undefined],
])('lets %s through to grading', async (_name, user, previewUserIds) => {
  getMilestone.mockResolvedValue({ milestoneId: 'm1', isHidden: true, previewUserIds });
  getUser.mockResolvedValue({ userId: 'u1', ...user });
  await expect(processSubmission(base)).rejects.toMatchObject({ message: expect.stringContaining('No test cases') });
  expect(getTestCasesByMilestone).toHaveBeenCalled();
});

it('does not change anything for a problem that is not hidden', async () => {
  getMilestone.mockResolvedValue({ milestoneId: 'm1' });
  getUser.mockResolvedValue({ userId: 'u1', role: 'student' });
  await expect(processSubmission(base)).rejects.toMatchObject({ message: expect.stringContaining('No test cases') });
});
