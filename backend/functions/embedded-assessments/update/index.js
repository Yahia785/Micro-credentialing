const { getEmbeddedAssessment, updateEmbeddedAssessment } = require('/opt/nodejs/db/embedded-assessments');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: Update Embedded Assessment
 * Endpoint: PUT /embedded-assessments/{assessmentId}
 * Authorization: Admin only
 */
exports.handler = withHandler(async (ctx) => {
  const assessmentId = ctx.pathParams.assessmentId;

  if (!assessmentId) {
    return errorResponse(400, 'Assessment ID is required');
  }

  const existing = await getEmbeddedAssessment(assessmentId);
  if (!existing) {
    return errorResponse(404, 'Embedded assessment not found');
  }

  const body = ctx.body;

  const updates = {};

  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.difficulty !== undefined) updates.difficulty = body.difficulty;
  if (body.bcdiplomaTemplateId !== undefined) updates.bcdiplomaTemplateId = body.bcdiplomaTemplateId;

  if (body.rubric !== undefined) {
    if (!Array.isArray(body.rubric) || body.rubric.length === 0) {
      return errorResponse(400, 'Rubric must be a non-empty array');
    }
    updates.rubric = body.rubric.map(c => c.trim()).filter(c => c);
  }

  if (Object.keys(updates).length === 0) {
    return errorResponse(400, 'No fields to update');
  }

  log.info('Updating embedded assessment', { assessmentId });

  const assessment = await updateEmbeddedAssessment(assessmentId, updates);

  log.info('Embedded assessment updated', { assessmentId });

  return successResponse(200, {
    message: 'Embedded assessment updated successfully',
    assessment
  });
}, { requireAdmin: true });
