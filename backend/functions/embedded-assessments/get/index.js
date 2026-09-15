const { getEmbeddedAssessment, getAllEmbeddedAssessments } = require('/opt/nodejs/db/embedded-assessments');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: Get Embedded Assessment(s)
 * Endpoint: GET /embedded-assessments (all)
 * Endpoint: GET /embedded-assessments/{assessmentId} (single)
 * Authorization: Any authenticated user
 */
exports.handler = withHandler(async (ctx) => {
  const assessmentId = ctx.pathParams.assessmentId;

  if (assessmentId) {
    log.info('Getting embedded assessment', { assessmentId });

    const assessment = await getEmbeddedAssessment(assessmentId);

    if (!assessment) {
      return errorResponse(404, 'Embedded assessment not found');
    }

    return successResponse(200, { assessment });

  } else {
    log.info('Getting all embedded assessments');

    const assessments = await getAllEmbeddedAssessments();

    return successResponse(200, { assessments });
  }
});
