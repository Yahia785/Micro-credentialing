const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { getSubmission } = require('/opt/nodejs/db/submissions');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

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
exports.handler = withHandler(async (ctx) => {
  // Get submissionId from path
  const submissionId = ctx.pathParams.submissionId;

  if (!submissionId) {
    return errorResponse(400, 'Submission ID is required');
  }

  log.info('Getting recording URLs', { submissionId });

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
    log.info('Generating presigned URL for webcam', { s3Key: recordings.webcam.s3Key });

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
    log.info('Generating presigned URL for screen', { s3Key: recordings.screen.s3Key });

    const screenCommand = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: recordings.screen.s3Key
    });

    urls.screen = await getSignedUrl(s3Client, screenCommand, {
      expiresIn: 3600 // 1 hour
    });
  }

  log.info('Presigned URLs generated successfully', { submissionId });

  return successResponse(200, {
    submissionId: submissionId,
    urls: urls,
    expiresIn: 3600,
    recordings: {
      webcam: recordings.webcam || null,
      screen: recordings.screen || null
    }
  });
}, { requireAdmin: true });
