const { getEmbeddedAssessment, deleteEmbeddedAssessment } = require('/opt/nodejs/db/embedded-assessments');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: Delete Embedded Assessment
 * Endpoint: DELETE /embedded-assessments/{assessmentId}
 * Authorization: Admin only
 */
exports.handler = withHandler(async (ctx) => {
  const assessmentId = ctx.pathParams.assessmentId;

  if (!assessmentId) {
    return errorResponse(400, 'Assessment ID is required');
  }

  const existing = await getEmbeddedAssessment(assessmentId);
  if (!existing) {
    return errorResponse(404, 'Embedded assessment not found');
  }

  log.info('Deleting embedded assessment', { assessmentId });

  await deleteEmbeddedAssessment(assessmentId);

  log.info('Embedded assessment deleted', { assessmentId });

  return successResponse(200, {
    message: 'Embedded assessment deleted successfully'
  });
}, { requireAdmin: true });
