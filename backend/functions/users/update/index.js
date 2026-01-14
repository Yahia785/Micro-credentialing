const { updateUser, getUser } = require('/opt/nodejs/db/users');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { CORS_HEADERS } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Update User Profile (Name only)
 * Endpoint: PUT /users/{userId} or PUT /users/me
 * 
 * Only updates name in this endpoint.
 * Email changes use separate endpoints:
 * - POST /users/initiate-email-change
 * - POST /users/verify-email-change
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
    
    // Get userId from path (if specified)
    const pathUserId = event.pathParameters?.userId;
    
    // Determine which user to update
    let userIdToUpdate;
    if (pathUserId === 'me' || !pathUserId) {
      userIdToUpdate = authenticatedUserId;
    } else {
      // Security: Only allow users to update their own profile
      if (pathUserId !== authenticatedUserId) {
        return errorResponse(403, 'Forbidden: You can only update your own profile');
      }
      userIdToUpdate = pathUserId;
    }
    
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    
    // Only allow name updates in this endpoint
    if (!body.name) {
      return errorResponse(400, 'Name is required. For email changes, use /users/initiate-email-change');
    }
    
    console.log('Updating user name:', userIdToUpdate, 'with name:', body.name);
    
    // Update name in DynamoDB
    const updatedUser = await updateUser(userIdToUpdate, { name: body.name });
    
    if (!updatedUser) {
      console.log('User not found in DynamoDB');
      return errorResponse(404, 'User not found');
    }
    
    console.log('User updated successfully:', updatedUser);
    
    return successResponse(200, { 
      message: 'User profile updated successfully',
      user: updatedUser 
    });
    
  } catch (error) {
    console.error('Error updating user:', error);
    return errorResponse(500, 'Failed to update user profile', error.message);
  }
};