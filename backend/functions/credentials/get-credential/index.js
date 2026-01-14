const { getCredential } = require('/opt/nodejs/db/credentials');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { CORS_HEADERS } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Get a Single Credential
 * Endpoint: GET /credentials/{credentialId}
 * Authorization: Authenticated users (can only see their own)
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
    
    // Get credentialId from path
    const credentialId = event.pathParameters?.credentialId;
    
    if (!credentialId) {
      return errorResponse(400, 'Credential ID is required');
    }
    
    console.log('Fetching credential:', credentialId);
    
    // Get credential from database
    const credential = await getCredential(credentialId);
    
    if (!credential) {
      return errorResponse(404, 'Credential not found');
    }
    
    // Security: Only allow users to see their own credentials
    // TODO: Allow admins to see all credentials
    if (credential.userId !== userId) {
      return errorResponse(403, 'Forbidden: You can only view your own credentials');
    }
    
    console.log('Credential found:', credential);
    
    return successResponse(200, {
      credential: credential
    });
    
  } catch (error) {
    console.error('Error getting credential:', error);
    return errorResponse(500, 'Failed to get credential', error.message);
  }
};