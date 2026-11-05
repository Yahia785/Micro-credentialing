const { getMilestone, getAllMilestones } = require('/opt/nodejs/db/milestones');
const { getUser } = require('/opt/nodejs/db/users');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: Get Milestone(s)
 * Endpoint: GET /milestones (get all)
 * Endpoint: GET /milestones/{milestoneId} (get one)
 * Authorization: Any authenticated user
 * Hidden problems (isHidden) are listed for admins only, each marked isHidden: true.
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

    // Hidden items (dev/test problems) are for admins only. If the role cannot be read, treat the caller as a student.
    let isAdmin = false;
    try {
      const user = await getUser(ctx.userId);
      isAdmin = Boolean(user && user.role === 'admin');
    } catch (err) {
      log.warn('Could not read the caller role; hiding hidden milestones', { message: err.message });
    }

    const visibleMilestones = isAdmin
      ? milestones.map(m => (m.isHidden ? { ...m, isHidden: true } : m))
      : milestones.filter(m => !m.isHidden);

    log.info('Milestones found', { count: visibleMilestones.length, hiddenCount: milestones.filter(m => m.isHidden).length, isAdmin });
    return successResponse(200, {
      milestones: visibleMilestones,
      count: visibleMilestones.length
    });
  }
});
