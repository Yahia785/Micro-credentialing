const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');

// Initialize S3 client
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });

// S3 bucket name from environment variable
const BUCKET_NAME = process.env.PROCTORING_BUCKET_NAME || 'micro-credentialing-proctoring-recordings';

/**
 * Lambda Handler: Generate Presigned Upload URLs
 * Endpoint: POST /proctoring/upload-urls
 * Authorization: Authenticated users only
 * 
 * Request Body:
 * {
 *   submissionId: "sub_123",
 *   fileType: "webcam" | "screen" | "audio" | "environment-scan" | "screen-verification",
 *   chunkIndex: 0 (optional, for chunked uploads)
 * }
 * 
 * Response:
 * {
 *   uploadUrl: "https://s3.amazonaws.com/...",
 *   key: "recordings/user123/sub_456/webcam-chunk-0.webm",
 *   expiresIn: 1800
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
    const { submissionId, fileType, chunkIndex } = body;
    
    // Validate required fields
    if (!submissionId) {
      return errorResponse(400, 'submissionId is required');
    }
    
    if (!fileType) {
      return errorResponse(400, 'fileType is required');
    }
    
    // Validate fileType
    const validFileTypes = ['webcam', 'screen', 'audio', 'environment-scan', 'screen-verification'];
    if (!validFileTypes.includes(fileType)) {
      return errorResponse(400, `fileType must be one of: ${validFileTypes.join(', ')}`);
    }
    
    // Generate S3 key (file path)
    let s3Key;
    if (chunkIndex !== undefined && chunkIndex !== null) {
      // Chunked upload: recordings/userId/submissionId/fileType-chunk-0.webm
      s3Key = `recordings/${userId}/${submissionId}/${fileType}-chunk-${chunkIndex}.webm`;
    } else {
      // Single file upload: recordings/userId/submissionId/fileType.webm
      s3Key = `recordings/${userId}/${submissionId}/${fileType}.webm`;
    }
    
    console.log('Generating presigned URL for:', {
      userId,
      submissionId,
      fileType,
      chunkIndex,
      s3Key
    });
    
    // Create S3 PutObject command
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      ContentType: 'video/webm', // For video/audio files
    });
    
    // Generate presigned URL (valid for 30 minutes)
    const expiresIn = 1800; // 30 minutes in seconds
    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn });
    
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