const { updateMilestone, getMilestone } = require('/opt/nodejs/db/milestones');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');
const { parseCourse } = require('/opt/nodejs/utils/course');
const { parseInterview, redactInterview } = require('/opt/nodejs/utils/interview-config');

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

  const course = parseCourse(body.course);
  if (course.error) {
    return errorResponse(400, course.error);
  }

  const interview = parseInterview(body.interview, {
    language: body.language || existingMilestone.language,
    type: existingMilestone.type
  });
  if (interview.error) {
    return errorResponse(400, interview.error);
  }
  // An existing interview needs the assessment to stay C++.
  const effectiveInterview = interview.provided ? interview.value : existingMilestone.interview;
  if (effectiveInterview && effectiveInterview.enabled && (body.language || existingMilestone.language) !== 'cpp') {
    return errorResponse(400, 'Interviews are only supported for C++ assessments');
  }

  // Validate that at least one field is being updated
  if (!body.title && !body.description && !body.difficulty && !course.provided && !interview.provided) {
    return errorResponse(400, 'At least one field (title, description, difficulty, course, or interview) must be provided');
  }

  // Validate difficulty level if provided
  if (body.difficulty) {
    const validDifficulties = ['easy', 'medium', 'hard'];
    if (!validDifficulties.includes(body.difficulty)) {
      return errorResponse(400, 'Difficulty must be one of: easy, medium, hard');
    }
  }

  log.info('Updating milestone', { milestoneId, body: redactInterview(body) });

  // Update milestone
  // A cleared course is stored as null ("No course").
  // The interview is stored only in its validated form; a cleared interview is stored as null.
  const updates = { ...body };
  delete updates.interview;
  if (course.provided) updates.course = course.value;
  if (interview.provided) updates.interview = interview.value;
  const updatedMilestone = await updateMilestone(milestoneId, updates);

  log.info('Milestone updated', { updatedMilestone: redactInterview(updatedMilestone) });

  return successResponse(200, {
    message: 'Milestone updated successfully',
    milestone: updatedMilestone
  });
}, { requireAdmin: true });
