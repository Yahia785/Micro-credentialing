const { getMilestone, getAllMilestones } = require('/opt/nodejs/db/milestones');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: Get Milestone(s)
 * Endpoint: GET /milestones (get all)
 * Endpoint: GET /milestones/{milestoneId} (get one)
 * Authorization: Any authenticated user
 */
exports.handler = withHandler(async (ctx) => {
  // Check if getting a specific milestone or all milestones
  const milestoneId = ctx.pathParams.milestoneId;

  if (milestoneId) {
    // Get specific milestone
    log.info('Getting milestone', { milestoneId });
    const milestone = await getMilestone(milestoneId);

    if (!milestone) {
      return errorResponse(404, 'Milestone not found');
    }

    log.info('Milestone found', { milestone });
    return successResponse(200, { milestone });
  } else {
    // Get all milestones
    log.info('Getting all milestones');
    const milestones = await getAllMilestones();

    // Filter out hidden items (used to hide dev/test problems from production)
    const visibleMilestones = milestones.filter(m => !m.isHidden);

    log.info('Milestones found', { count: visibleMilestones.length, hiddenCount: milestones.length - visibleMilestones.length });
    return successResponse(200, {
      milestones: visibleMilestones,
      count: visibleMilestones.length
    });
  }
});
