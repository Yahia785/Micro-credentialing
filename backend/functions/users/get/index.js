const { getUser } = require('/opt/nodejs/db/users');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');

// CORS headers for all responses
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'OPTIONS,GET,POST,PUT,DELETE'
};

/**
 * Add CORS headers to response
 */
function addCorsHeaders(response) {
  return {
    ...response,
    headers: {
      ...(response.headers || {}),
      ...CORS_HEADERS
    }
  };
}

/**
 * Lambda Handler: Get User Profile
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
    // Get userId from path parameter or from JWT token
    const userId = event.pathParameters?.userId || 
                   event.requestContext?.authorizer?.claims?.sub;
    
    if (!userId) {
      return addCorsHeaders(errorResponse(400, 'User ID is required'));
    }
    
    console.log('Getting user:', userId);
    const user = await getUser(userId);
    
    if (!user) {
      console.log('User not found');
      return addCorsHeaders(errorResponse(404, 'User not found'));
    }
    
    console.log('User found:', user);
    return addCorsHeaders(successResponse(200, { user }));
    
  } catch (error) {
    console.error('Error getting user:', error);
    return addCorsHeaders(errorResponse(500, 'Failed to get user profile', error.message));
  }
};