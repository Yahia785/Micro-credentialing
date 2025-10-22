const { updateUser } = require('/opt/nodejs/db/users');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Verify Email Change
 * Called after frontend verifies code with Cognito
 * Updates DynamoDB with the new email
 * 
 * Cognito has already:
 * 1. Sent verification code to new email
 * 2. User entered code in frontend
 * 3. Frontend verified code with Cognito
 * 4. Email is now updated and verified in Cognito
 * 
 * This function just syncs the email to DynamoDB
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  try {
    const userId = event.requestContext?.authorizer?.claims?.sub;
    console.log('User ID from token:', userId);
    
    if (!userId) {
      console.error('No user ID found in token');
      return errorResponse(401, 'Unauthorized');
    }
    
    const body = JSON.parse(event.body || '{}');
    console.log('Request body:', body);
    
    const newEmail = body.email;
    
    if (!newEmail) {
      console.error('No email provided in request');
      return errorResponse(400, 'Email is required');
    }
    
    console.log('Updating DynamoDB for user:', userId, 'with new email:', newEmail);
    
    try {
      // Update email in DynamoDB (Cognito already verified it)
      const updatedUser = await updateUser(userId, { email: newEmail });
      
      console.log('DynamoDB update result:', updatedUser);
      
      if (!updatedUser) {
        console.log('User not found in DynamoDB');
        return errorResponse(404, 'User not found');
      }
      
      console.log('Email successfully updated in DynamoDB:', updatedUser);
      
      return successResponse(200, {
        message: 'Email successfully changed!',
        user: updatedUser
      });
      
    } catch (dbError) {
      console.error('Database error:', dbError);
      return errorResponse(500, 'Database error', dbError.message);
    }
    
  } catch (error) {
    console.error('Error verifying email change:', error);
    return errorResponse(500, 'Failed to verify email change', error.message);
  }
};