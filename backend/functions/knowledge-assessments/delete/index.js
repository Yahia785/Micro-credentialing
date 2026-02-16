const { deleteKnowledgeAssessment, getKnowledgeAssessment } = require('/opt/nodejs/db/knowledge-assessments');
const { getUser } = require('/opt/nodejs/db/users');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { handleOptionsRequest } = require('/opt/nodejs/middleware/cors-middleware');
/**
 * Lambda Handler: Delete Knowledge Assessment
 * Endpoint: DELETE /knowledge-assessments/{assessmentId}
 * Authorization: Admin only
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
      // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return handleOptionsRequest();
  }

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
    
    console.log('Deleting knowledge assessment:', assessmentId);
    
    await deleteKnowledgeAssessment(assessmentId);
    
    console.log('Knowledge assessment deleted:', assessmentId);
    
    return successResponse(200, {
      message: 'Knowledge assessment deleted successfully'
    });
    
  } catch (error) {
    console.error('Error deleting knowledge assessment:', error);
    return errorResponse(500, 'Failed to delete knowledge assessment', error.message);
  }
};