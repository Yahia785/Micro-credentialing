const { withHandler } = require('/opt/nodejs/middleware/handler');
const { approveAndIssueCredential, ValidationError, ExternalServiceError } = require('/opt/nodejs/services/credential-service');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { successResponse } = require('/opt/nodejs/utils/responses');

// Lambda Handler: Approve Proctoring Review and Issue Credential (Admin only)
exports.handler = withHandler(async (ctx) => {
  const { submissionId, reviewNotes, adjustedScore, criteriaModifications } = ctx.body;

  if (!submissionId) {
    return errorResponse(400, 'submissionId is required');
  }

  if (adjustedScore !== undefined && adjustedScore !== null) {
    const score = Number(adjustedScore);
    if (isNaN(score) || score < 0 || score > 100) {
      return errorResponse(400, 'adjustedScore must be a number between 0 and 100');
    }
  }

  try {
    const result = await approveAndIssueCredential({
      submissionId,
      reviewNotes,
      adjustedScore,
      criteriaModifications,
      adminUserId: ctx.userId,
    });

    return successResponse(200, result);

  } catch (error) {
    if (error instanceof ValidationError) {
      return errorResponse(400, error.message);
    }
    if (error instanceof ExternalServiceError) {
      return errorResponse(502, error.message);
    }
    throw error; // re-throw for the wrapper's catch
  }
}, { requireAdmin: true });
