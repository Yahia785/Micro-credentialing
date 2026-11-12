import { getAuthToken, API_BASE } from './config';
import type { LogEntry } from '../utils/proctoringLogger';
import { PART_SIZE, uploadInParts } from './multipartUpload';
import type { MultipartApi, PutPart } from './multipartUpload';

/**
 * Get presigned S3 upload URL for a recording
 */
export async function getUploadUrl(data: {
  submissionId: string;
  fileType: 'webcam' | 'screen';
}) {
  const token = await getAuthToken();

  console.log('Getting upload URL for:', data);

  const response = await fetch(`${API_BASE}/proctoring/upload-urls`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Get upload URL failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

/**
 * Upload recording blob to S3 using presigned URL with retry logic.
 * Retries up to 3 times with exponential backoff (1s, 2s, 4s) to handle
 * transient network failures like ERR_CONNECTION_RESET on large uploads.
 * Note: Metadata is already included in the presigned URL by the Lambda function.
 */
export async function uploadRecordingToS3(
  uploadUrl: string,
  blob: Blob
): Promise<void> {
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 1000;
  const sizeMB = (blob.size / 1024 / 1024).toFixed(2);

  console.log(`Uploading recording to S3, size: ${blob.size} bytes (${sizeMB} MB)`);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'video/webm',
        },
        body: blob,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`S3 upload failed! status: ${response.status} - ${errorText}`);
      }

      console.log(`Recording uploaded successfully on attempt ${attempt}`);
      return;
    } catch (err: any) {
      console.warn(
        `S3 upload attempt ${attempt}/${MAX_RETRIES} failed:`,
        err.message
      );

      if (attempt === MAX_RETRIES) {
        console.error('S3 upload failed after all retries');
        throw err;
      }

      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Save recording metadata to DynamoDB
 */
export async function saveRecordingMetadata(data: {
  submissionId: string;
  webcamKey?: string;
  screenKey?: string;
  startedAt?: string;
  completedAt?: string;
}) {
  const token = await getAuthToken();

  console.log('Saving recording metadata:', data);

  const response = await fetch(`${API_BASE}/proctoring/recording-metadata`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Save metadata failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

/**
 * Send buffered client-side proctoring logs to the backend for storage on the
 * submission record. Called after upload completes (success or failure) so
 * failures are traceable server-side.
 *
 * Never throws — telemetry must not interrupt the submission flow.
 */
export async function sendClientLogs(data: {
  submissionId: string;
  logs: LogEntry[];
}): Promise<void> {
  const token = await getAuthToken();

  const response = await fetch(`${API_BASE}/proctoring/client-logs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`sendClientLogs HTTP ${response.status}: ${errorText}`);
  }
}

/** One POST to a /proctoring/multipart/* endpoint. */
async function postMultipart<T>(action: 'create' | 'presign' | 'complete' | 'abort', data: object): Promise<T> {
  const token = await getAuthToken();

  const response = await fetch(`${API_BASE}/proctoring/multipart/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Multipart ${action} failed:`, response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

function multipartApi(submissionId: string, fileType: 'webcam' | 'screen'): MultipartApi {
  return {
    create: () => postMultipart('create', { submissionId, fileType }),
    presign: async (uploadId, partNumbers) => {
      const { urls } = await postMultipart<{ urls: Array<{ partNumber: number; url: string }> }>('presign', {
        submissionId,
        fileType,
        uploadId,
        partNumbers,
      });
      return urls;
    },
    complete: (uploadId, parts) => postMultipart('complete', { submissionId, fileType, uploadId, parts }),
    abort: async (uploadId) => {
      await postMultipart('abort', { submissionId, fileType, uploadId });
    },
  };
}

/** Sends one part with XHR (fetch cannot report upload progress). A part that stalls for 15 minutes counts as failed. */
const PART_TIMEOUT_MS = 15 * 60 * 1000;

const putPartWithXhr: PutPart = (url, body, onProgress) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.timeout = PART_TIMEOUT_MS;
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () => resolve({ status: xhr.status, etag: xhr.getResponseHeader('ETag') });
    xhr.onerror = () => reject(new Error('Network error while uploading a part'));
    xhr.ontimeout = () => reject(new Error('A part upload timed out'));
    xhr.onabort = () => reject(new Error('A part upload was cancelled'));
    xhr.send(body);
  });

/** Presigned PUT of the whole blob: the original way, used for small recordings and as the fallback. */
async function uploadSinglePut(
  submissionId: string,
  fileType: 'webcam' | 'screen',
  blob: Blob,
): Promise<string> {
  // Step 1: Get presigned upload URL (metadata set by Lambda)
  const { uploadUrl, key } = await getUploadUrl({
    submissionId,
    fileType,
  });

  // Step 2: Upload blob to S3 (metadata already in presigned URL)
  await uploadRecordingToS3(uploadUrl, blob);

  // Step 3: Return the S3 key for metadata saving
  return key;
}

/**
 * Complete workflow: Upload recording and save metadata.
 *
 * Under 8 MiB: one presigned PUT. Larger: S3 multipart upload (parts of 8 MiB, 3 at a time, each retried on its own).
 * If the multipart upload fails for any reason it is aborted and the single PUT is tried once, so the result is never
 * worse than before. Resolves with the S3 key; throws only when both ways fail.
 */
export async function uploadRecording(
  submissionId: string,
  fileType: 'webcam' | 'screen',
  blob: Blob,
): Promise<string> {
  try {
    if (blob.size < PART_SIZE) {
      return await uploadSinglePut(submissionId, fileType, blob);
    }

    try {
      const { key } = await uploadInParts(blob, multipartApi(submissionId, fileType), putPartWithXhr, {
        onRetry: ({ partNumber, attempt, reason }) =>
          console.warn(`Part ${partNumber} failed (retry ${attempt}): ${reason}`),
      });
      return key;
    } catch (multipartError) {
      console.warn('Multipart upload failed, trying a single upload instead:', multipartError);
      return await uploadSinglePut(submissionId, fileType, blob);
    }
  } catch (error) {
    console.error('Error uploading recording:', error);
    throw error;
  }
}
