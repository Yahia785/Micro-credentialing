const { getEmbeddedAssessment, getAllEmbeddedAssessments } = require('/opt/nodejs/db/embedded-assessments');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { handleOptionsRequest } = require('/opt/nodejs/middleware/cors-middleware');

/**
 * Lambda Handler: Get Embedded Assessment(s)
 * Endpoint: GET /embedded-assessments (all)
 * Endpoint: GET /embedded-assessments/{assessmentId} (single)
 * Authorization: Any authenticated user
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  if (event.httpMethod === 'OPTIONS') {
    return handleOptionsRequest();
  }

  try {
    const authenticatedUserId = event.requestContext?.authorizer?.claims?.sub;

    if (!authenticatedUserId) {
      return errorResponse(401, 'Unauthorized');
    }

    const assessmentId = event.pathParameters?.assessmentId;

    if (assessmentId) {
      console.log('Getting embedded assessment:', assessmentId);

      const assessment = await getEmbeddedAssessment(assessmentId);

      if (!assessment) {
        return errorResponse(404, 'Embedded assessment not found');
      }

      return successResponse(200, { assessment });

    } else {
      console.log('Getting all embedded assessments');

      const assessments = await getAllEmbeddedAssessments();

      return successResponse(200, { assessments });
    }

  } catch (error) {
    console.error('Error getting embedded assessment(s):', error);
    return errorResponse(500, 'Failed to get embedded assessment(s)', error.message);
  }
};