const { getEmbeddedAssessment, deleteEmbeddedAssessment } = require('/opt/nodejs/db/embedded-assessments');
const { getUser } = require('/opt/nodejs/db/users');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { handleOptionsRequest } = require('/opt/nodejs/middleware/cors-middleware');

/**
 * Lambda Handler: Delete Embedded Assessment
 * Endpoint: DELETE /embedded-assessments/{assessmentId}
 * Authorization: Admin only
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

    const user = await getUser(authenticatedUserId);
    if (!user || user.role !== 'admin') {
      return errorResponse(403, 'Forbidden: Admin access required');
    }

    const assessmentId = event.pathParameters?.assessmentId;

    if (!assessmentId) {
      return errorResponse(400, 'Assessment ID is required');
    }

    const existing = await getEmbeddedAssessment(assessmentId);
    if (!existing) {
      return errorResponse(404, 'Embedded assessment not found');
    }

    console.log('Deleting embedded assessment:', assessmentId);

    await deleteEmbeddedAssessment(assessmentId);

    console.log('Embedded assessment deleted:', assessmentId);

    return successResponse(200, {
      message: 'Embedded assessment deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting embedded assessment:', error);
    return errorResponse(500, 'Failed to delete embedded assessment', error.message);
  }
};