const { getEmbeddedAssessment } = require('/opt/nodejs/db/embedded-assessments');
const { createEmbeddedSubmission } = require('/opt/nodejs/db/embedded-submission');
const { gradeEmbeddedCode } = require('/opt/nodejs/utils/anthropic');
const { getUser, updateUser, addCompletedMilestone } = require('/opt/nodejs/db/users');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: Submit Embedded Assessment
 * Endpoint: POST /embedded-assessments/{assessmentId}/submit
 * Authorization: Any authenticated user
 */
exports.handler = withHandler(async (ctx) => {
  const authenticatedUserId = ctx.userId;

  const assessmentId = ctx.pathParams.assessmentId;

  if (!assessmentId) {
    return errorResponse(400, 'Assessment ID is required');
  }

  // Check if user already submitted this assessment
  const user = await getUser(authenticatedUserId);
  if (!user) {
    return errorResponse(404, 'User not found');
  }

  const alreadySubmitted = (user.completedMilestones || []).some(
    m => m.milestoneId === assessmentId
  );

  if (alreadySubmitted) {
    return errorResponse(400, 'You have already submitted this assessment. Only one submission is allowed.');
  }

  const assessment = await getEmbeddedAssessment(assessmentId);
  if (!assessment) {
    return errorResponse(404, 'Embedded assessment not found');
  }

  const body = ctx.body;

  if (!body.code || !body.code.trim()) {
    return errorResponse(400, 'Code is required');
  }

  if (!assessment.rubric || assessment.rubric.length === 0) {
    return errorResponse(500, 'Assessment has no rubric criteria configured');
  }

  log.info('Grading embedded submission', { assessmentId, userId: authenticatedUserId });

  // Call Claude to grade against the rubric
  const gradingResult = await gradeEmbeddedCode(body.code, assessment.rubric);

  log.info('Grading result', {
    passedCriteria: gradingResult.passedCriteria,
    totalCriteria: gradingResult.totalCriteria,
    score: gradingResult.score,
    passed: gradingResult.passed
  });

  // Save submission to DynamoDB
  const submission = await createEmbeddedSubmission({
    userId: authenticatedUserId,
    studentEmail: user.email,
    studentName: user.name || '',
    milestoneId: assessmentId,
    code: body.code,
    rubricResults: gradingResult.rubricResults,
    passedCriteria: gradingResult.passedCriteria,
    totalCriteria: gradingResult.totalCriteria,
    score: gradingResult.score,
    passed: gradingResult.passed,
    llmModel: gradingResult.llmModel
  });

  log.info('Embedded submission created', { submissionId: submission.submissionId });

  // Add to user's completedMilestones so they cannot retake
  // This happens regardless of pass/fail — one submission allowed
  try {
    await addCompletedMilestone(authenticatedUserId, {
      milestoneId: assessmentId,
      score: gradingResult.score,
      passedTests: gradingResult.passedCriteria,
      totalTests: gradingResult.totalCriteria,
      submissionId: submission.submissionId
    });

    log.info('Added to completedMilestones', { userId: authenticatedUserId, assessmentId });

    // If passed, update user credential/milestone counters
    if (gradingResult.passed) {
      await updateUser(authenticatedUserId, {
        credentialsCount: (user.credentialsCount || 0) + 1,
        milestonesCompleted: (user.milestonesCompleted || 0) + 1
      });
    }
  } catch (userUpdateErr) {
    // Don't fail the submission if user update fails — log and continue
    log.error('Failed to update user completedMilestones', { error: userUpdateErr.message });
  }

  return successResponse(200, {
    message: gradingResult.passed ? 'Assessment passed!' : 'Assessment did not pass.',
    submissionId: submission.submissionId,
    passed: gradingResult.passed,
    score: gradingResult.score,
    passedCriteria: gradingResult.passedCriteria,
    totalCriteria: gradingResult.totalCriteria,
    rubricResults: gradingResult.rubricResults
  });
});
