const { updateUser } = require('/opt/nodejs/db/users');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: Update User Profile (Name only)
 * Endpoint: PUT /users/{userId} or PUT /users/me
 *
 * Only updates name in this endpoint.
 * Email changes use separate endpoints:
 * - POST /users/initiate-email-change
 * - POST /users/verify-email-change
 */
exports.handler = withHandler(async (ctx) => {
  const authenticatedUserId = ctx.userId;

  // Get userId from path (if specified)
  const pathUserId = ctx.pathParams.userId;

  // Determine which user to update
  let userIdToUpdate;
  if (pathUserId === 'me' || !pathUserId) {
    userIdToUpdate = authenticatedUserId;
  } else {
    // Security: Only allow users to update their own profile
    if (pathUserId !== authenticatedUserId) {
      return errorResponse(403, 'Forbidden: You can only update your own profile');
    }
    userIdToUpdate = pathUserId;
  }

  // Parse request body
  const body = ctx.body;

  // Only allow name updates in this endpoint
  if (!body.name) {
    return errorResponse(400, 'Name is required. For email changes, use /users/initiate-email-change');
  }

  log.info('Updating user name', { userIdToUpdate, name: body.name });

  // Update name in DynamoDB
  const updatedUser = await updateUser(userIdToUpdate, { name: body.name });

  if (!updatedUser) {
    log.info('User not found in DynamoDB', { userIdToUpdate });
    return errorResponse(404, 'User not found');
  }

  log.info('User updated successfully', { userIdToUpdate });

  return successResponse(200, {
    message: 'User profile updated successfully',
    user: updatedUser
  });
});
