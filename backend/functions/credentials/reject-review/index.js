const { rejectReview } = require('/opt/nodejs/db/proctoring-reviews');
const { getUser } = require('/opt/nodejs/db/users');
const { getSubmission } = require('/opt/nodejs/db/submissions');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { CORS_HEADERS } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Reject Proctoring Review
 * Endpoint: POST /proctoring/reject-review
 * Authorization: Admin only
 * 
 * This marks the submission as rejected and changes status to 'failed'
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
    const authenticatedUserId = event.requestContext?.authorizer?.claims?.sub;
    
    if (!authenticatedUserId) {
      return errorResponse(401, 'Unauthorized');
    }
    
    // Check if user is admin
    const user = await getUser(authenticatedUserId);
    if (!user || user.role !== 'admin') {
      return errorResponse(403, 'Forbidden: Admin access required');
    }
    
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { submissionId, rejectionReason } = body;
    
    if (!submissionId) {
      return errorResponse(400, 'submissionId is required');
    }
    
    if (!rejectionReason) {
      return errorResponse(400, 'rejectionReason is required');
    }
    
    console.log('Rejecting review for submission:', submissionId);
    
    // Verify submission exists
    const submission = await getSubmission(submissionId);
    if (!submission) {
      return errorResponse(404, 'Submission not found');
    }
    
    // Reject the review
    const updatedSubmission = await rejectReview(
      submissionId,
      authenticatedUserId,
      rejectionReason
    );
    
    console.log('Review rejected successfully');
    
    return successResponse(200, {
      message: 'Review rejected successfully',
      submission: updatedSubmission
    });
    
  } catch (error) {
    console.error('Error rejecting review:', error);
    return errorResponse(500, 'Failed to reject review', error.message);
  }
};