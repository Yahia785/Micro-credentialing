const { createUser } = require('/opt/nodejs/db/users');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Create User Profile
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  try {
    // Check if triggered by Cognito (Post Confirmation)
    if (event.triggerSource === 'PostConfirmation_ConfirmSignUp') {
      const userId = event.request.userAttributes.sub;
      const email = event.request.userAttributes.email;
      const name = event.request.userAttributes.name || '';
      
      await createUser({ userId, email, name });
      
      console.log(`User profile created for: ${email}`);
      return event;
    }
    
    // Or API Gateway format
    const userId = event.requestContext?.authorizer?.claims?.sub;
    
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }
    
    const body = JSON.parse(event.body || '{}');
    
    console.log('Creating user:', { userId, email: body.email });
    const user = await createUser({
      userId: userId,
      email: body.email,
      name: body.name || ''
    });
    
    console.log('User created:', user);
    return successResponse(201, { message: 'User profile created', user });
    
  } catch (error) {
    console.error('Error creating user:', error);
    
    if (event.triggerSource) {
      console.error('Failed to create user profile, but allowing auth to continue');
      return event;
    }
    
    return errorResponse(500, 'Failed to create user profile', error.message);
  }
};