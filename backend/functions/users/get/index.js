const { getUser } = require('/opt/nodejs/db/users');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: Get User Profile
 */
exports.handler = withHandler(async (ctx) => {
  // Get userId from path parameter or from JWT token
  const userId = ctx.pathParams.userId || ctx.userId;

  if (!userId) {
    return errorResponse(400, 'User ID is required');
  }

  log.info('Getting user', { userId });
  const user = await getUser(userId);

  if (!user) {
    log.info('User not found', { userId });
    return errorResponse(404, 'User not found');
  }

  log.info('User found', { userId });
  return successResponse(200, { user });
});
