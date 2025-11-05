const { createSubmission, updateSubmissionStatus } = require('/opt/nodejs/db/submissions');
const { getJudge0TestCases } = require('/opt/nodejs/db/testcases');
const { getMilestone } = require('/opt/nodejs/db/milestones');
const { getUser, updateUser } = require('/opt/nodejs/db/users');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { getLanguageId, submitBatch, pollResults, parseJudge0Result, calculateMetrics } = require('/opt/nodejs/utils/judge0');

/**
 * Lambda Handler: Submit Code for Grading
 * Endpoint: POST /submissions/submit
 * Authorization: Any authenticated user
 * 
 * Flow:
 * 1. Create submission record (pending)
 * 2. Fetch Judge0 test cases
 * 3. Submit batch to Judge0
 * 4. Poll for results
 * 5. Process results
 * 6. Update submission
 * 7. Award credential if all passed
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  try {
    // Get userId from JWT token
    const userId = event.requestContext?.authorizer?.claims?.sub;
    
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }
    
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { milestoneId, code, language } = body;
    
    if (!milestoneId || !code || !language) {
      return errorResponse(400, 'milestoneId, code, and language are required');
    }
    
    console.log('Submission received:', { userId, milestoneId, language });
    
    // Check if milestone exists
    const milestone = await getMilestone(milestoneId);
    if (!milestone) {
      return errorResponse(404, 'Milestone not found');
    }
    
    // Step 1: Create submission record with "pending" status
    const submissionId = `sub_${Date.now()}_${userId}`;
    const submission = await createSubmission({
      submissionId,
      userId,
      milestoneId,
      code,
      language,
      status: 'pending',
      submittedAt: new Date().toISOString()
    });
    
    console.log('Submission created:', submissionId);
    
    // Step 2: Fetch test cases marked for Judge0
    const testCases = await getJudge0TestCases(milestoneId);
    
    if (testCases.length === 0) {
      console.warn('No Judge0 test cases found for milestone:', milestoneId);
      return errorResponse(400, 'No test cases configured for this problem');
    }
    
    console.log(`Found ${testCases.length} Judge0 test cases`);
    
    // Step 3: Prepare Judge0 submissions
    const languageId = getLanguageId(language);
    
    const judge0Submissions = testCases.map(tc => ({
      source_code: code,
      language_id: languageId,
      stdin: tc.input,
      expected_output: tc.expectedOutput,
      cpu_time_limit: (milestone.timeLimit || 5000) / 1000, // Convert ms to seconds
      memory_limit: milestone.memoryLimit || 256000 // KB
    }));
    
    // Get Judge0 credentials from environment
    const judge0ApiKey = process.env.JUDGE0_API_KEY;
    const judge0ApiHost = process.env.JUDGE0_API_HOST || 'judge0-ce.p.rapidapi.com';
    
    if (!judge0ApiKey) {
      console.error('JUDGE0_API_KEY not configured');
      return errorResponse(500, 'Judge0 API not configured');
    }
    
    // Step 4: Submit batch to Judge0
    console.log('Submitting batch to Judge0...');
    const batchResult = await submitBatch(judge0Submissions, judge0ApiKey, judge0ApiHost);
    const tokens = batchResult.map(r => r.token);
    
    console.log('Judge0 tokens received:', tokens);
    
    // Step 5: Poll Judge0 for results
    console.log('Polling Judge0 for results...');
    const judge0Results = await pollResults(tokens, judge0ApiKey, judge0ApiHost, 30, 1000);
    
    console.log('Judge0 results received');
    
    // Step 6: Process results
    const testResults = judge0Results.map((result, index) => 
      parseJudge0Result(result, testCases[index])
    );
    
    const metrics = calculateMetrics(testResults);
    
    console.log('Metrics calculated:', metrics);
    
    // Step 7: Update submission with results
    await updateSubmissionStatus(submissionId, metrics.status, {
      passedTests: metrics.passedTests,
      totalTests: metrics.totalTests,
      score: metrics.score,
      testResults: testResults,
      totalExecutionTime: metrics.totalExecutionTime,
      averageExecutionTime: metrics.averageExecutionTime,
      maxExecutionTime: metrics.maxExecutionTime,
      totalMemory: metrics.totalMemory,
      averageMemory: metrics.averageMemory,
      maxMemory: metrics.maxMemory
    });
    
    console.log('Submission updated with results');
    
    // Step 8: Award credential if all tests passed
    let credentialAwarded = false;
    if (metrics.status === 'passed') {
      console.log('All tests passed! Checking if credential already awarded...');
      
      // TODO: Check if user already has credential for this milestone
      // For now, we'll just increment the count
      
      try {
        const user = await getUser(userId);
        if (user) {
          await updateUser(userId, {
            credentialsCount: (user.credentialsCount || 0) + 1,
            milestonesCompleted: (user.milestonesCompleted || 0) + 1
          });
          credentialAwarded = true;
          console.log('Credential awarded to user');
        }
      } catch (error) {
        console.error('Error awarding credential:', error);
        // Don't fail the submission if credential award fails
      }
    }
    
    // Step 9: Return results to user
    // Filter test results for non-admin users (hide input/output for hidden tests)
    const filteredTestResults = testResults.map(r => ({
      ...r,
      input: r.isHidden ? '[Hidden]' : r.input,
      expectedOutput: r.isHidden ? '[Hidden]' : r.expectedOutput,
      actualOutput: r.isHidden ? '[Hidden]' : r.actualOutput
    }));
    
    return successResponse(200, {
      submission: {
        submissionId,
        status: metrics.status,
        passedTests: metrics.passedTests,
        totalTests: metrics.totalTests,
        score: metrics.score,
        testResults: filteredTestResults,
        totalExecutionTime: metrics.totalExecutionTime,
        credentialAwarded: credentialAwarded
      }
    });
    
  } catch (error) {
    console.error('Error submitting code:', error);
    return errorResponse(500, 'Failed to submit code', error.message);
  }
};