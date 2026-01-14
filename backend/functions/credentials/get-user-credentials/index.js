const { getCredentialsByUser } = require('/opt/nodejs/db/credentials');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { CORS_HEADERS } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Get User's Credentials
 * Endpoint: GET /credentials
 * Authorization: Authenticated users (see their own credentials)
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
    // Get userId from JWT token
    const userId = event.requestContext?.authorizer?.claims?.sub;
    
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }
    
    console.log('Fetching credentials for user:', userId);
    
    // Get all credentials for this user
    const credentials = await getCredentialsByUser(userId);
    
    console.log(`Found ${credentials.length} credentials`);
    
    return successResponse(200, {
      credentials: credentials,
      count: credentials.length
    });
    
  } catch (error) {
    console.error('Error getting credentials:', error);
    return errorResponse(500, 'Failed to get credentials', error.message);
  }
};