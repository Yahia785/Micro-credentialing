import { getAuthToken, API_BASE } from './config';
import type { LogEntry } from '../utils/proctoringLogger';

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
 * Upload recording blob to S3 using presigned URL
 * Note: Metadata is already included in the presigned URL by the Lambda function
 */
export async function uploadRecordingToS3(
  uploadUrl: string,
  blob: Blob
): Promise<void> {
  console.log('Uploading recording to S3, size:', blob.size);

  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/webm',
    },
    body: blob,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('S3 upload failed:', response.status, errorText);
    throw new Error(`S3 upload failed! status: ${response.status}`);
  }

  console.log('Recording uploaded successfully');
}

/**
 * Save recording metadata to DynamoDB
 */
export async function saveRecordingMetadata(data: {
  submissionId: string;
  webcamKey?: string;
  screenKey?: string;
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

/**
 * Complete workflow: Upload recording and save metadata
 */
export async function uploadRecording(
  submissionId: string,
  fileType: 'webcam' | 'screen',
  blob: Blob,
): Promise<string> {
  try {
    // Step 1: Get presigned upload URL (metadata set by Lambda)
    const { uploadUrl, key } = await getUploadUrl({
      submissionId,
      fileType,
    });

    // Step 2: Upload blob to S3 (metadata already in presigned URL)
    await uploadRecordingToS3(uploadUrl, blob);

    // Step 3: Return the S3 key for metadata saving
    return key;
  } catch (error) {
    console.error('Error uploading recording:', error);
    throw error;
  }
}