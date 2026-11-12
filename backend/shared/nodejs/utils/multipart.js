/**
 * Shared parts of the four multipart upload endpoints (create, presign, complete, abort) for proctoring recordings.
 *
 * The S3 key is ALWAYS built here from the caller's own user ID, the submission ID and the file type. It is never read
 * from the request, so a caller can only ever write under recordings/{their own userId}/.
 */
const {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { errorResponse } = require('./errors');

const BUCKET_NAME = process.env.PROCTORING_BUCKET_NAME || 'micro-credentialing-recordings';

/** 8 MiB. S3 needs at least 5 MiB for every part except the last. */
const PART_SIZE = 8 * 1024 * 1024;
const MAX_PART_NUMBER = 10000;
const MAX_PARTS_PER_PRESIGN = 20;
/** One hour, so a slow connection can finish a part before its URL expires. */
const PRESIGN_EXPIRES_IN = 3600;

// The same list the single-upload endpoint accepts. Screenshots are single small images with their own key, so they
// are not uploaded in parts.
const VALID_FILE_TYPES = ['webcam', 'screen', 'screenshot'];
const MULTIPART_FILE_TYPES = ['webcam', 'screen'];

let client;
/**
 * WHEN_REQUIRED: the SDK's default checksum headers end up in presigned URLs and break browser uploads (signature mismatch).
 */
function getS3Client() {
  if (!client) {
    client = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  return client;
}

/** The key of a recording, same layout as POST /proctoring/upload-urls. */
function buildKey(userId, submissionId, fileType) {
  return `recordings/${userId}/${submissionId}/${fileType}.webm`;
}

/**
 * Checks submissionId, fileType and uploadId (when `needUploadId`) and builds the key.
 * @returns {{ error: object } | { userId, submissionId, fileType, uploadId, key, contentType }}
 */
function readUploadRequest(ctx, { needUploadId = true } = {}) {
  const { submissionId, fileType, uploadId } = ctx.body || {};

  if (!submissionId) return { error: errorResponse(400, 'submissionId is required') };
  // The ID becomes part of the key, so only plain characters are allowed (no slashes or dots).
  if (typeof submissionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(submissionId)) {
    return { error: errorResponse(400, 'submissionId is not valid') };
  }

  if (!fileType) return { error: errorResponse(400, 'fileType is required') };
  if (!VALID_FILE_TYPES.includes(fileType)) {
    return { error: errorResponse(400, `fileType must be one of: ${VALID_FILE_TYPES.join(', ')}`) };
  }
  if (!MULTIPART_FILE_TYPES.includes(fileType)) {
    return { error: errorResponse(400, `fileType ${fileType} cannot be uploaded in parts`) };
  }

  if (needUploadId) {
    if (!uploadId) return { error: errorResponse(400, 'uploadId is required') };
    if (typeof uploadId !== 'string' || uploadId.length > 2048) {
      return { error: errorResponse(400, 'uploadId is not valid') };
    }
  }

  return {
    userId: ctx.userId,
    submissionId,
    fileType,
    uploadId,
    key: buildKey(ctx.userId, submissionId, fileType),
    contentType: 'video/webm',
  };
}

const isPartNumber = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_PART_NUMBER;

/** S3 says an upload is gone (aborted, or already completed) with this error. */
const isNoSuchUpload = (err) => err && (err.name === 'NoSuchUpload' || err.Code === 'NoSuchUpload');

module.exports = {
  // The SDK is imported here, in the layer, so the four handlers need no packages of their own.
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
  getSignedUrl,
  BUCKET_NAME,
  PART_SIZE,
  MAX_PART_NUMBER,
  MAX_PARTS_PER_PRESIGN,
  PRESIGN_EXPIRES_IN,
  getS3Client,
  buildKey,
  readUploadRequest,
  isPartNumber,
  isNoSuchUpload,
};
