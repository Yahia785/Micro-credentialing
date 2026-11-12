const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');
const {
  BUCKET_NAME,
  MAX_PART_NUMBER,
  MAX_PARTS_PER_PRESIGN,
  PRESIGN_EXPIRES_IN,
  UploadPartCommand,
  getSignedUrl,
  getS3Client,
  readUploadRequest,
  isPartNumber,
} = require('/opt/nodejs/utils/multipart');

/**
 * Lambda Handler: Presigned URLs for the parts of a multipart upload
 * Endpoint: POST /proctoring/multipart/presign
 * Authorization: Authenticated users only
 *
 * Request Body:  { submissionId, fileType, uploadId, partNumbers: [1, 2, 3] }   (1 to 20 numbers, each 1 to 10000)
 * Response:      { urls: [{ partNumber, url }], expiresIn: 3600 }
 */
exports.handler = withHandler(async (ctx) => {
  const request = readUploadRequest(ctx);
  if (request.error) return request.error;
  const { userId, submissionId, fileType, uploadId, key } = request;

  const { partNumbers } = ctx.body;
  if (!Array.isArray(partNumbers) || partNumbers.length === 0) {
    return errorResponse(400, 'partNumbers must be a non-empty array');
  }
  if (partNumbers.length > MAX_PARTS_PER_PRESIGN) {
    return errorResponse(400, `partNumbers can have at most ${MAX_PARTS_PER_PRESIGN} entries`);
  }
  if (!partNumbers.every(isPartNumber)) {
    return errorResponse(400, `Each part number must be a whole number from 1 to ${MAX_PART_NUMBER}`);
  }

  log.info('Presigning upload parts', { userId, submissionId, fileType, parts: partNumbers.length });

  const s3 = getS3Client();
  const urls = await Promise.all(
    [...new Set(partNumbers)].map(async (partNumber) => ({
      partNumber,
      // No checksum or content headers are signed, so the browser can send the part as it is.
      url: await getSignedUrl(
        s3,
        new UploadPartCommand({ Bucket: BUCKET_NAME, Key: key, UploadId: uploadId, PartNumber: partNumber }),
        { expiresIn: PRESIGN_EXPIRES_IN }
      ),
    }))
  );

  return successResponse(200, { urls, expiresIn: PRESIGN_EXPIRES_IN });
});
