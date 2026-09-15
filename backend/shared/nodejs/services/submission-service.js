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
 * ExternalServiceError when Judge0 itself fails.
 */
async function processSubmission({ userId, milestoneId, code, language, deadlineMs }) {
  log.info('Submission request', { userId, milestoneId, language });

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

  // Get Judge0 credentials from Secrets Manager
  const { apiKey: judge0ApiKey, apiHost: judge0ApiHost } = await getJudge0Credentials();

  if (!judge0ApiKey || judge0ApiKey === 'dummy-key-for-testing') {
    log.error('JUDGE0_API_KEY not configured, returning mock response');

    // Return a test response without calling Judge0
    const submissionId = `sub_${crypto.randomUUID()}`;
    const mockSubmission = {
      submissionId,
      userId,
      milestoneId,
      code,
      language,
      status: 'pending',
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
    passedTests: 0,
    totalTests: testCasesToRun.length,
    score: 0,
    testResults: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

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

  // Submit to Judge0
  let judge0Response;
  try {
    judge0Response = await submitBatch(judge0Submissions, judge0ApiKey, judge0ApiHost);
  } catch (error) {
    log.error('Judge0 submission error', { error: error.message });

    // Update submission with error
    await updateSubmission(submissionId, {
      status: 'error',
      errorMessage: error.message,
      updatedAt: new Date().toISOString()
    });

    throw new ExternalServiceError('judge0', `Failed to submit code to Judge0: ${error.message}`);
  }

  // Extract tokens from response
  const tokens = judge0Response.map(r => r.token);
  log.info('Judge0 tokens received', { tokens });

  // Poll for results
  let judge0Results;
  try {
    judge0Results = await pollResults(tokens, judge0ApiKey, judge0ApiHost, 30, 1000, deadlineMs);
  } catch (error) {
    log.error('Judge0 polling error', { error: error.message });

    // If we bailed out because the Lambda is about to time out, leave the
    // submission in a distinct 'timeout' state (recoverable / retryable)
    // rather than the generic 'error' state.
    const isTimeout = error.message.includes('Lambda timeout');

    // Update submission with error
    await updateSubmission(submissionId, {
      status: isTimeout ? 'timeout' : 'error',
      errorMessage: error.message,
      updatedAt: new Date().toISOString()
    });

    throw new ExternalServiceError('judge0', `Failed to get results from Judge0: ${error.message}`);
  }

  log.info('Judge0 results received', { submissionId });

  // Parse results
  const testResults = judge0Results.map((result, index) =>
    parseJudge0Result(result, testCasesToRun[index])
  );

  // Calculate metrics
  const metrics = calculateMetrics(testResults);

  log.info('Submission metrics', { metrics });

  // Determine if credential should be awarded (100% pass rate)
  const credentialAwarded = metrics.status === 'passed';

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
