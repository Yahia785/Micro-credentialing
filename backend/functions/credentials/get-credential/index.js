const { getCredential } = require('/opt/nodejs/db/credentials');
const { getUser } = require('/opt/nodejs/db/users');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: Get a Single Credential
 * Endpoint: GET /credentials/{credentialId}
 * Authorization: Authenticated users (can only see their own)
 */
exports.handler = withHandler(async (ctx) => {
  const userId = ctx.userId;

  // Get credentialId from path
  const credentialId = ctx.pathParams.credentialId;

  if (!credentialId) {
    return errorResponse(400, 'Credential ID is required');
  }

  log.info('Fetching credential', { credentialId });

  // Get credential from database
  const credential = await getCredential(credentialId);

  if (!credential) {
    return errorResponse(404, 'Credential not found');
  }

  const user = await getUser(userId);
  const isAdmin = user && user.role === 'admin';

  // Security: Only allow users to see their own credentials
  if (credential.userId !== userId && !isAdmin) {
    return errorResponse(403, 'Forbidden: You can only view your own credentials');
  }

  log.info('Credential found', { credentialId });

  return successResponse(200, {
    credential: credential
  });
});
