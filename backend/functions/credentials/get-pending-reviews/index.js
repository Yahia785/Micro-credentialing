const { getPendingReviews } = require('/opt/nodejs/db/proctoring-reviews');
const { getUser } = require('/opt/nodejs/db/users');
const { getMilestone } = require('/opt/nodejs/db/milestones');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: Get Pending Proctoring Reviews
 * Endpoint: GET /proctoring/pending-reviews
 * Authorization: Admin only
 */
exports.handler = withHandler(async (ctx) => {
  const authenticatedUserId = ctx.userId;

  // Check if user is admin
  const user = await getUser(authenticatedUserId);
  if (!user || user.role !== 'admin') {
    return errorResponse(403, 'Forbidden: Admin access required');
  }

  log.info('Fetching pending reviews');

  const filter = ctx.queryParams?.filter || 'all'; // 'passed', 'failed', or 'all'

  // Get all submissions pending review
  const pendingSubmissions = await getPendingReviews(100, filter);

  // Enrich with milestone and user information
  const enrichedSubmissions = await Promise.all(
    pendingSubmissions.map(async (submission) => {
      const milestone = await getMilestone(submission.milestoneId);
      const submitter = await getUser(submission.userId);

      return {
        ...submission,
        problemTitle: milestone?.title || 'Unknown Problem',
        studentName: submitter?.name || 'Unknown Student',
        studentEmail: submitter?.email || 'Unknown Email',
        milestoneType: submission.type || 'coding',
        rubricResults: submission.rubricResults || [],
        passedCriteria: submission.passedCriteria || 0,
        totalCriteria: submission.totalCriteria || 0
      };
    })
  );

  log.info('Pending reviews found', { count: enrichedSubmissions.length });

  return successResponse(200, {
    submissions: enrichedSubmissions,
    count: enrichedSubmissions.length
  });
});
