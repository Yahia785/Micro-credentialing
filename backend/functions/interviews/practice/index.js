const { startPracticeInterview } = require('/opt/nodejs/services/interview-service');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');

/**
 * Lambda Handler: Start a practice interview on an existing submission's code ({ submissionId }) or, for an interview-only assessment, on an
 * imported record ({ importId, milestoneId }).
 * Endpoint: POST /interviews/practice
 * Authorization: Admin only. The admin answers it through the normal answers endpoint.
 */
exports.handler = withHandler(async (ctx) => {
  const result = await startPracticeInterview({
    userId: ctx.userId,
    submissionId: ctx.body.submissionId,
    importId: ctx.body.importId,
    milestoneId: ctx.body.milestoneId,
  });
  return successResponse(201, result);
}, { requireAdmin: true });
