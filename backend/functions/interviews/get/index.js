const { getInterview } = require('/opt/nodejs/services/interview-service');
const { isAdminUser } = require('/opt/nodejs/utils/assessment-view');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Get Interview
 * Endpoint: GET /interviews/{interviewId}
 * Authorization: Interview owner (transcript without reasons) or admin (everything)
 */
exports.handler = withHandler(async (ctx) => {
  const interviewId = ctx.pathParams.interviewId;
  if (!interviewId) {
    return errorResponse(400, 'Interview ID is required');
  }

  const result = await getInterview({
    userId: ctx.userId,
    interviewId,
    isAdmin: await isAdminUser(ctx.userId),
  });
  return successResponse(200, result);
});
