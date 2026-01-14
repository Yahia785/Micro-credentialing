const { updateMilestone, getMilestone } = require('/opt/nodejs/db/milestones');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { CORS_HEADERS } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Update Milestone (Problem)
 * Endpoint: PUT /milestones/{milestoneId}
 * Authorization: Admin only
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  // Handle OPTIONS preflight request
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: ''
    };
  }

  try {
    // Get userId from JWT token (logged in user)
    const authenticatedUserId = event.requestContext?.authorizer?.claims?.sub;
    
    if (!authenticatedUserId) {
      return errorResponse(401, 'Unauthorized');
    }
    
    // TODO: Add admin role check here
    // For now, we'll allow any authenticated user to update milestones
    // In production, you should check if the user has an 'admin' role
    
    // Get milestoneId from path
    const milestoneId = event.pathParameters?.milestoneId;
    
    if (!milestoneId) {
      return errorResponse(400, 'Milestone ID is required');
    }
    
    // Check if milestone exists
    const existingMilestone = await getMilestone(milestoneId);
    if (!existingMilestone) {
      return errorResponse(404, 'Milestone not found');
    }
    
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    
    // Validate that at least one field is being updated
    if (!body.title && !body.description && !body.difficulty) {
      return errorResponse(400, 'At least one field (title, description, or difficulty) must be provided');
    }
    
    // Validate difficulty level if provided
    if (body.difficulty) {
      const validDifficulties = ['easy', 'medium', 'hard'];
      if (!validDifficulties.includes(body.difficulty)) {
        return errorResponse(400, 'Difficulty must be one of: easy, medium, hard');
      }
    }
    
    console.log('Updating milestone:', milestoneId, 'with data:', body);
    
    // Update milestone
    const updatedMilestone = await updateMilestone(milestoneId, body);
    
    console.log('Milestone updated:', updatedMilestone);
    
    return successResponse(200, {
      message: 'Milestone updated successfully',
      milestone: updatedMilestone
    });
    
  } catch (error) {
    console.error('Error updating milestone:', error);
    return errorResponse(500, 'Failed to update milestone', error.message);
  }
};