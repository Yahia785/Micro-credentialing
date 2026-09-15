const { updateUser } = require('/opt/nodejs/db/users');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

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
exports.handler = withHandler(async (ctx) => {
  const userId = ctx.userId;
  log.info('User ID from token', { userId });

  const body = ctx.body;
  log.info('Request body received', { body });

  const newEmail = body.email;

  if (!newEmail) {
    log.error('No email provided in request');
    return errorResponse(400, 'Email is required');
  }

  log.info('Updating DynamoDB with new email', { userId, newEmail });

  try {
    // Update email in DynamoDB (Cognito already verified it)
    const updatedUser = await updateUser(userId, { email: newEmail });

    log.info('DynamoDB update result', { updatedUser });

    if (!updatedUser) {
      log.info('User not found in DynamoDB', { userId });
      return errorResponse(404, 'User not found');
    }

    log.info('Email successfully updated in DynamoDB', { userId });

    return successResponse(200, {
      message: 'Email successfully changed!',
      user: updatedUser
    });

  } catch (dbError) {
    log.error('Database error', { error: dbError.message });
    return errorResponse(500, 'Database error', dbError.message);
  }
});
