const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const log = require('/opt/nodejs/utils/logger');
const {
  BUCKET_NAME,
  AbortMultipartUploadCommand,
  getS3Client,
  readUploadRequest,
  isNoSuchUpload,
} = require('/opt/nodejs/utils/multipart');

/**
 * Lambda Handler: Cancel a multipart upload and free its stored parts
 * Endpoint: POST /proctoring/multipart/abort
 * Authorization: Authenticated users only
 *
 * Request Body:  { submissionId, fileType, uploadId }
 * Response:      { aborted: true }   (also when the upload is already gone)
 */
exports.handler = withHandler(async (ctx) => {
  const request = readUploadRequest(ctx);
  if (request.error) return request.error;
  const { userId, submissionId, fileType, uploadId, key } = request;

  log.info('Aborting multipart upload', { userId, submissionId, fileType });

  try {
    await getS3Client().send(new AbortMultipartUploadCommand({ Bucket: BUCKET_NAME, Key: key, UploadId: uploadId }));
  } catch (error) {
    // Already aborted or completed: nothing is left to clean up.
    if (!isNoSuchUpload(error)) throw error;
    log.info('Upload already gone on abort', { submissionId, fileType });
  }

  return successResponse(200, { aborted: true });
});
