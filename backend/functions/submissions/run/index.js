const { withHandler } = require('/opt/nodejs/middleware/handler');
const { runStudentCode } = require('/opt/nodejs/services/run-service');

/**
 * POST /submissions/run  (any signed-in user)
 *   { milestoneId, code, input }          run on the student's own input
 *   { milestoneId, code, sample: true }   run on the visible sample tests
 * Errors (from the service, turned into responses by the wrapper): 400 bad request or not C++, 403 already submitted,
 * 404 unknown or not visible problem, 429 over the run limit, 502 runner unavailable.
 */
exports.handler = withHandler(async (ctx) => {
  const { milestoneId, code, input, sample } = ctx.body;
  const deadlineMs = ctx.context?.getRemainingTimeInMillis ? ctx.context.getRemainingTimeInMillis() : null;
  return runStudentCode({ userId: ctx.userId, milestoneId, code, input, sample, deadlineMs });
});
