const { createKnowledgeAssessment } = require('/opt/nodejs/db/knowledge-assessments');
const { getUser } = require('/opt/nodejs/db/users');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { handleOptionsRequest } = require('/opt/nodejs/middleware/cors-middleware');

/**
 * Lambda Handler: Create Knowledge Assessment
 * Endpoint: POST /knowledge-assessments
 * Authorization: Admin only
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
      // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return handleOptionsRequest();
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
    
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    
    // Validate required fields
    if (!body.title) {
      return errorResponse(400, 'Title is required');
    }
    
    if (!body.questions || !Array.isArray(body.questions) || body.questions.length === 0) {
      return errorResponse(400, 'At least one question is required');
    }
    
    // Validate questions
    for (let i = 0; i < body.questions.length; i++) {
      const q = body.questions[i];
      
      if (!q.questionId || !q.type || !q.title || !q.question) {
        return errorResponse(400, `Question ${i + 1}: questionId, type, title, and question are required`);
      }
      
      if (q.type === 'mcq') {
        if (!q.options || !Array.isArray(q.options) || q.options.length < 2) {
          return errorResponse(400, `Question ${i + 1}: MCQ must have at least 2 options`);
        }
        if (!q.selectionType || !['single', 'multiple'].includes(q.selectionType)) {
          return errorResponse(400, `Question ${i + 1}: selectionType must be 'single' or 'multiple'`);
        }
        if (typeof q.maxPoints !== 'number' || q.maxPoints <= 0) {
          return errorResponse(400, `Question ${i + 1}: maxPoints must be a positive number`);
        }
      } else if (q.type === 'short_response') {
        if (!q.acceptedAnswers || !Array.isArray(q.acceptedAnswers) || q.acceptedAnswers.length === 0) {
          return errorResponse(400, `Question ${i + 1}: At least one accepted answer is required`);
        }
        if (typeof q.points !== 'number' || q.points <= 0) {
          return errorResponse(400, `Question ${i + 1}: points must be a positive number`);
        }
      } else {
        return errorResponse(400, `Question ${i + 1}: type must be 'mcq' or 'short_response'`);
      }
    }
    
    console.log('Creating knowledge assessment:', body.title);
    
    // Create assessment
    const assessment = await createKnowledgeAssessment({
      title: body.title,
      description: body.description || '',
      timeLimit: body.timeLimit || 30,
      passingScore: body.passingScore || 70,
      questions: body.questions,
      bcdiplomaTemplateId: body.bcdiplomaTemplateId || null
    });
    
    console.log('Knowledge assessment created:', assessment.milestoneId);
    
    return successResponse(201, {
      message: 'Knowledge assessment created successfully',
      assessment
    });
    
  } catch (error) {
    console.error('Error creating knowledge assessment:', error);
    return errorResponse(500, 'Failed to create knowledge assessment', error.message);
  }
};