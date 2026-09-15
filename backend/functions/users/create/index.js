const { createUser } = require('/opt/nodejs/db/users');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

// List of admin emails
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

/**
 * Determine if user should be admin based on email
 */
function getUserRole(email) {
  return ADMIN_EMAILS.includes(email.toLowerCase()) ? 'admin' : 'user';
}

/**
 * Lambda Handler: Create User Profile
 */
exports.handler = withHandler(async (ctx) => {
  const event = ctx.event;

  try {
    // Check if triggered by Cognito (Post Confirmation)
    if (event.triggerSource === 'PostConfirmation_ConfirmSignUp') {
      const userId = event.request.userAttributes.sub;
      const email = event.request.userAttributes.email;
      const name = event.request.userAttributes.name || '';
      const role = getUserRole(email);

      log.info('Creating user from Cognito trigger', { email, role });
      await createUser({ userId, email, name, role });

      log.info('User profile created', { email, role });
      return event;
    }

    // Or API Gateway format
    const userId = event.requestContext?.authorizer?.claims?.sub;

    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const body = ctx.body;
    const role = getUserRole(body.email);

    log.info('Creating user', { userId, email: body.email, role });
    const user = await createUser({
      userId: userId,
      email: body.email,
      name: body.name || '',
      role: role
    });

    log.info('User created', { user });
    return successResponse(201, { message: 'User profile created', user });

  } catch (error) {
    log.error('Error creating user', { error: error.message });

    if (event.triggerSource) {
      log.error('Failed to create user profile, but allowing auth to continue');
      return event;
    }

    return errorResponse(500, 'Failed to create user profile', error.message);
  }
}, { public: true });
