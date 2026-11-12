const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const log = require('/opt/nodejs/utils/logger');
const {
  BUCKET_NAME,
  PART_SIZE,
  CreateMultipartUploadCommand,
  getS3Client,
  readUploadRequest,
} = require('/opt/nodejs/utils/multipart');

/**
 * Lambda Handler: Start a multipart upload of a recording
 * Endpoint: POST /proctoring/multipart/create
 * Authorization: Authenticated users only
 *
 * Request Body:  { submissionId: "sub_123", fileType: "webcam" | "screen" }
 * Response:      { uploadId, key: "recordings/{userId}/{submissionId}/webcam.webm", partSize: 8388608 }
 *
 * The key is built here from the caller's user ID; the client never sends one.
 */
exports.handler = withHandler(async (ctx) => {
  const request = readUploadRequest(ctx, { needUploadId: false });
  if (request.error) return request.error;
  const { userId, submissionId, fileType, key, contentType } = request;

  log.info('Starting multipart upload', { userId, submissionId, fileType, key });

  // Same metadata as the single-PUT upload.
  const created = await getS3Client().send(
    new CreateMultipartUploadCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: contentType,
      Metadata: {
        'uploaded-by': userId,
        'submission-id': submissionId,
        'file-type': fileType,
        'uploaded-at': new Date().toISOString(),
      },
    })
  );

  return successResponse(200, { uploadId: created.UploadId, key, partSize: PART_SIZE });
});
