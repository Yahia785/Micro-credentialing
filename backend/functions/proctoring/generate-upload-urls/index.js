const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const { CORS_HEADERS } = require('/opt/nodejs/utils/errors');

// Initialize S3 client
const s3Client = new S3Client({ 
  region: process.env.AWS_REGION || 'us-east-1'
});

// S3 bucket name from environment variable
const BUCKET_NAME = process.env.PROCTORING_BUCKET_NAME || 'micro-credentialing-recordings';

/**
 * Lambda Handler: Generate Presigned Upload URLs
 * Endpoint: POST /proctoring/upload-urls
 * Authorization: Authenticated users only
 * 
 * Request Body:
 * {
 *   submissionId: "sub_123",
 *   fileType: "webcam" | "screen" | "screenshot",
 *   timestamp?: "1707478200000"  // Required for screenshots (milliseconds since epoch)
 * }
 * 
 * Response:
 * {
 *   uploadUrl: "https://s3.amazonaws.com/...",
 *   key: "recordings/user123/sub_456/webcam.webm" OR "screenshots/sub_456/1707478200000.jpg",
 *   expiresIn: 1800
 * }
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
    // Get userId from JWT token (authenticated user)
    const userId = event.requestContext?.authorizer?.claims?.sub;
    
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }
    
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { submissionId, fileType, timestamp } = body;
    
    // Validate required fields
    if (!submissionId) {
      return errorResponse(400, 'submissionId is required');
    }
    
    if (!fileType) {
      return errorResponse(400, 'fileType is required');
    }
    
    // Validate fileType
    const validFileTypes = ['webcam', 'screen', 'screenshot'];
    if (!validFileTypes.includes(fileType)) {
      return errorResponse(400, `fileType must be one of: ${validFileTypes.join(', ')}`);
    }
    
    // Validate timestamp for screenshots
    if (fileType === 'screenshot' && !timestamp) {
      return errorResponse(400, 'timestamp is required for screenshot uploads');
    }
    
    // Generate S3 key (file path) and content type based on fileType
    let s3Key;
    let contentType;
    
    if (fileType === 'webcam') {
      // Webcam videos: recordings/{userId}/{submissionId}/webcam.webm
      s3Key = `recordings/${userId}/${submissionId}/webcam.webm`;
      contentType = 'video/webm';
    } 
    else if (fileType === 'screen') {
      // Screen recordings: recordings/{userId}/{submissionId}/screen.webm
      // NOTE: This will be deprecated in Phase 3, but keeping for backward compatibility
      s3Key = `recordings/${userId}/${submissionId}/screen.webm`;
      contentType = 'video/webm';
    } 
    else if (fileType === 'screenshot') {
      // Screenshots: screenshots/{submissionId}/{timestamp}.jpg
      // Note: No userId in path - screenshots are organized by submission only
      s3Key = `screenshots/${submissionId}/${timestamp}.jpg`;
      contentType = 'image/jpeg';
    }
    
    console.log('Generating presigned URL for:', {
      userId,
      submissionId,
      fileType,
      timestamp: timestamp || 'N/A',
      s3Key
    });
    
    // Create S3 PutObject command with metadata
    // IMPORTANT: ChecksumAlgorithm must NOT be set to avoid signature issues
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      ContentType: contentType,
      Metadata: {
        'uploaded-by': userId,
        'submission-id': submissionId,
        'file-type': fileType,
        'uploaded-at': new Date().toISOString(),
        ...(timestamp && { 'timestamp': timestamp }) // Add timestamp for screenshots
      }
      // DO NOT set ChecksumAlgorithm - it causes signature mismatches with browsers
    });
    
    // Generate presigned URL (valid for 30 minutes for videos, 5 minutes for screenshots)
    // Shorter expiry for screenshots since they're uploaded immediately
    const expiresIn = fileType === 'screenshot' ? 300 : 1800; // 5 min for screenshots, 30 min for videos
    const uploadUrl = await getSignedUrl(s3Client, command, { 
      expiresIn
    });
    
    console.log('Presigned URL generated successfully');
    
    // Return upload URL to frontend
    return successResponse(200, {
      uploadUrl: uploadUrl,
      key: s3Key,
      bucket: BUCKET_NAME,
      expiresIn: expiresIn,
      expiresAt: new Date(Date.now() + (expiresIn * 1000)).toISOString()
    });
    
  } catch (error) {
    console.error('Error generating presigned URL:', error);
    return errorResponse(500, 'Failed to generate upload URL', error.message);
  }
};