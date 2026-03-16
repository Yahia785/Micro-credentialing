const { getEmbeddedAssessment } = require('/opt/nodejs/db/embedded-assessments');
const { createEmbeddedSubmission } = require('/opt/nodejs/db/embedded-submission');
const { gradeEmbeddedCode } = require('/opt/nodejs/utils/anthropic');
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