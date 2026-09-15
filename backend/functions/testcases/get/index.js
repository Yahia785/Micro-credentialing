const { getTestCasesByMilestone } = require('/opt/nodejs/db/testcases');
const { getMilestone } = require('/opt/nodejs/db/milestones');
const { getUser } = require('/opt/nodejs/db/users');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: Get Test Cases for a Milestone
 * Endpoint: GET /milestones/{milestoneId}/testcases
 * Authorization: Any authenticated user
 *
 * - Admins see all test cases
 * - Regular users see only non-hidden test cases
 */
exports.handler = withHandler(async (ctx) => {
  const authenticatedUserId = ctx.userId;

  // Get milestoneId from path
  const milestoneId = ctx.pathParams.milestoneId;

  if (!milestoneId) {
    return errorResponse(400, 'Milestone ID is required');
  }

  // Check if milestone exists
  const existingMilestone = await getMilestone(milestoneId);
  if (!existingMilestone) {
    return errorResponse(404, 'Milestone not found');
  }

  log.info('Fetching test cases', { milestoneId });

  // Get all test cases for the milestone
  const allTestCases = await getTestCasesByMilestone(milestoneId);

  // Check if user is admin
  const user = await getUser(authenticatedUserId);
  const isAdmin = user && user.role === 'admin';

  log.info('User role checked', { role: user?.role, isAdmin });

  // Filter test cases based on user role
  let testCases;
  if (isAdmin) {
    // Admins see all test cases
    testCases = allTestCases;
  } else {
    // Regular users see only non-hidden test cases
    testCases = allTestCases.filter(tc => !tc.isHidden);
  }

  // Sort by order
  testCases.sort((a, b) => (a.order || 0) - (b.order || 0));

  log.info('Returning test cases', { count: testCases.length, totalCount: allTestCases.length });

  return successResponse(200, {
    testCases: testCases,
    count: testCases.length,
    totalCount: allTestCases.length,
    milestoneId: milestoneId
  });
});
