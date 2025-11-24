const { approveReview } = require('/opt/nodejs/db/proctoring-reviews');
const { getUser } = require('/opt/nodejs/db/users');
const { getSubmission } = require('/opt/nodejs/db/submissions');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Approve Proctoring Review
 * Endpoint: POST /proctoring/approve-review
 * Authorization: Admin only
 * 
 * This marks the submission as approved and triggers credential issuance
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
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
    const { submissionId, reviewNotes } = body;
    
    if (!submissionId) {
      return errorResponse(400, 'submissionId is required');
    }
    
    console.log('Approving review for submission:', submissionId);
    
    // Verify submission exists
    const submission = await getSubmission(submissionId);
    if (!submission) {
      return errorResponse(404, 'Submission not found');
    }
    
    // Verify submission is eligible for approval (passed tests)
    if (submission.status !== 'passed') {
      return errorResponse(400, 'Can only approve submissions that passed all tests');
    }
    
    // Approve the review
    const updatedSubmission = await approveReview(
      submissionId,
      authenticatedUserId,
      reviewNotes || 'Approved by admin'
    );
    
    console.log('Review approved successfully');
    
    // TODO: Trigger credential issuance (Week 3)
    // This will be done via EventBridge or direct Lambda invocation
    
    return successResponse(200, {
      message: 'Review approved successfully',
      submission: updatedSubmission
    });
    
  } catch (error) {
    console.error('Error approving review:', error);
    return errorResponse(500, 'Failed to approve review', error.message);
  }
};