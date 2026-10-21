const { processEmbeddedSubmission } = require('/opt/nodejs/services/embedded-submission-service');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse, AppError } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Submit Embedded Assessment
 * Endpoint: POST /embedded-assessments/{assessmentId}/submit
 * Authorization: Any authenticated user
 *
 * Grading depends on the EMBEDDED_GRADING_MODE environment variable:
 *   "manual" (default) - saved for instructor review; the LLM is never called.
 *   "llm"              - graded against the rubric by the LLM (falls back to manual review on failure).
 */
exports.handler = withHandler(async (ctx) => {
  try {
    const result = await processEmbeddedSubmission({
      userId: ctx.userId,
      assessmentId: ctx.pathParams.assessmentId,
      body: ctx.body,
      gradingMode: process.env.EMBEDDED_GRADING_MODE
    });
    return successResponse(200, result);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.statusCode, error.message);
    }
    throw error;
  }
});
