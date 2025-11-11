const { createSubmission, updateSubmission } = require('/opt/nodejs/db/submissions');
const { getTestCasesByMilestone } = require('/opt/nodejs/db/testcases');
const { getMilestone } = require('/opt/nodejs/db/milestones');
const { getUser, updateUser, addCompletedMilestone } = require('/opt/nodejs/db/users');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { 
  getLanguageId, 
  submitBatch, 
  pollResults, 
  parseJudge0Result, 
  calculateMetrics 
} = require('/opt/nodejs/utils/judge0');

/**
 * Lambda Handler: Submit Code for Grading
 * Endpoint: POST /submissions/submit
 * Authorization: Any authenticated user
 * 
 * Workflow:
 * 1. Validate input (milestoneId, code, language)
 * 2. Get test cases for milestone (only those marked for Judge0)
 * 3. Submit code to Judge0 with all test cases
 * 4. Poll Judge0 for results
 * 5. Calculate score and determine if passed
 * 6. Award credential if all tests passed
 * 7. Save submission to database
 * 8. Add to user's completedMilestones if passed
 * 9. Return results (hide test details for non-admins)
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  try {
    // Get userId from JWT token (logged in user)
    const userId = event.requestContext?.authorizer?.claims?.sub;
    
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }
    
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { milestoneId, code, language } = body;
    
    // Validate required fields
    if (!milestoneId || !code || !language) {
      return errorResponse(400, 'milestoneId, code, and language are required');
    }
    
    console.log('Submission request:', { userId, milestoneId, language });
    
    // Check if milestone exists
    const milestone = await getMilestone(milestoneId);
    if (!milestone) {
      return errorResponse(404, 'Milestone not found');
    }
    
    // Get all test cases for this milestone
    const allTestCases = await getTestCasesByMilestone(milestoneId);
    
    // Filter to only test cases that should be run through Judge0
    const testCasesToRun = allTestCases.filter(tc => tc.includeInJudge0);
    
    if (testCasesToRun.length === 0) {
      return errorResponse(400, 'No test cases configured for this milestone');
    }
    
    console.log(`Running ${testCasesToRun.length} test cases through Judge0`);
    
    // Get Judge0 credentials from environment
    const judge0ApiKey = process.env.JUDGE0_API_KEY;
    const judge0ApiHost = process.env.JUDGE0_API_HOST || 'judge0-ce.p.rapidapi.com';
    
    if (!judge0ApiKey || judge0ApiKey === 'dummy-key-for-testing') {
      console.error('JUDGE0_API_KEY not configured - returning mock response');
      
      // Return a test response without calling Judge0
      const submissionId = `sub_${Date.now()}_${userId}`;
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
      
      return successResponse(200, {
        submission: mockSubmission
      });
    }
    
    // Get language ID for Judge0
    let languageId;
    try {
      languageId = getLanguageId(language);
    } catch (error) {
      return errorResponse(400, error.message);
    }
    
    // Create submission record (pending state)
    const submissionId = `sub_${Date.now()}_${userId}`;
    const submissionRecord = {
      submissionId,
      userId,
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
    console.log('Submission created:', submissionId);
    
    // Prepare Judge0 submissions (one for each test case)
    const judge0Submissions = testCasesToRun.map(testCase => ({
      source_code: code,
      language_id: languageId,
      stdin: testCase.input,
      expected_output: testCase.expectedOutput,
      cpu_time_limit: (milestone.timeLimit || 5000) / 1000, // Convert ms to seconds
      memory_limit: milestone.memoryLimit || 256000 // In KB
    }));
    
    console.log('Submitting to Judge0...');
    
    // Submit to Judge0
    let judge0Response;
    try {
      judge0Response = await submitBatch(judge0Submissions, judge0ApiKey, judge0ApiHost);
    } catch (error) {
      console.error('Judge0 submission error:', error);
      
      // Update submission with error
      await updateSubmission(submissionId, {
        status: 'error',
        errorMessage: error.message,
        updatedAt: new Date().toISOString()
      });
      
      return errorResponse(500, 'Failed to submit code to Judge0', error.message);
    }
    
    // Extract tokens from response
    const tokens = judge0Response.map(r => r.token);
    console.log('Judge0 tokens:', tokens);
    
    // Poll for results
    let judge0Results;
    try {
      judge0Results = await pollResults(tokens, judge0ApiKey, judge0ApiHost);
    } catch (error) {
      console.error('Judge0 polling error:', error);
      
      // Update submission with error
      await updateSubmission(submissionId, {
        status: 'error',
        errorMessage: error.message,
        updatedAt: new Date().toISOString()
      });
      
      return errorResponse(500, 'Failed to get results from Judge0', error.message);
    }
    
    console.log('Judge0 results received');
    
    // Parse results
    const testResults = judge0Results.map((result, index) => 
      parseJudge0Result(result, testCasesToRun[index])
    );
    
    // Calculate metrics
    const metrics = calculateMetrics(testResults);
    
    console.log('Submission metrics:', metrics);
    
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
    
    // If passed all tests, add to user's completedMilestones and update stats
    if (credentialAwarded) {
      console.log('All tests passed - adding to completed milestones');
      
      try {
        // Add to completedMilestones array
        await addCompletedMilestone(userId, {
          milestoneId: milestoneId,
          score: metrics.score,
          passedTests: metrics.passedTests,
          totalTests: metrics.totalTests,
          submissionId: submissionId
        });
        
        console.log('Added to completedMilestones');
        
        // Update user's credential and milestone counts
        const user = await getUser(userId);
        if (user) {
          await updateUser(userId, {
            credentialsCount: (user.credentialsCount || 0) + 1,
            milestonesCompleted: (user.milestonesCompleted || 0) + 1
          });
          
          console.log('Updated user stats');
        }
      } catch (error) {
        console.error('Error updating user milestones:', error);
        // Don't fail the submission if this fails
      }
    }
    
    // Check if user is admin to determine what to show
    const user = await getUser(userId);
    const isAdmin = user && user.role === 'admin';
    
    console.log('User role:', user?.role, 'Is admin:', isAdmin);
    
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
    
    // Return success response with submission details
    return successResponse(200, {
      submission: {
        submissionId: updatedSubmission.submissionId,
        status: updatedSubmission.status,
        passedTests: updatedSubmission.passedTests,
        totalTests: updatedSubmission.totalTests,
        score: updatedSubmission.score,
        testResults: formattedTestResults,
        totalExecutionTime: updatedSubmission.totalExecutionTime,
        credentialAwarded: updatedSubmission.credentialAwarded,
        isAdmin: isAdmin // Include for debugging
      }
    });
    
  } catch (error) {
    console.error('Error submitting code:', error);
    return errorResponse(500, 'Failed to submit code', error.message);
  }
};