const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');

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
 *   fileType: "webcam" | "screen"
 * }
 * 
 * Response:
 * {
 *   uploadUrl: "https://s3.amazonaws.com/...",
 *   key: "recordings/user123/sub_456/webcam.webm",
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
    const { submissionId, fileType } = body;
    
    // Validate required fields
    if (!submissionId) {
      return errorResponse(400, 'submissionId is required');
    }
    
    if (!fileType) {
      return errorResponse(400, 'fileType is required');
    }
    
    // Validate fileType
    const validFileTypes = ['webcam', 'screen'];
    if (!validFileTypes.includes(fileType)) {
      return errorResponse(400, `fileType must be one of: ${validFileTypes.join(', ')}`);
    }
    
    // Generate S3 key (file path)
    const s3Key = `recordings/${userId}/${submissionId}/${fileType}.webm`;
    
    console.log('Generating presigned URL for:', {
      userId,
      submissionId,
      fileType,
      s3Key
    });
    
    // Create S3 PutObject command with metadata
    // IMPORTANT: ChecksumAlgorithm must NOT be set to avoid signature issues
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      ContentType: 'video/webm',
      Metadata: {
        'uploaded-by': userId,
        'submission-id': submissionId,
        'file-type': fileType,
        'uploaded-at': new Date().toISOString()
      }
      // DO NOT set ChecksumAlgorithm - it causes signature mismatches with browsers
    });
    
    // Generate presigned URL (valid for 30 minutes)
    // Do NOT add unhoistableHeaders or signableHeaders
    const expiresIn = 1800; // 30 minutes in seconds
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