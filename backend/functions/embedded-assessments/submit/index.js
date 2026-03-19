const { getEmbeddedAssessment } = require('/opt/nodejs/db/embedded-assessments');
const { createEmbeddedSubmission } = require('/opt/nodejs/db/embedded-submission');
const { gradeEmbeddedCode } = require('/opt/nodejs/utils/anthropic');
const { getUser, updateUser, addCompletedMilestone } = require('/opt/nodejs/db/users');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { handleOptionsRequest } = require('/opt/nodejs/middleware/cors-middleware');

/**
 * Lambda Handler: Submit Embedded Assessment
 * Endpoint: POST /embedded-assessments/{assessmentId}/submit
 * Authorization: Any authenticated user
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  if (event.httpMethod === 'OPTIONS') {
    return handleOptionsRequest();
  }

  try {
    const authenticatedUserId = event.requestContext?.authorizer?.claims?.sub;

    if (!authenticatedUserId) {
      return errorResponse(401, 'Unauthorized');
    }

    const assessmentId = event.pathParameters?.assessmentId;

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

    const body = JSON.parse(event.body || '{}');

    if (!body.code || !body.code.trim()) {
      return errorResponse(400, 'Code is required');
    }

    if (!assessment.rubric || assessment.rubric.length === 0) {
      return errorResponse(500, 'Assessment has no rubric criteria configured');
    }

    console.log('Grading embedded submission for assessment:', assessmentId, 'user:', authenticatedUserId);

    // Call Claude to grade against the rubric
    const gradingResult = await gradeEmbeddedCode(body.code, assessment.rubric);

    console.log('Grading result:', {
      passedCriteria: gradingResult.passedCriteria,
      totalCriteria: gradingResult.totalCriteria,
      score: gradingResult.score,
      passed: gradingResult.passed
    });

    // Save submission to DynamoDB
    const submission = await createEmbeddedSubmission({
      userId: authenticatedUserId,
      milestoneId: assessmentId,
      code: body.code,
      rubricResults: gradingResult.rubricResults,
      passedCriteria: gradingResult.passedCriteria,
      totalCriteria: gradingResult.totalCriteria,
      score: gradingResult.score,
      passed: gradingResult.passed,
      llmModel: gradingResult.llmModel
    });

    console.log('Embedded submission created:', submission.submissionId);

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

      console.log('Added to completedMilestones');

      // If passed, update user credential/milestone counters
      if (gradingResult.passed) {
        await updateUser(authenticatedUserId, {
          credentialsCount: (user.credentialsCount || 0) + 1,
          milestonesCompleted: (user.milestonesCompleted || 0) + 1
        });
      }
    } catch (userUpdateErr) {
      // Don't fail the submission if user update fails — log and continue
      console.error('Failed to update user completedMilestones:', userUpdateErr.message);
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

  } catch (error) {
    console.error('Error submitting embedded assessment:', error);
    return errorResponse(500, 'Failed to submit embedded assessment', error.message);
  }
};