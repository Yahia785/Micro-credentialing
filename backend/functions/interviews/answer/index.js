const { submitAnswer } = require('/opt/nodejs/services/interview-service');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Answer Interview Question
 * Endpoint: POST /interviews/{interviewId}/answers
 * Authorization: Interview owner only
 */
exports.handler = withHandler(async (ctx) => {
  const interviewId = ctx.pathParams.interviewId;
  if (!interviewId) {
    return errorResponse(400, 'Interview ID is required');
  }

  const result = await submitAnswer({
    userId: ctx.userId,
    interviewId,
    answer: ctx.body.answer,
    clientTiming: ctx.body.clientTiming,
  });
  return successResponse(200, result);
});
