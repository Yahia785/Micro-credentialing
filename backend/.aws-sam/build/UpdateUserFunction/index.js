const { updateUser } = require('/opt/nodejs/db/users');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Update User Profile
 * Endpoint: PUT /users/{userId} or PUT /users/me
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
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
      // Update current user
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
    
    // Validate input - at least one field must be provided
    if (!body.name && !body.email) {
      return errorResponse(400, 'At least one field (name or email) must be provided');
    }
    
    console.log('Updating user:', userIdToUpdate, 'with data:', body);
    
    // Update user in database
    const updatedUser = await updateUser(userIdToUpdate, body);
    
    if (!updatedUser) {
      console.log('User not found for update');
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