const { createUser } = require('/opt/nodejs/db/users');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');

// List of admin emails
const ADMIN_EMAILS = [
  'yahiatawfeek20@gmail.com' // Add your admin email here
];

/**
 * Determine if user should be admin based on email
 */
function getUserRole(email) {
  return ADMIN_EMAILS.includes(email.toLowerCase()) ? 'admin' : 'user';
}

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
      const role = getUserRole(email);
      
      console.log(`Creating user: ${email} with role: ${role}`);
      await createUser({ userId, email, name, role });
      
      console.log(`User profile created for: ${email} with role: ${role}`);
      return event;
    }
    
    // Or API Gateway format
    const userId = event.requestContext?.authorizer?.claims?.sub;
    
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }
    
    const body = JSON.parse(event.body || '{}');
    const role = getUserRole(body.email);
    
    console.log('Creating user:', { userId, email: body.email, role });
    const user = await createUser({
      userId: userId,
      email: body.email,
      name: body.name || '',
      role: role
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