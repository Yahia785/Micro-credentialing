const { getKnowledgeAssessment } = require('/opt/nodejs/db/knowledge-assessments');
const { getSubmissionsByAssessment, getUserSubmissionsForAssessment } = require('/opt/nodejs/db/knowledge-submissions');
const { getUser } = require('/opt/nodejs/db/users');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Get Knowledge Assessment Submissions
 * Endpoint: GET /knowledge-assessments/{assessmentId}/submissions
 * Authorization: Admin sees all, regular users see only their own
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  try {
    // Get userId from JWT token
    const authenticatedUserId = event.requestContext?.authorizer?.claims?.sub;
    
    if (!authenticatedUserId) {
      return errorResponse(401, 'Unauthorized');
    }
    
    const assessmentId = event.pathParameters?.assessmentId;
    
    if (!assessmentId) {
      return errorResponse(400, 'Assessment ID is required');
    }
    
    // Check if assessment exists
    const assessment = await getKnowledgeAssessment(assessmentId);
    if (!assessment) {
      return errorResponse(404, 'Knowledge assessment not found');
    }
    
    // Check if user is admin
    const user = await getUser(authenticatedUserId);
    const isAdmin = user && user.role === 'admin';
    
    let submissions;
    
    if (isAdmin) {
      // Admin: get all submissions for this assessment
      console.log('Admin getting all submissions for assessment:', assessmentId);
      submissions = await getSubmissionsByAssessment(assessmentId);
    } else {
      // Regular user: get only their submissions
      console.log('User getting their submissions for assessment:', assessmentId);
      submissions = await getUserSubmissionsForAssessment(authenticatedUserId, assessmentId);
    }
    
    return successResponse(200, {
      assessmentId,
      submissions
    });
    
  } catch (error) {
    console.error('Error getting knowledge submissions:', error);
    return errorResponse(500, 'Failed to get knowledge submissions', error.message);
  }
};