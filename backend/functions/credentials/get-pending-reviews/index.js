const { getPendingReviews } = require('/opt/nodejs/db/proctoring-reviews');
const { getUser } = require('/opt/nodejs/db/users');
const { getMilestone } = require('/opt/nodejs/db/milestones');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { CORS_HEADERS } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Get Pending Proctoring Reviews
 * Endpoint: GET /proctoring/pending-reviews
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
    
    console.log('Fetching pending reviews...');
    
    const filter = event.queryStringParameters?.filter || 'all'; // 'passed', 'failed', or 'all'

    // Get all submissions pending review
    const pendingSubmissions = await getPendingReviews(100, filter);
    
    // Enrich with milestone and user information
    const enrichedSubmissions = await Promise.all(
      pendingSubmissions.map(async (submission) => {
        const milestone = await getMilestone(submission.milestoneId);
        const submitter = await getUser(submission.userId);
        
        return {
          ...submission,
          problemTitle: milestone?.title || 'Unknown Problem',
          studentName: submitter?.name || 'Unknown Student',
          studentEmail: submitter?.email || 'Unknown Email',
          milestoneType: submission.type || 'coding',
          rubricResults: submission.rubricResults || [],
          passedCriteria: submission.passedCriteria || 0,
          totalCriteria: submission.totalCriteria || 0
        };
      })
    );
    
    console.log(`Found ${enrichedSubmissions.length} pending reviews`);
    
    return successResponse(200, {
      submissions: enrichedSubmissions,
      count: enrichedSubmissions.length
    });
    
  } catch (error) {
    console.error('Error getting pending reviews:', error);
    return errorResponse(500, 'Failed to get pending reviews', error.message);
  }
};