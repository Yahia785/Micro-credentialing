const { getSubmission } = require('/opt/nodejs/db/submissions');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { CORS_HEADERS } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Get Submission
 * Endpoint: GET /submissions/{submissionId}
 * Authorization: Any authenticated user (can only see their own submissions)
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  // Handle OPTIONS preflight request
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: ''
    };
  }

  try {
    // Get userId from JWT token
    const userId = event.requestContext?.authorizer?.claims?.sub;
    
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }
    
    // Get submissionId from path
    const submissionId = event.pathParameters?.submissionId;
    
    if (!submissionId) {
      return errorResponse(400, 'Submission ID is required');
    }
    
    console.log('Fetching submission:', submissionId);
    
    // Get submission from database
    const submission = await getSubmission(submissionId);
    
    if (!submission) {
      return errorResponse(404, 'Submission not found');
    }
    
    // Security: Only allow users to see their own submissions
    // TODO: Allow admins to see all submissions
    if (submission.userId !== userId) {
      return errorResponse(403, 'Forbidden: You can only view your own submissions');
    }
    
    console.log('Submission found:', submission);
    
    // Filter test results for non-admin users (hide input/output for hidden tests)
    // TODO: Check if user is admin
    const isAdmin = false;
    
    let filteredSubmission = { ...submission };
    
    if (!isAdmin && submission.testResults) {
      filteredSubmission.testResults = submission.testResults.map(r => ({
        ...r,
        input: r.isHidden ? '[Hidden]' : r.input,
        expectedOutput: r.isHidden ? '[Hidden]' : r.expectedOutput,
        actualOutput: r.isHidden ? '[Hidden]' : r.actualOutput
      }));
    }
    
    return successResponse(200, {
      submission: filteredSubmission
    });
    
  } catch (error) {
    console.error('Error getting submission:', error);
    return errorResponse(500, 'Failed to get submission', error.message);
  }
};