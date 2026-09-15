const { createEmbeddedAssessment } = require('/opt/nodejs/db/embedded-assessments');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: Create Embedded Assessment
 * Endpoint: POST /embedded-assessments
 * Authorization: Admin only
 */
exports.handler = withHandler(async (ctx) => {
  const body = ctx.body;

  if (!body.title) {
    return errorResponse(400, 'Title is required');
  }

  if (!body.rubric || !Array.isArray(body.rubric) || body.rubric.length === 0) {
    return errorResponse(400, 'At least one rubric criterion is required');
  }

  // Validate each criterion is a non-empty string
  for (let i = 0; i < body.rubric.length; i++) {
    if (typeof body.rubric[i] !== 'string' || !body.rubric[i].trim()) {
      return errorResponse(400, `Rubric criterion ${i + 1} must be a non-empty string`);
    }
  }

  log.info('Creating embedded assessment', { title: body.title });

  const assessment = await createEmbeddedAssessment({
    title: body.title,
    description: body.description || '',
    difficulty: body.difficulty || 'medium',
    rubric: body.rubric.map(c => c.trim()),
    bcdiplomaTemplateId: body.bcdiplomaTemplateId || null
  });

  log.info('Embedded assessment created', { milestoneId: assessment.milestoneId });

  return successResponse(201, {
    message: 'Embedded assessment created successfully',
    assessment
  });
}, { requireAdmin: true });
