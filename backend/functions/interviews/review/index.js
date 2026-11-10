const { saveInterviewReview } = require('/opt/nodejs/services/interview-service');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Save the instructor's review of an interview
 * Endpoint: PUT /interviews/{interviewId}/review
 * Authorization: Admin only
 * Body: { overrides: { "<question number>": { "<rubric item id>": true|false } }, grade: 0-100|null, note: string }
 */
exports.handler = withHandler(async (ctx) => {
  const interviewId = ctx.pathParams.interviewId;
  if (!interviewId) {
    return errorResponse(400, 'Interview ID is required');
  }
  const result = await saveInterviewReview({ userId: ctx.userId, interviewId, body: ctx.body });
  return successResponse(200, result);
}, { requireAdmin: true });
