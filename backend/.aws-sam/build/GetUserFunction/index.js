const { getUser } = require('/opt/nodejs/db/users');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Get User Profile
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  try {
    // Get userId from path parameter or from JWT token
    const userId = event.pathParameters?.userId || 
                   event.requestContext?.authorizer?.claims?.sub;
    
    if (!userId) {
      return errorResponse(400, 'User ID is required');
    }
    
    console.log('Getting user:', userId);
    const user = await getUser(userId);
    
    if (!user) {
      console.log('User not found');
      return errorResponse(404, 'User not found');
    }
    
    console.log('User found:', user);
    return successResponse(200, { user });
    
  } catch (error) {
    console.error('Error getting user:', error);
    return errorResponse(500, 'Failed to get user profile', error.message);
  }
};