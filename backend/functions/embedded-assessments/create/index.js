const { createEmbeddedAssessment } = require('/opt/nodejs/db/embedded-assessments');
const { getUser } = require('/opt/nodejs/db/users');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { handleOptionsRequest } = require('/opt/nodejs/middleware/cors-middleware');

/**
 * Lambda Handler: Create Embedded Assessment
 * Endpoint: POST /embedded-assessments
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

    const body = JSON.parse(event.body || '{}');

    if (!body.title) {
      return errorResponse(400, 'Title is required');
    }

    if (!body.rubric || !Array.isArray(body.rubric) || body.rubric.length === 0) {
      return errorResponse(400, 'At least one rubric criterion is required');
    }

    // Validate each criterion is a non-empty string
    for (let i = 0; i < body.rubric.length; i++) {
      if (typeof body.rubric[i] !== 'string' || !body.rubric[i].trim()) {
        return errorResponse(400, `Rubric criterion ${i + 1} must be a non-empty string`);
      }
    }

    console.log('Creating embedded assessment:', body.title);

    const assessment = await createEmbeddedAssessment({
      title: body.title,
      description: body.description || '',
      difficulty: body.difficulty || 'medium',
      rubric: body.rubric.map(c => c.trim()),
      bcdiplomaTemplateId: body.bcdiplomaTemplateId || null
    });

    console.log('Embedded assessment created:', assessment.milestoneId);

    return successResponse(201, {
      message: 'Embedded assessment created successfully',
      assessment
    });

  } catch (error) {
    console.error('Error creating embedded assessment:', error);
    return errorResponse(500, 'Failed to create embedded assessment', error.message);
  }
};