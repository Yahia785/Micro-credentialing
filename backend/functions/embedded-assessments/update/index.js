const { getEmbeddedAssessment, updateEmbeddedAssessment } = require('/opt/nodejs/db/embedded-assessments');
const { getUser } = require('/opt/nodejs/db/users');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { handleOptionsRequest } = require('/opt/nodejs/middleware/cors-middleware');

/**
 * Lambda Handler: Update Embedded Assessment
 * Endpoint: PUT /embedded-assessments/{assessmentId}
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

    const body = JSON.parse(event.body || '{}');

    const updates = {};

    if (body.title !== undefined) updates.title = body.title;
    if (body.description !== undefined) updates.description = body.description;
    if (body.difficulty !== undefined) updates.difficulty = body.difficulty;
    if (body.bcdiplomaTemplateId !== undefined) updates.bcdiplomaTemplateId = body.bcdiplomaTemplateId;

    if (body.rubric !== undefined) {
      if (!Array.isArray(body.rubric) || body.rubric.length === 0) {
        return errorResponse(400, 'Rubric must be a non-empty array');
      }
      updates.rubric = body.rubric.map(c => c.trim()).filter(c => c);
    }

    if (Object.keys(updates).length === 0) {
      return errorResponse(400, 'No fields to update');
    }

    console.log('Updating embedded assessment:', assessmentId);

    const assessment = await updateEmbeddedAssessment(assessmentId, updates);

    console.log('Embedded assessment updated:', assessmentId);

    return successResponse(200, {
      message: 'Embedded assessment updated successfully',
      assessment
    });

  } catch (error) {
    console.error('Error updating embedded assessment:', error);
    return errorResponse(500, 'Failed to update embedded assessment', error.message);
  }
};