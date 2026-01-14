const { createTestCasesBatch } = require('/opt/nodejs/db/testcases');
const { updateMilestone, getMilestone } = require('/opt/nodejs/db/milestones');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { CORS_HEADERS } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Batch Create Test Cases
 * Endpoint: POST /milestones/{milestoneId}/testcases/batch
 * Authorization: Admin only
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
    // Get userId from JWT token (logged in user)
    const authenticatedUserId = event.requestContext?.authorizer?.claims?.sub;
    
    if (!authenticatedUserId) {
      return errorResponse(401, 'Unauthorized');
    }
    
    // TODO: Add admin role check here
    // For now, we'll allow any authenticated user to create test cases
    // In production, you should check if the user has an 'admin' role
    
    // Get milestoneId from path
    const milestoneId = event.pathParameters?.milestoneId;
    
    if (!milestoneId) {
      return errorResponse(400, 'Milestone ID is required');
    }
    
    // Check if milestone exists
    const existingMilestone = await getMilestone(milestoneId);
    if (!existingMilestone) {
      return errorResponse(404, 'Milestone not found');
    }
    
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const testCases = body.testCases;
    
    if (!testCases || !Array.isArray(testCases) || testCases.length === 0) {
      return errorResponse(400, 'testCases array is required and must not be empty');
    }
    
    // Validate each test case
    for (let i = 0; i < testCases.length; i++) {
      const tc = testCases[i];
      if (!tc.input || tc.expectedOutput === undefined) {
        return errorResponse(400, `Test case at index ${i} is missing required fields: input, expectedOutput`);
      }
    }
    
    console.log(`Creating ${testCases.length} test cases for milestone:`, milestoneId);
    
    // Add milestoneId to each test case
    const testCasesWithMilestoneId = testCases.map((tc, index) => ({
      milestoneId: milestoneId,
      input: tc.input,
      expectedOutput: tc.expectedOutput,
      isHidden: tc.isHidden !== undefined ? tc.isHidden : false,
      includeInJudge0: tc.includeInJudge0 !== undefined ? tc.includeInJudge0 : true,
      weight: tc.weight || 1,
      order: tc.order !== undefined ? tc.order : index,
      testTier: tc.testTier || 'standard'
    }));
    
    // Create test cases in batch
    const createdTestCases = await createTestCasesBatch(testCasesWithMilestoneId);
    
    console.log(`Created ${createdTestCases.length} test cases`);
    
    // Update milestone's testCaseCount
    const newTestCaseCount = (existingMilestone.testCaseCount || 0) + createdTestCases.length;
    await updateMilestone(milestoneId, {
      testCaseCount: newTestCaseCount
    });
    
    console.log(`Updated milestone testCaseCount to ${newTestCaseCount}`);
    
    return successResponse(201, {
      message: `${createdTestCases.length} test cases created successfully`,
      testCases: createdTestCases,
      milestoneId: milestoneId,
      totalTestCases: newTestCaseCount
    });
    
  } catch (error) {
    console.error('Error creating test cases:', error);
    return errorResponse(500, 'Failed to create test cases', error.message);
  }
};