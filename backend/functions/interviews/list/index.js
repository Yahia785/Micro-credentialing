const { listSubmissionInterviews } = require('/opt/nodejs/services/interview-service');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');

/**
 * Lambda Handler: List the interviews of one submission (real and practice)
 * Endpoint: GET /interviews?submissionId={submissionId}
 * Authorization: Admin only
 */
exports.handler = withHandler(async (ctx) => {
  const result = await listSubmissionInterviews({ submissionId: ctx.queryParams.submissionId });
  return successResponse(200, result);
}, { requireAdmin: true });
