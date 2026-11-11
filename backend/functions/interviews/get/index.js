const { getInterview } = require('/opt/nodejs/services/interview-service');
const { isAdminUser } = require('/opt/nodejs/utils/assessment-view');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Get Interview
 * Endpoint: GET /interviews/{interviewId}
 * Authorization: Interview owner (transcript without reasons) or admin (everything)
 * The owner opening a running interview starts its clock, once (not for ?peek=1, and never for an admin).
 */
exports.handler = withHandler(async (ctx) => {
  const interviewId = ctx.pathParams.interviewId;
  if (!interviewId) {
    return errorResponse(400, 'Interview ID is required');
  }

  const result = await getInterview({
    userId: ctx.userId,
    interviewId,
    isAdmin: await isAdminUser(ctx.userId),
    // ?peek=1: only ask whether the interview exists (the waiting page does, while the upload runs); it does not start the clock.
    peek: !!(ctx.queryParams && ctx.queryParams.peek === '1'),
    // The session key create gave to the page. Opening a running interview without it ends the interview ("abandoned"). Never logged.
    sessionKey: ctx.queryParams && ctx.queryParams.session,
  });
  return successResponse(200, result);
});
