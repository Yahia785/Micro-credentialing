const { rejectReview } = require('/opt/nodejs/db/proctoring-reviews');
const { getUser, updateUser } = require('/opt/nodejs/db/users');
const { getSubmission } = require('/opt/nodejs/db/submissions');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: Reject Proctoring Review
 * Endpoint: POST /proctoring/reject-review
 * Authorization: Admin only
 *
 * Marks the submission as rejected/disqualified and changes status to 'failed'.
 * Never issues a credential. Rejection reason, policy violated, and review notes
 * are stored and returned as feedback for display in the code editor view mode.
 */
exports.handler = withHandler(async (ctx) => {
  const authenticatedUserId = ctx.userId;

  // Check if user is admin
  const user = await getUser(authenticatedUserId);
  if (!user || user.role !== 'admin') {
    return errorResponse(403, 'Forbidden: Admin access required');
  }

  // Parse request body
  const body = ctx.body;
  const { submissionId, rejectionReason, policyViolated, reviewNotes } = body;

  if (!submissionId) {
    return errorResponse(400, 'submissionId is required');
  }

  if (!rejectionReason) {
    return errorResponse(400, 'rejectionReason is required');
  }

  log.info('Rejecting review', { submissionId });

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

  log.info('Review rejected successfully', { submissionId });

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

        log.info('Updated completedMilestones with review status', { submissionId });
      }
    }
  } catch (updateError) {
    log.error('Failed to update completedMilestones reviewStatus', { error: updateError.message });
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
});
