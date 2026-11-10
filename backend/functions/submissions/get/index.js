const { getSubmission } = require('/opt/nodejs/db/submissions');
const { getUser } = require('/opt/nodejs/db/users');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');
const { getMilestone } = require('/opt/nodejs/db/milestones');
const { toStudentSubmission, isHeldForReview, isUnderReview, underReviewSubmission } = require('/opt/nodejs/utils/assessment-view');

/**
 * Lambda Handler: Get Submission
 * Endpoint: GET /submissions/{submissionId}
 * Authorization: Any authenticated user (can only see their own submissions)
 */
exports.handler = withHandler(async (ctx) => {
  const userId = ctx.userId;

  // Get submissionId from path
  const submissionId = ctx.pathParams.submissionId;

  if (!submissionId) {
    return errorResponse(400, 'Submission ID is required');
  }

  log.info('Fetching submission', { submissionId });

  // Get submission from database
  const submission = await getSubmission(submissionId);

  if (!submission) {
    return errorResponse(404, 'Submission not found');
  }

  const user = await getUser(userId);
  const isAdmin = user && user.role === 'admin';

  // Security: Only allow users to see their own submissions
  if (submission.userId !== userId && !isAdmin) {
    return errorResponse(403, 'Forbidden: You can only view your own submissions');
  }

  log.info('Submission found', { submissionId });

  // A submission of a problem with the interview is held for the instructor: until it is approved or rejected the student gets
  // its status and submitted time only. Submissions saved before the flag existed are held by their problem's current setup.
  if (!isAdmin) {
    let held = submission;
    if (submission.heldForReview !== true) {
      const milestone = await getMilestone(submission.milestoneId);
      if (isHeldForReview(milestone)) held = { ...submission, heldForReview: true };
    }
    if (isUnderReview(held)) {
      return successResponse(200, { submission: underReviewSubmission(held) });
    }
  }

  // Filter test results for non-admin users (hide input/output for hidden tests)
  let filteredSubmission = { ...submission };

  if (!isAdmin && submission.testResults) {
    filteredSubmission.testResults = submission.testResults.map(r => ({
      ...r,
      input: r.isHidden ? '[Hidden]' : r.input,
      expectedOutput: r.isHidden ? '[Hidden]' : r.expectedOutput,
      actualOutput: r.isHidden ? '[Hidden]' : r.actualOutput
    }));
  }

  // The "left mid-session" flag is for instructors only; students see it as any submission under review.
  if (!isAdmin) {
    delete filteredSubmission.endedBy;
    // Embedded rubric criteria and per-criterion feedback appear only once the submission is reviewed.
    filteredSubmission = toStudentSubmission(filteredSubmission);
  }

  return successResponse(200, {
    submission: filteredSubmission
  });
});
