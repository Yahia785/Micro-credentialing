const { withHandler } = require('/opt/nodejs/middleware/handler');
const { processSubmission, ValidationError, ExternalServiceError } = require('/opt/nodejs/services/submission-service');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { successResponse } = require('/opt/nodejs/utils/responses');
const log = require('/opt/nodejs/utils/logger');

exports.handler = withHandler(async (ctx) => {
  const { milestoneId, code, language } = ctx.body;

  if (!milestoneId || !code || !language) {
    return errorResponse(400, 'milestoneId, code, and language are required');
  }

  const deadlineMs = ctx.context?.getRemainingTimeInMillis
    ? ctx.context.getRemainingTimeInMillis()
    : null;

  try {
    const result = await processSubmission({
      userId: ctx.userId,
      milestoneId,
      code,
      language,
      user: null, // service will fetch user internally
      deadlineMs,
    });

    return successResponse(200, { submission: result });

  } catch (error) {
    if (error instanceof ValidationError) {
      return errorResponse(400, error.message);
    }
    if (error instanceof ExternalServiceError) {
      return errorResponse(502, error.message);
    }
    throw error; // re-throw for the wrapper's catch
  }
});
