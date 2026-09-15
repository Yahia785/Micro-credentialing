const { updateMilestone, getMilestone } = require('/opt/nodejs/db/milestones');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: Update Milestone (Problem)
 * Endpoint: PUT /milestones/{milestoneId}
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

  // Parse request body
  const body = ctx.body;

  // Validate that at least one field is being updated
  if (!body.title && !body.description && !body.difficulty) {
    return errorResponse(400, 'At least one field (title, description, or difficulty) must be provided');
  }

  // Validate difficulty level if provided
  if (body.difficulty) {
    const validDifficulties = ['easy', 'medium', 'hard'];
    if (!validDifficulties.includes(body.difficulty)) {
      return errorResponse(400, 'Difficulty must be one of: easy, medium, hard');
    }
  }

  log.info('Updating milestone', { milestoneId, body });

  // Update milestone
  const updatedMilestone = await updateMilestone(milestoneId, body);

  log.info('Milestone updated', { updatedMilestone });

  return successResponse(200, {
    message: 'Milestone updated successfully',
    milestone: updatedMilestone
  });
}, { requireAdmin: true });
