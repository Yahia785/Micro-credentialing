const { abandonInterview } = require('/opt/nodejs/services/interview-service');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Leave (abandon) an interview
 * Endpoint: POST /interviews/{interviewId}/abandon
 * Authorization: Interview owner only. The student confirmed leaving the page: the interview ends and cannot be retaken.
 */
exports.handler = withHandler(async (ctx) => {
  const interviewId = ctx.pathParams.interviewId;
  if (!interviewId) {
    return errorResponse(400, 'Interview ID is required');
  }
  const result = await abandonInterview({ userId: ctx.userId, interviewId });
  return successResponse(200, result);
});
