const { deleteMilestone, getMilestone } = require('/opt/nodejs/db/milestones');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { CORS_HEADERS } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Delete Milestone (Problem)
 * Endpoint: DELETE /milestones/{milestoneId}
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
    // For now, we'll allow any authenticated user to delete milestones
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
    
    console.log('Deleting milestone:', milestoneId);
    
    // Delete milestone
    await deleteMilestone(milestoneId);
    
    console.log('Milestone deleted successfully');
    
    return successResponse(200, {
      message: 'Milestone deleted successfully',
      milestoneId: milestoneId
    });
    
  } catch (error) {
    console.error('Error deleting milestone:', error);
    return errorResponse(500, 'Failed to delete milestone', error.message);
  }
};