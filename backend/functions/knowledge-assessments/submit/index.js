const { getKnowledgeAssessment } = require('/opt/nodejs/db/knowledge-assessments');
const { createKnowledgeSubmission } = require('/opt/nodejs/db/knowledge-submissions');
const { gradeKnowledgeAssessment } = require('/opt/nodejs/utils/knowledge-grading');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Submit Knowledge Assessment
 * Endpoint: POST /knowledge-assessments/{assessmentId}/submit
 * Authorization: Any authenticated user
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  try {
    // Get userId from JWT token
    const authenticatedUserId = event.requestContext?.authorizer?.claims?.sub;
    
    if (!authenticatedUserId) {
      return errorResponse(401, 'Unauthorized');
    }
    
    const assessmentId = event.pathParameters?.assessmentId;
    
    if (!assessmentId) {
      return errorResponse(400, 'Assessment ID is required');
    }
    
    // Get the assessment
    const assessment = await getKnowledgeAssessment(assessmentId);
    if (!assessment) {
      return errorResponse(404, 'Knowledge assessment not found');
    }
    
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    
    if (!body.answers || !Array.isArray(body.answers)) {
      return errorResponse(400, 'Answers array is required');
    }
    
    console.log('Grading knowledge assessment:', assessmentId, 'for user:', authenticatedUserId);
    
    // Grade the assessment
    const gradingResult = gradeKnowledgeAssessment(
      body.answers,
      assessment.questions,
      assessment.passingScore
    );
    
    console.log('Grading result:', {
      totalScore: gradingResult.totalScore,
      maxScore: gradingResult.maxScore,
      percentage: gradingResult.percentage,
      passed: gradingResult.passed
    });
    
    // Create submission record
    const submission = await createKnowledgeSubmission({
      userId: authenticatedUserId,
      milestoneId: assessmentId,
      answers: body.answers,
      results: gradingResult.results,
      totalScore: gradingResult.totalScore,
      maxScore: gradingResult.maxScore,
      percentage: gradingResult.percentage,
      passed: gradingResult.passed
    });
    
    console.log('Submission created:', submission.submissionId);
    
    return successResponse(200, {
      message: gradingResult.passed ? 'Assessment passed!' : 'Assessment not passed',
      submissionId: submission.submissionId,
      totalScore: gradingResult.totalScore,
      maxScore: gradingResult.maxScore,
      percentage: gradingResult.percentage,
      passed: gradingResult.passed,
      results: gradingResult.results
    });
    
  } catch (error) {
    console.error('Error submitting knowledge assessment:', error);
    return errorResponse(500, 'Failed to submit knowledge assessment', error.message);
  }
};