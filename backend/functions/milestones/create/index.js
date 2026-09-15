const { createMilestone } = require('/opt/nodejs/db/milestones');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: Create Milestone (Problem)
 * Endpoint: POST /milestones
 * Authorization: Admin only
 */
exports.handler = withHandler(async (ctx) => {
  const body = ctx.body;

  // Validate required fields
  if (!body.title || !body.description) {
    return errorResponse(400, 'Title and description are required');
  }

  // Validate difficulty level
  const validDifficulties = ['easy', 'medium', 'hard'];
  if (body.difficulty && !validDifficulties.includes(body.difficulty)) {
    return errorResponse(400, 'Difficulty must be one of: easy, medium, hard');
  }

  // Validate language (optional but if provided, must be valid)
  const validLanguages = ['python', 'javascript', 'java', 'cpp', 'c'];
  if (body.language && !validLanguages.includes(body.language)) {
    return errorResponse(400, 'Language must be one of: python, javascript, java, cpp, c');
  }

  log.info('Creating milestone', { body });

  // Create milestone with ALL fields
  const milestone = await createMilestone({
    title: body.title,
    description: body.description,
    concept: body.concept || '',
    difficulty: body.difficulty || 'medium',
    language: body.language || 'python',
    starterCode: body.starterCode || '',
    timeLimit: body.timeLimit || 5000,
    memoryLimit: body.memoryLimit || 256000,
    bcdiplomaTemplateId: body.bcdiplomaTemplateId
  });

  log.info('Milestone created', { milestone });

  return successResponse(201, {
    message: 'Milestone created successfully',
    milestone: milestone
  });
}, { requireAdmin: true });
