const { getSubmission } = require('/opt/nodejs/db/submissions');
const { getUser } = require('/opt/nodejs/db/users');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: Get Submission
 * Endpoint: GET /submissions/{submissionId}
 * Authorization: Any authenticated user (can only see their own submissions)
 */
exports.handler = withHandler(async (ctx) => {
  const userId = ctx.userId;

  // Get submissionId from path
  const submissionId = ctx.pathParams.submissionId;

  if (!submissionId) {
    return errorResponse(400, 'Submission ID is required');
  }

  log.info('Fetching submission', { submissionId });

  // Get submission from database
  const submission = await getSubmission(submissionId);

  if (!submission) {
    return errorResponse(404, 'Submission not found');
  }

  const user = await getUser(userId);
  const isAdmin = user && user.role === 'admin';

  // Security: Only allow users to see their own submissions
  if (submission.userId !== userId && !isAdmin) {
    return errorResponse(403, 'Forbidden: You can only view your own submissions');
  }

  log.info('Submission found', { submissionId });

  // Filter test results for non-admin users (hide input/output for hidden tests)
  let filteredSubmission = { ...submission };

  if (!isAdmin && submission.testResults) {
    filteredSubmission.testResults = submission.testResults.map(r => ({
      ...r,
      input: r.isHidden ? '[Hidden]' : r.input,
      expectedOutput: r.isHidden ? '[Hidden]' : r.expectedOutput,
      actualOutput: r.isHidden ? '[Hidden]' : r.actualOutput
    }));
  }

  return successResponse(200, {
    submission: filteredSubmission
  });
});
