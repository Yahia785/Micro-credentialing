const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');
const {
  BUCKET_NAME,
  MAX_PART_NUMBER,
  CompleteMultipartUploadCommand,
  HeadObjectCommand,
  getS3Client,
  readUploadRequest,
  isPartNumber,
  isNoSuchUpload,
} = require('/opt/nodejs/utils/multipart');

/**
 * Lambda Handler: Finish a multipart upload
 * Endpoint: POST /proctoring/multipart/complete
 * Authorization: Authenticated users only
 *
 * Request Body:  { submissionId, fileType, uploadId, parts: [{ partNumber, etag }] }
 * Response:      { key, size }
 *
 * Safe to retry: when S3 no longer knows the upload because an earlier call already finished it, the object that is
 * there is returned as a success.
 */
exports.handler = withHandler(async (ctx) => {
  const request = readUploadRequest(ctx);
  if (request.error) return request.error;
  const { userId, submissionId, fileType, uploadId, key } = request;

  const { parts } = ctx.body;
  if (!Array.isArray(parts) || parts.length === 0) {
    return errorResponse(400, 'parts must be a non-empty array');
  }
  if (parts.length > MAX_PART_NUMBER) {
    return errorResponse(400, `parts can have at most ${MAX_PART_NUMBER} entries`);
  }
  const valid = parts.every(
    (part) => part && isPartNumber(part.partNumber) && typeof part.etag === 'string' && part.etag.length > 0 && part.etag.length <= 256
  );
  if (!valid) {
    return errorResponse(400, 'Each part needs a partNumber from 1 to 10000 and an etag');
  }
  const numbers = parts.map((part) => part.partNumber);
  if (new Set(numbers).size !== numbers.length) {
    return errorResponse(400, 'Each part number can appear only once');
  }

  // S3 wants the parts in ascending order.
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);

  log.info('Completing multipart upload', { userId, submissionId, fileType, parts: sorted.length });

  const s3 = getS3Client();
  try {
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: sorted.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) },
      })
    );
  } catch (error) {
    if (!isNoSuchUpload(error)) throw error;
    // Either an earlier call already completed it (a retry), or the upload was aborted. The object tells which.
    log.info('Upload not found on complete, checking for the finished object', { submissionId, fileType });
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
      return successResponse(200, { key, size: head.ContentLength });
    } catch (headError) {
      if (headError.name === 'NotFound' || headError.name === 'NoSuchKey' || headError.$metadata?.httpStatusCode === 404) {
        return errorResponse(404, 'This upload was not found. Start the upload again.');
      }
      throw headError;
    }
  }

  const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
  return successResponse(200, { key, size: head.ContentLength });
});
