const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { CORS_HEADERS } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Initiate Email Change
 * Frontend will handle Cognito verification directly
 * This endpoint is optional - just for logging purposes
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
    const userId = event.requestContext?.authorizer?.claims?.sub;
    
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }
    
    const body = JSON.parse(event.body || '{}');
    const newEmail = body.email;
    
    if (!newEmail) {
      return errorResponse(400, 'New email is required');
    }
    
    console.log('Email change initiated for user:', userId, 'to new email:', newEmail);
    console.log('Frontend will handle Cognito verification. Code will be sent to:', newEmail);
    
    return successResponse(200, {
      message: `Verification code will be sent to ${newEmail}. Please check your inbox.`,
      pendingEmail: newEmail
    });
    
  } catch (error) {
    console.error('Error:', error);
    return errorResponse(500, 'Failed to initiate email change', error.message);
  }
};