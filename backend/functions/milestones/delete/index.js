const { deleteMilestoneWithCleanup, getMilestone } = require('/opt/nodejs/db/milestones');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: Delete Milestone (Problem)
 * Endpoint: DELETE /milestones/{milestoneId}
 * Authorization: Admin only
 */
exports.handler = withHandler(async (ctx) => {
  // Get milestoneId from path
  const milestoneId = ctx.pathParams.milestoneId;

  if (!milestoneId) {
    return errorResponse(400, 'Milestone ID is required');
  }

  // Check if milestone exists
  const existingMilestone = await getMilestone(milestoneId);
  if (!existingMilestone) {
    return errorResponse(404, 'Milestone not found');
  }

  log.info('Deleting milestone', { milestoneId });

  // Delete milestone
  await deleteMilestoneWithCleanup(milestoneId);

  log.info('Milestone deleted successfully', { milestoneId });

  return successResponse(200, {
    message: 'Milestone deleted successfully',
    milestoneId: milestoneId
  });
}, { requireAdmin: true });
