const { getMilestone, getAllMilestones } = require('/opt/nodejs/db/milestones');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');
const { viewerFor, canSeeProblem, forViewer } = require('/opt/nodejs/utils/assessment-view');

/**
 * Lambda Handler: Get Milestone(s)
 * Endpoint: GET /milestones (get all)
 * Endpoint: GET /milestones/{milestoneId} (get one)
 * Authorization: Any authenticated user
 * Hidden problems (isHidden) are for admins (listed with isHidden: true) and for the users on the problem's previewUserIds list.
 * Everyone else never sees them: not in the list, and a direct request is a 404.
 */
exports.handler = withHandler(async (ctx) => {
  // Check if getting a specific milestone or all milestones
  const milestoneId = ctx.pathParams.milestoneId;

  // Students never receive the embedded rubric criteria or the interview setup.
  // If the role cannot be read, the caller is treated as a normal student.
  const viewer = await viewerFor(ctx.userId);
  if (!viewer.ok) log.warn('Could not read the caller role; treating the caller as a student');
  const isAdmin = viewer.isAdmin;

  if (milestoneId) {
    // Get specific milestone
    log.info('Getting milestone', { milestoneId });
    const milestone = await getMilestone(milestoneId);

    if (!milestone || !canSeeProblem(milestone, ctx.userId, viewer)) {
      return errorResponse(404, 'Milestone not found');
    }

    log.info('Milestone found', { milestoneId });
    return successResponse(200, { milestone: forViewer(milestone, isAdmin) });
  } else {
    // Get all milestones
    log.info('Getting all milestones');
    const milestones = await getAllMilestones();

    // Hidden items (dev/test problems) are for admins and for the users on the problem's preview list.
    const visibleMilestones = milestones
      .filter(m => canSeeProblem(m, ctx.userId, viewer))
      .map(m => (isAdmin && m.isHidden ? { ...m, isHidden: true } : m));

    log.info('Milestones found', { count: visibleMilestones.length, hiddenCount: milestones.filter(m => m.isHidden).length, isAdmin });
    return successResponse(200, {
      milestones: visibleMilestones.map((m) => forViewer(m, isAdmin)),
      count: visibleMilestones.length
    });
  }
});
