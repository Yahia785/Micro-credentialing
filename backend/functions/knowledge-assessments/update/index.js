const { updateKnowledgeAssessment, getKnowledgeAssessment } = require('/opt/nodejs/db/knowledge-assessments');
const { getUser } = require('/opt/nodejs/db/users');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Update Knowledge Assessment
 * Endpoint: PUT /knowledge-assessments/{assessmentId}
 * Authorization: Admin only
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  try {
    // Get userId from JWT token
    const authenticatedUserId = event.requestContext?.authorizer?.claims?.sub;
    
    if (!authenticatedUserId) {
      return errorResponse(401, 'Unauthorized');
    }
    
    // Check if user is admin
    const user = await getUser(authenticatedUserId);
    if (!user || user.role !== 'admin') {
      return errorResponse(403, 'Forbidden: Admin access required');
    }
    
    const assessmentId = event.pathParameters?.assessmentId;
    
    if (!assessmentId) {
      return errorResponse(400, 'Assessment ID is required');
    }
    
    // Check if assessment exists
    const existing = await getKnowledgeAssessment(assessmentId);
    if (!existing) {
      return errorResponse(404, 'Knowledge assessment not found');
    }
    
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    
    // Build updates object (only include provided fields)
    const updates = {};
    
    if (body.title !== undefined) updates.title = body.title;
    if (body.description !== undefined) updates.description = body.description;
    if (body.timeLimit !== undefined) updates.timeLimit = body.timeLimit;
    if (body.passingScore !== undefined) updates.passingScore = body.passingScore;
    if (body.questions !== undefined) updates.questions = body.questions;
    if (body.bcdiplomaTemplateId !== undefined) updates.bcdiplomaTemplateId = body.bcdiplomaTemplateId;
    
    if (Object.keys(updates).length === 0) {
      return errorResponse(400, 'No fields to update');
    }
    
    console.log('Updating knowledge assessment:', assessmentId);
    
    const assessment = await updateKnowledgeAssessment(assessmentId, updates);
    
    console.log('Knowledge assessment updated:', assessmentId);
    
    return successResponse(200, {
      message: 'Knowledge assessment updated successfully',
      assessment
    });
    
  } catch (error) {
    console.error('Error updating knowledge assessment:', error);
    return errorResponse(500, 'Failed to update knowledge assessment', error.message);
  }
};