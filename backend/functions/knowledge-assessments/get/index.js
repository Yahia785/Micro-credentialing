const { getKnowledgeAssessment, getAllKnowledgeAssessments } = require('/opt/nodejs/db/knowledge-assessments');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { handleOptionsRequest } = require('/opt/nodejs/middleware/cors-middleware');
/**
 * Lambda Handler: Get Knowledge Assessment(s)
 * Endpoint: GET /knowledge-assessments (all)
 * Endpoint: GET /knowledge-assessments/{assessmentId} (single)
 * Authorization: Any authenticated user
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
    
    const assessmentId = event.pathParameters?.assessmentId;
    
    if (assessmentId) {
      // Get single assessment
      console.log('Getting knowledge assessment:', assessmentId);
      
      const assessment = await getKnowledgeAssessment(assessmentId);
      
      if (!assessment) {
        return errorResponse(404, 'Knowledge assessment not found');
      }
      
      return successResponse(200, { assessment });
      
    } else {
      // Get all assessments
      console.log('Getting all knowledge assessments');
      
      const assessments = await getAllKnowledgeAssessments();
      
      return successResponse(200, { assessments });
    }
    
  } catch (error) {
    console.error('Error getting knowledge assessment(s):', error);
    return errorResponse(500, 'Failed to get knowledge assessment(s)', error.message);
  }
};