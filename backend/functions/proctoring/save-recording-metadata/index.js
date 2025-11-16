const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');

// Initialize DynamoDB client
const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const dynamodb = DynamoDBDocumentClient.from(client);

const SUBMISSIONS_TABLE = process.env.SUBMISSIONS_TABLE;

/**
 * Lambda Handler: Save Recording Metadata (SIMPLIFIED)
 * Endpoint: POST /proctoring/recording-metadata
 * Authorization: Authenticated users only
 * 
 * Request Body:
 * {
 *   submissionId: "sub_123",
 *   webcamKey: "recordings/user_456/sub_123/webcam.webm",
 *   screenKey: "recordings/user_456/sub_123/screen.webm",
 *   startedAt: "2024-01-15T10:30:00Z",
 *   completedAt: "2024-01-15T10:50:00Z"
 * }
 * 
 * Response:
 * {
 *   message: "Recording metadata saved successfully",
 *   submissionId: "sub_123"
 * }
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  try {
    // Get userId from JWT token (authenticated user)
    const userId = event.requestContext?.authorizer?.claims?.sub;
    
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }
    
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { 
      submissionId, 
      webcamKey,
      screenKey,
      startedAt,
      completedAt
    } = body;
    
    // Validate required fields
    if (!submissionId) {
      return errorResponse(400, 'submissionId is required');
    }
    
    if (!webcamKey && !screenKey) {
      return errorResponse(400, 'At least one recording (webcamKey or screenKey) is required');
    }
    
    console.log('Saving recording metadata for submission:', submissionId);
    
    // Verify the submission exists and belongs to this user
    const getParams = {
      TableName: SUBMISSIONS_TABLE,
      Key: { submissionId }
    };
    
    const existingSubmission = await dynamodb.send(new GetCommand(getParams));
    
    if (!existingSubmission.Item) {
      return errorResponse(404, 'Submission not found');
    }
    
    // Security check: only allow user to update their own submission
    if (existingSubmission.Item.userId !== userId) {
      return errorResponse(403, 'Forbidden: You can only update your own submissions');
    }
    
    // Build simplified proctoring data
    const bucketName = process.env.PROCTORING_BUCKET_NAME || 'micro-credentialing-recordings';
    const recordings = {};
    
    if (webcamKey) {
      recordings.webcam = {
        s3Key: webcamKey,
        s3Bucket: bucketName,
        uploadedAt: new Date().toISOString()
      };
    }
    
    if (screenKey) {
      recordings.screen = {
        s3Key: screenKey,
        s3Bucket: bucketName,
        uploadedAt: new Date().toISOString()
      };
    }
    
    const proctoringData = {
      recordings: recordings,
      startedAt: startedAt || new Date().toISOString(),
      completedAt: completedAt || new Date().toISOString(),
      reviewStatus: 'pending',
      reviewedBy: null,
      reviewedAt: null,
      reviewNotes: ''
    };
    
    // Update submission with proctoring data
    const updateParams = {
      TableName: SUBMISSIONS_TABLE,
      Key: { submissionId },
      UpdateExpression: 'SET proctoringData = :proctoringData, updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':proctoringData': proctoringData,
        ':updatedAt': new Date().toISOString()
      },
      ReturnValues: 'ALL_NEW'
    };
    
    const result = await dynamodb.send(new UpdateCommand(updateParams));
    
    console.log('Recording metadata saved successfully');
    
    return successResponse(200, {
      message: 'Recording metadata saved successfully',
      submissionId: submissionId,
      proctoringData: result.Attributes.proctoringData
    });
    
  } catch (error) {
    console.error('Error saving recording metadata:', error);
    return errorResponse(500, 'Failed to save recording metadata', error.message);
  }
};