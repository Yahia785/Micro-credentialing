const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { getUser } = require('/opt/nodejs/db/users');
const { getSubmission } = require('/opt/nodejs/db/submissions');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { CORS_HEADERS } = require('/opt/nodejs/utils/errors');

// Initialize S3 client
const s3Client = new S3Client({ 
  region: process.env.AWS_REGION || 'us-east-1'
});

const BUCKET_NAME = process.env.PROCTORING_BUCKET_NAME || 'micro-credentialing-recordings';

/**
 * Lambda Handler: Get Presigned URLs for Proctoring Recordings
 * Endpoint: GET /proctoring/recording-urls/{submissionId}
 * Authorization: Admin only
 * 
 * Returns presigned URLs for webcam and screen recordings
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
    
    // Get submissionId from path
    const submissionId = event.pathParameters?.submissionId;
    
    if (!submissionId) {
      return errorResponse(400, 'Submission ID is required');
    }
    
    console.log('Getting recording URLs for submission:', submissionId);
    
    // Get submission
    const submission = await getSubmission(submissionId);
    
    if (!submission) {
      return errorResponse(404, 'Submission not found');
    }
    
    // Check if submission has proctoring data
    if (!submission.proctoringData || !submission.proctoringData.recordings) {
      return errorResponse(404, 'No proctoring recordings found for this submission');
    }
    
    const recordings = submission.proctoringData.recordings;
    const urls = {};
    
    // Generate presigned URL for webcam recording
    if (recordings.webcam && recordings.webcam.s3Key) {
      console.log('Generating presigned URL for webcam:', recordings.webcam.s3Key);
      
      const webcamCommand = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: recordings.webcam.s3Key
      });
      
      urls.webcam = await getSignedUrl(s3Client, webcamCommand, { 
        expiresIn: 3600 // 1 hour
      });
    }
    
    // Generate presigned URL for screen recording
    if (recordings.screen && recordings.screen.s3Key) {
      console.log('Generating presigned URL for screen:', recordings.screen.s3Key);
      
      const screenCommand = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: recordings.screen.s3Key
      });
      
      urls.screen = await getSignedUrl(s3Client, screenCommand, { 
        expiresIn: 3600 // 1 hour
      });
    }
    
    console.log('Presigned URLs generated successfully');
    
    return successResponse(200, {
      submissionId: submissionId,
      urls: urls,
      expiresIn: 3600,
      recordings: {
        webcam: recordings.webcam || null,
        screen: recordings.screen || null
      }
    });
    
  } catch (error) {
    console.error('Error getting recording URLs:', error);
    return errorResponse(500, 'Failed to get recording URLs', error.message);
  }
};