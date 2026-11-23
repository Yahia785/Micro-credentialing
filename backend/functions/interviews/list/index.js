const { listSubmissionInterviews, listImportedSubmissions } = require('/opt/nodejs/services/interview-service');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');

/**
 * Lambda Handler: List the interviews of one submission (real and practice)
 * Endpoint: GET /interviews?submissionId={submissionId}
 *
 * Also: GET /interviews?imported=1 lists the imported records (A2 pilot) an interview-only assessment can be practised on:
 * { records: [{ importId, githubUsername, status, form, hasPlan }] }.
 * Authorization: Admin only
 */
exports.handler = withHandler(async (ctx) => {
  if (ctx.queryParams && ctx.queryParams.imported === '1') return successResponse(200, await listImportedSubmissions());
  const result = await listSubmissionInterviews({ submissionId: ctx.queryParams.submissionId });
  return successResponse(200, result);
}, { requireAdmin: true });
