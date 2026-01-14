const { createMilestone } = require('/opt/nodejs/db/milestones');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { CORS_HEADERS } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Create Milestone (Problem)
 * Endpoint: POST /milestones
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
    // For now, we'll allow any authenticated user to create milestones
    // In production, you should check if the user has an 'admin' role
    
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    
    // Validate required fields
    if (!body.title || !body.description) {
      return errorResponse(400, 'Title and description are required');
    }
    
    // Validate difficulty level
    const validDifficulties = ['easy', 'medium', 'hard'];
    if (body.difficulty && !validDifficulties.includes(body.difficulty)) {
      return errorResponse(400, 'Difficulty must be one of: easy, medium, hard');
    }
    
    // Validate language (optional but if provided, must be valid)
    const validLanguages = ['python', 'javascript', 'java', 'cpp', 'c'];
    if (body.language && !validLanguages.includes(body.language)) {
      return errorResponse(400, 'Language must be one of: python, javascript, java, cpp, c');
    }
    
    console.log('Creating milestone:', body);
    
    // Create milestone with ALL fields
    const milestone = await createMilestone({
      title: body.title,
      description: body.description,
      concept: body.concept || '',
      difficulty: body.difficulty || 'medium',
      language: body.language || 'python',
      starterCode: body.starterCode || '',
      timeLimit: body.timeLimit || 5000,
      memoryLimit: body.memoryLimit || 256000,
      bcdiplomaTemplateId: body.bcdiplomaTemplateId
    });
    
    console.log('Milestone created:', milestone);
    
    return successResponse(201, {
      message: 'Milestone created successfully',
      milestone: milestone
    });
    
  } catch (error) {
    console.error('Error creating milestone:', error);
    return errorResponse(500, 'Failed to create milestone', error.message);
  }
};