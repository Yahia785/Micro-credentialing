const { createTestCasesBatch } = require('/opt/nodejs/db/testcases');
const { updateMilestone, getMilestone } = require('/opt/nodejs/db/milestones');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: Batch Create Test Cases
 * Endpoint: POST /milestones/{milestoneId}/testcases/batch
 * Authorization: Admin only
 */
exports.handler = withHandler(async (ctx) => {
  // Get milestoneId from path
  const milestoneId = ctx.pathParams.milestoneId;

  if (!milestoneId) {
    return errorResponse(400, 'Milestone ID is required');
  }

  // Check if milestone exists
  const existingMilestone = await getMilestone(milestoneId);
  if (!existingMilestone) {
    return errorResponse(404, 'Milestone not found');
  }

  // Parse request body
  const body = ctx.body;
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

  log.info('Creating test cases', { count: testCases.length, milestoneId });

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

  log.info('Test cases created', { count: createdTestCases.length });

  // Update milestone's testCaseCount
  const newTestCaseCount = (existingMilestone.testCaseCount || 0) + createdTestCases.length;
  await updateMilestone(milestoneId, {
    testCaseCount: newTestCaseCount
  });

  log.info('Updated milestone testCaseCount', { milestoneId, newTestCaseCount });

  return successResponse(201, {
    message: `${createdTestCases.length} test cases created successfully`,
    testCases: createdTestCases,
    milestoneId: milestoneId,
    totalTestCases: newTestCaseCount
  });
}, { requireAdmin: true });
