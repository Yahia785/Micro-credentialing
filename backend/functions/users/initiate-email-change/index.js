const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: Initiate Email Change
 * Frontend will handle Cognito verification directly
 * This endpoint is optional - just for logging purposes
 */
exports.handler = withHandler(async (ctx) => {
  const userId = ctx.userId;

  const body = ctx.body;
  const newEmail = body.email;

  if (!newEmail) {
    return errorResponse(400, 'New email is required');
  }

  log.info('Email change initiated', { userId, newEmail });

  return successResponse(200, {
    message: `Verification code will be sent to ${newEmail}. Please check your inbox.`,
    pendingEmail: newEmail
  });
});
