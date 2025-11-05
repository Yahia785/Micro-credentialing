const { getTestCasesByMilestone } = require('/opt/nodejs/db/testcases');
const { getMilestone } = require('/opt/nodejs/db/milestones');
const { getUser } = require('/opt/nodejs/db/users');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Get Test Cases for a Milestone
 * Endpoint: GET /milestones/{milestoneId}/testcases
 * Authorization: Any authenticated user
 * 
 * - Admins see all test cases
 * - Regular users see only non-hidden test cases
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  try {
    // Get userId from JWT token (logged in user)
    const authenticatedUserId = event.requestContext?.authorizer?.claims?.sub;
    
    if (!authenticatedUserId) {
      return errorResponse(401, 'Unauthorized');
    }
    
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
    
    console.log('Fetching test cases for milestone:', milestoneId);
    
    // Get all test cases for the milestone
    const allTestCases = await getTestCasesByMilestone(milestoneId);
    
    // Check if user is admin
    const user = await getUser(authenticatedUserId);
    const isAdmin = user && user.role === 'admin';
    
    console.log('User role:', user?.role, 'Is admin:', isAdmin);
    
    // Filter test cases based on user role
    let testCases;
    if (isAdmin) {
      // Admins see all test cases
      testCases = allTestCases;
    } else {
      // Regular users see only non-hidden test cases
      testCases = allTestCases.filter(tc => !tc.isHidden);
    }
    
    // Sort by order
    testCases.sort((a, b) => (a.order || 0) - (b.order || 0));
    
    console.log(`Returning ${testCases.length} test cases (${allTestCases.length} total)`);
    
    return successResponse(200, {
      testCases: testCases,
      count: testCases.length,
      totalCount: allTestCases.length,
      milestoneId: milestoneId,
      isAdmin: isAdmin // Include in response for debugging
    });
    
  } catch (error) {
    console.error('Error getting test cases:', error);
    return errorResponse(500, 'Failed to get test cases', error.message);
  }
};