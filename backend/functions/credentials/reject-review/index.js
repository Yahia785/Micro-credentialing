const { rejectReview } = require('/opt/nodejs/db/proctoring-reviews');
const { getUser, updateUser } = require('/opt/nodejs/db/users');
const { getSubmission } = require('/opt/nodejs/db/submissions');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { CORS_HEADERS } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Reject Proctoring Review
 * Endpoint: POST /proctoring/reject-review
 * Authorization: Admin only
 *
 * Marks the submission as rejected/disqualified and changes status to 'failed'.
 * Never issues a credential. Rejection reason, policy violated, and review notes
 * are stored and returned as feedback for display in the code editor view mode.
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
    const { submissionId, rejectionReason, policyViolated, reviewNotes } = body;

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

    // Reject the review — flags the submission as rejected/disqualified (status: 'failed').
    // No credential issuance logic runs on this path.
    const updatedSubmission = await rejectReview(
      submissionId,
      authenticatedUserId,
      rejectionReason,
      reviewNotes || '',
      policyViolated || null
    );

    console.log('Review rejected successfully');

    const reviewedAt = new Date().toISOString();

    // Update the user's completedMilestones entry with review status
    try {
      const student = await getUser(submission.userId);
      if (student && student.completedMilestones) {
        const completedMilestoneIndex = student.completedMilestones.findIndex(
          (m) => m.submissionId === submissionId
        );

        if (completedMilestoneIndex >= 0) {
          student.completedMilestones[completedMilestoneIndex] = {
            ...student.completedMilestones[completedMilestoneIndex],
            proctoringData: {
              reviewStatus: 'rejected',
              rejectionReason,
              reviewNotes: reviewNotes || null,
              policyViolated: policyViolated || null,
              reviewedBy: authenticatedUserId,
              reviewedAt
            }
          };

          await updateUser(submission.userId, {
            completedMilestones: student.completedMilestones
          });

          console.log('Updated completedMilestones with review status');
        }
      }
    } catch (updateError) {
      console.error('Failed to update completedMilestones reviewStatus:', updateError);
    }

    const feedback = {
      rejectionReason,
      policyViolated: policyViolated || null,
      reviewNotes: reviewNotes || null,
      reviewedBy: authenticatedUserId,
      reviewedAt
    };

    return successResponse(200, {
      message: 'Review rejected successfully',
      submission: updatedSubmission,
      status: 'rejected',
      feedback
    });

  } catch (error) {
    console.error('Error rejecting review:', error);
    return errorResponse(500, 'Failed to reject review', error.message);
  }
};
