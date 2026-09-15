const { getCredentialsByUser } = require('/opt/nodejs/db/credentials');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: Get User's Credentials
 * Endpoint: GET /credentials
 * Authorization: Authenticated users (see their own credentials)
 */
exports.handler = withHandler(async (ctx) => {
  const userId = ctx.userId;

  log.info('Fetching credentials', { userId });

  // Get all credentials for this user
  const credentials = await getCredentialsByUser(userId);

  log.info('Credentials found', { count: credentials.length });

  return successResponse(200, {
    credentials: credentials,
    count: credentials.length
  });
});
