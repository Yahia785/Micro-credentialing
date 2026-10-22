const { startInterview } = require('/opt/nodejs/services/interview-service');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');

/**
 * Lambda Handler: Start Interview
 * Endpoint: POST /interviews
 * Authorization: Any authenticated user (must own the submission)
 */
exports.handler = withHandler(async (ctx) => {
  const result = await startInterview({
    userId: ctx.userId,
    submissionId: ctx.body.submissionId,
  });
  return successResponse(201, result);
});
