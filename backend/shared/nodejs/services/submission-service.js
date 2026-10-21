const crypto = require('crypto');
const { createSubmission, updateSubmission } = require('../db/submissions');
const { getTestCasesByMilestone } = require('../db/testcases');
const { getMilestone } = require('../db/milestones');
const { getUser, updateUser, addCompletedMilestone } = require('../db/users');
const log = require('../utils/logger');
const {
  getLanguageId,
  getJudge0Credentials,
  submitBatch,
  pollResults,
  parseJudge0Result,
  calculateMetrics
} = require('../utils/judge0');
const { ValidationError, NotFoundError, ExternalServiceError } = require('../utils/errors');
const { END_REASONS, parseEndedBy } = require('../utils/submission-end-reason');

/**
 * Save a submission whose grading failed so it is never lost.
 * Status "grading_failed" is additive; the original failure kind is kept in gradingFailureReason
 * ('error' | 'timeout'). The submission goes to instructor review (proctoringData.reviewStatus =
 * 'pending'), is never credentialed, and the milestone is recorded as completed (one attempt).
 * Returns a normal 200-style result so the client gets a submissionId and uploads its recordings.
 */
async function saveGradingFailure({ submissionRecord, alreadyCreated, reason, errorMessage }) {
  const { submissionId, userId, milestoneId, totalTests } = submissionRecord;
  const reviewFields = { proctoringData: { reviewStatus: 'pending' } };

  if (alreadyCreated) {
    await updateSubmission(submissionId, {
      status: 'grading_failed',
      gradingFailureReason: reason,
      errorMessage,
      credentialAwarded: false,
      ...reviewFields,
      updatedAt: new Date().toISOString()
    });
  } else {
    await createSubmission({ ...submissionRecord, status: 'grading_failed', ...reviewFields });
    await updateSubmission(submissionId, {
      gradingFailureReason: reason,
      errorMessage,
      updatedAt: new Date().toISOString()
    });
  }

  try {
    await addCompletedMilestone(userId, {
      milestoneId,
      score: 0,
      passedTests: 0,
      totalTests,
      submissionId
    });
  } catch (error) {
    // Don't fail the response if this fails: the submission itself is saved.
    log.error('Error updating user milestones after grading failure', { submissionId, error: error.message });
  }

  return {
    submissionId,
    status: 'grading_failed',
    passedTests: 0,
    totalTests,
    score: 0,
    testResults: [],
    totalExecutionTime: 0,
    credentialAwarded: false,
    gradingFailed: true
  };
}

/**
 * Core submission workflow: validate the milestone/test cases, run the code
 * through Judge0, score it, persist the submission, and update the user's
 * completed milestones. Extracted from the submissions/create handler.
 *
 * `deadlineMs` is the Lambda's remaining time budget (from
 * context.getRemainingTimeInMillis()), threaded through to pollResults so it
 * can bail out before the function times out instead of leaving a zombie
 * pending submission.
 *
 * Throws ValidationError for bad input / missing resources, and
 * Judge0 failures do not throw: the submission is saved as 'grading_failed' for instructor review
 * (see saveGradingFailure).
 */
async function processSubmission({ userId, milestoneId, code, language, deadlineMs, endedBy: rawEndedBy }) {
  const { value: endedBy, error: endedByError } = parseEndedBy(rawEndedBy);
  if (endedByError) {
    throw new ValidationError(endedByError);
  }
  // A student who left mid-session is auto-submitted: it must go to instructor review
  // and can never be auto-credentialed, even with a perfect score.
  const leftPage = endedBy === END_REASONS.LEFT_PAGE;

  log.info('Submission request', { userId, milestoneId, language, endedBy });

  // Check if milestone exists
  const milestone = await getMilestone(milestoneId);
  if (!milestone) {
    throw new NotFoundError('Milestone');
  }

  // Fetch user profile (needed for submission record and admin check)
  const user = await getUser(userId);

  // Get all test cases for this milestone
  const allTestCases = await getTestCasesByMilestone(milestoneId);

  // Filter to only test cases that should be run through Judge0
  const testCasesToRun = allTestCases.filter(tc => tc.includeInJudge0);

  if (testCasesToRun.length === 0) {
    throw new ValidationError('No test cases configured for this milestone');
  }

  log.info('Running test cases through Judge0', { count: testCasesToRun.length });

  // Build the submission record up front so any failure from here on can still be saved.
  const submissionId = `sub_${crypto.randomUUID()}`;
  const submissionRecord = {
    submissionId,
    userId,
    studentEmail: user?.email || null,
    studentName: user?.name || null,
    milestoneId,
    code,
    language,
    status: 'pending',
    endedBy,
    // Force the review queue entry now: for left_page the recording upload may never happen.
    ...(leftPage && { proctoringData: { reviewStatus: 'pending' } }),
    passedTests: 0,
    totalTests: testCasesToRun.length,
    score: 0,
    testResults: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  // Get Judge0 credentials from Secrets Manager
  let judge0Credentials;
  try {
    judge0Credentials = await getJudge0Credentials();
  } catch (error) {
    log.error('Could not load Judge0 credentials', { error: error.message });
    // Nothing has been saved yet: save the student's work for instructor review.
    return saveGradingFailure({ submissionRecord, alreadyCreated: false, reason: 'error', errorMessage: error.message });
  }
  const { apiKey: judge0ApiKey, apiHost: judge0ApiHost } = judge0Credentials;

  if (!judge0ApiKey || judge0ApiKey === 'dummy-key-for-testing') {
    log.error('JUDGE0_API_KEY not configured, returning mock response');

    // Return a test response without calling Judge0
    const mockSubmission = {
      submissionId,
      userId,
      milestoneId,
      code,
      language,
      status: 'pending',
      endedBy,
      message: 'Judge0 not configured. Submission created but not executed.',
      passedTests: 0,
      totalTests: testCasesToRun.length,
      score: 0,
      testResults: [],
      credentialAwarded: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await createSubmission(mockSubmission);

    return mockSubmission;
  }

  // Get language ID for Judge0
  let languageId;
  try {
    languageId = getLanguageId(language);
  } catch (error) {
    throw new ValidationError(error.message);
  }

  // Create submission record (pending state)
  await createSubmission(submissionRecord);
  log.info('Submission created', { submissionId });

  // Prepare Judge0 submissions (one for each test case)
  const judge0Submissions = testCasesToRun.map(testCase => ({
    source_code: code,
    language_id: languageId,
    stdin: testCase.input,
    expected_output: testCase.expectedOutput,
    cpu_time_limit: (milestone.timeLimit || 5000) / 1000, // Convert ms to seconds
    memory_limit: milestone.memoryLimit || 256000 // In KB
  }));

  log.info('Submitting to Judge0', { submissionId });

  // Submit to Judge0, poll for results and score them. Any failure here (error, daily quota,
  // timeout) must not lose the student's work: the submission is kept as "grading_failed" and
  // sent to the instructor, and the client still gets a submissionId to attach recordings to.
  let testResults;
  let metrics;
  try {
    const judge0Response = await submitBatch(judge0Submissions, judge0ApiKey, judge0ApiHost);

    // Extract tokens from response
    const tokens = judge0Response.map(r => r.token);
    log.info('Judge0 tokens received', { tokens });

    // Poll for results
    const judge0Results = await pollResults(tokens, judge0ApiKey, judge0ApiHost, 30, 1000, deadlineMs);
    log.info('Judge0 results received', { submissionId });

    // Parse results
    testResults = judge0Results.map((result, index) =>
      parseJudge0Result(result, testCasesToRun[index])
    );

    // Calculate metrics
    metrics = calculateMetrics(testResults);
  } catch (error) {
    log.error('Judge0 grading error', { submissionId, error: error.message });

    // Keep the old distinction: bailing out because the Lambda is about to time out vs. other errors.
    const isTimeout = String(error.message).includes('Lambda timeout');
    return saveGradingFailure({
      submissionRecord,
      alreadyCreated: true,
      reason: isTimeout ? 'timeout' : 'error',
      errorMessage: error.message
    });
  }

  log.info('Submission metrics', { metrics });

  // Determine if credential should be awarded (100% pass rate)
  // Never for left_page submissions: those wait for an instructor.
  const credentialAwarded = metrics.status === 'passed' && !leftPage;

  // Update submission with results
  const updatedSubmission = await updateSubmission(submissionId, {
    status: metrics.status,
    passedTests: metrics.passedTests,
    totalTests: metrics.totalTests,
    score: metrics.score,
    testResults: testResults,
    totalExecutionTime: metrics.totalExecutionTime,
    averageExecutionTime: metrics.averageExecutionTime,
    maxExecutionTime: metrics.maxExecutionTime,
    totalMemory: metrics.totalMemory,
    averageMemory: metrics.averageMemory,
    maxMemory: metrics.maxMemory,
    credentialAwarded: credentialAwarded,
    updatedAt: new Date().toISOString()
  });

  // Add to user's completedMilestones (whether passed or failed)
  log.info('Adding submission to completed milestones (pass or fail)', { submissionId });

  try {
    // Add to completedMilestones array
    await addCompletedMilestone(userId, {
      milestoneId: milestoneId,
      score: metrics.score,
      passedTests: metrics.passedTests,
      totalTests: metrics.totalTests,
      submissionId: submissionId
    });

    log.info('Added to completedMilestones', { userId, milestoneId });

    // Only update credential count if 100% passed
    if (credentialAwarded) {
      if (user) {
        await updateUser(userId, {
          credentialsCount: (user.credentialsCount || 0) + 1,
          milestonesCompleted: (user.milestonesCompleted || 0) + 1
        });

        log.info('Updated user stats, credential awarded', { userId });
      }
    }
  } catch (error) {
    log.error('Error updating user milestones', { error: error.message });
    // Don't fail the submission if this fails
  }

  // Check if user is admin to determine what to show
  const isAdmin = user && user.role === 'admin';

  log.info('User role checked', { role: user?.role, isAdmin });

  // Format test results for response
  // Admins see full details, regular users see hidden test details
  const formattedTestResults = testResults.map(result => {
    if (result.isHidden && !isAdmin) {
      return {
        ...result,
        input: '[Hidden]',
        expectedOutput: '[Hidden]',
        actualOutput: '[Hidden]'
      };
    }
    return result;
  });

  return {
    submissionId: updatedSubmission.submissionId,
    status: updatedSubmission.status,
    passedTests: updatedSubmission.passedTests,
    totalTests: updatedSubmission.totalTests,
    score: updatedSubmission.score,
    testResults: formattedTestResults,
    totalExecutionTime: updatedSubmission.totalExecutionTime,
    credentialAwarded: updatedSubmission.credentialAwarded
  };
}

module.exports = { processSubmission, ValidationError, ExternalServiceError };
