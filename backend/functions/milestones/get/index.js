const { getMilestone, getAllMilestones } = require('/opt/nodejs/db/milestones');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { CORS_HEADERS } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Get Milestone(s)
 * Endpoint: GET /milestones (get all)
 * Endpoint: GET /milestones/{milestoneId} (get one)
 * Authorization: Any authenticated user
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
    
    // Check if getting a specific milestone or all milestones
    const milestoneId = event.pathParameters?.milestoneId;
    
    if (milestoneId) {
      // Get specific milestone
      console.log('Getting milestone:', milestoneId);
      const milestone = await getMilestone(milestoneId);
      
      if (!milestone) {
        return errorResponse(404, 'Milestone not found');
      }
      
      console.log('Milestone found:', milestone);
      return successResponse(200, { milestone });
    } else {
  // Get all milestones
  console.log('Getting all milestones');
  const milestones = await getAllMilestones();

  // Filter out hidden items (used to hide dev/test problems from production)
  const visibleMilestones = milestones.filter(m => !m.isHidden);

  console.log(`Found ${visibleMilestones.length} milestones (${milestones.length - visibleMilestones.length} hidden)`);
  return successResponse(200, { 
    milestones: visibleMilestones,
    count: visibleMilestones.length 
  });
}
    
  } catch (error) {
    console.error('Error getting milestone(s):', error);
    return errorResponse(500, 'Failed to get milestone(s)', error.message);
  }
};