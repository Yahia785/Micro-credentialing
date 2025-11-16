import { useState } from 'react';
import { getUploadUrl, uploadRecordingToS3, saveRecordingMetadata } from '../../api/proctoring';

interface UploadProgress {
  webcam: number;  // 0-100
  screen: number;  // 0-100
}

interface UploadManagerProps {
  submissionId: string;
  webcamBlob: Blob | null;
  screenBlob: Blob | null;
  startedAt: string;
  onComplete: () => void;
  onError: (error: string) => void;
}

export function UploadManager({
  submissionId,
  webcamBlob,
  screenBlob,
  startedAt,
  onComplete,
  onError
}: UploadManagerProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState<UploadProgress>({ webcam: 0, screen: 0 });
  const [status, setStatus] = useState<string>('Ready to upload');
  const [uploadedKeys, setUploadedKeys] = useState<{ webcam?: string; screen?: string }>({});

  const startUpload = async () => {
    if (!webcamBlob && !screenBlob) {
      onError('No recordings to upload');
      return;
    }

    setIsUploading(true);
    setStatus('Starting upload...');

    try {
      const completedAt = new Date().toISOString();
      const keys: { webcam?: string; screen?: string } = {};

      // Upload webcam recording
      if (webcamBlob) {
        setStatus('Uploading webcam recording...');
        console.log('📤 Uploading webcam recording:', webcamBlob.size, 'bytes');

        // Get presigned URL (metadata set server-side)
        const { uploadUrl, key } = await getUploadUrl({
          submissionId,
          fileType: 'webcam'
        });

        console.log('✅ Got upload URL for webcam');

        // Upload to S3 (metadata already in presigned URL)
        await uploadRecordingToS3(uploadUrl, webcamBlob);
        
        console.log('✅ Webcam uploaded to S3');
        keys.webcam = key;
        setProgress(prev => ({ ...prev, webcam: 100 }));
        setUploadedKeys(prev => ({ ...prev, webcam: key }));
      }

      // Upload screen recording
      if (screenBlob) {
        setStatus('Uploading screen recording...');
        console.log('📤 Uploading screen recording:', screenBlob.size, 'bytes');

        // Get presigned URL (metadata set server-side)
        const { uploadUrl, key } = await getUploadUrl({
          submissionId,
          fileType: 'screen'
        });

        console.log('✅ Got upload URL for screen');

        // Upload to S3 (metadata already in presigned URL)
        await uploadRecordingToS3(uploadUrl, screenBlob);
        
        console.log('✅ Screen uploaded to S3');
        keys.screen = key;
        setProgress(prev => ({ ...prev, screen: 100 }));
        setUploadedKeys(prev => ({ ...prev, screen: key }));
      }

      // Save metadata to DynamoDB
      setStatus('Saving metadata...');
      console.log('💾 Saving metadata to DynamoDB');

      await saveRecordingMetadata({
        submissionId,
        webcamKey: keys.webcam,
        screenKey: keys.screen,
        startedAt,
        completedAt
      });

      console.log('✅ Metadata saved');
      setStatus('Upload complete!');
      setIsUploading(false);
      
      // Wait a moment to show success message
      setTimeout(() => {
        onComplete();
      }, 1000);

    } catch (error: any) {
      console.error('❌ Upload error:', error);
      setStatus('Upload failed');
      setIsUploading(false);
      onError(error.message || 'Failed to upload recordings');
    }
  };

  return (
    <div style={{
      border: '2px solid #17a2b8',
      borderRadius: '8px',
      padding: '20px',
      backgroundColor: '#f8f9fa'
    }}>
      <h3 style={{ margin: '0 0 15px 0', color: '#333' }}>
        📤 Upload Manager
      </h3>

      {/* Upload Summary */}
      <div style={{ marginBottom: '15px' }}>
        <p style={{ margin: '5px 0', color: '#333', fontSize: '14px' }}>
          <strong>Submission ID:</strong> {submissionId}
        </p>
        <p style={{ margin: '5px 0', color: '#333', fontSize: '14px' }}>
          <strong>Webcam:</strong> {webcamBlob ? `${(webcamBlob.size / 1024 / 1024).toFixed(2)} MB` : 'Not recorded'}
        </p>
        <p style={{ margin: '5px 0', color: '#333', fontSize: '14px' }}>
          <strong>Screen:</strong> {screenBlob ? `${(screenBlob.size / 1024 / 1024).toFixed(2)} MB` : 'Not recorded'}
        </p>
      </div>

      {/* Status */}
      <div style={{
        padding: '10px',
        backgroundColor: isUploading ? '#fff3cd' : '#d4edda',
        borderRadius: '4px',
        marginBottom: '15px'
      }}>
        <p style={{ margin: 0, color: '#333', fontWeight: 'bold', fontSize: '14px' }}>
          {status}
        </p>
      </div>

      {/* Progress Bars */}
      {isUploading && (
        <div style={{ marginBottom: '15px' }}>
          {webcamBlob && (
            <div style={{ marginBottom: '10px' }}>
              <p style={{ margin: '0 0 5px 0', fontSize: '13px', color: '#666' }}>
                Webcam: {progress.webcam}%
              </p>
              <div style={{
                width: '100%',
                height: '20px',
                backgroundColor: '#e9ecef',
                borderRadius: '4px',
                overflow: 'hidden'
              }}>
                <div style={{
                  width: `${progress.webcam}%`,
                  height: '100%',
                  backgroundColor: '#007bff',
                  transition: 'width 0.3s'
                }} />
              </div>
            </div>
          )}

          {screenBlob && (
            <div>
              <p style={{ margin: '0 0 5px 0', fontSize: '13px', color: '#666' }}>
                Screen: {progress.screen}%
              </p>
              <div style={{
                width: '100%',
                height: '20px',
                backgroundColor: '#e9ecef',
                borderRadius: '4px',
                overflow: 'hidden'
              }}>
                <div style={{
                  width: `${progress.screen}%`,
                  height: '100%',
                  backgroundColor: '#28a745',
                  transition: 'width 0.3s'
                }} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Uploaded Keys */}
      {(uploadedKeys.webcam || uploadedKeys.screen) && (
        <div style={{
          padding: '10px',
          backgroundColor: '#d4edda',
          borderRadius: '4px',
          marginBottom: '15px',
          fontSize: '12px'
        }}>
          <p style={{ margin: '0 0 5px 0', color: '#155724', fontWeight: 'bold' }}>
            ✅ Uploaded to S3:
          </p>
          {uploadedKeys.webcam && (
            <p style={{ margin: '2px 0', color: '#155724', wordBreak: 'break-all' }}>
              📹 {uploadedKeys.webcam}
            </p>
          )}
          {uploadedKeys.screen && (
            <p style={{ margin: '2px 0', color: '#155724', wordBreak: 'break-all' }}>
              🖥️ {uploadedKeys.screen}
            </p>
          )}
        </div>
      )}

      {/* Upload Button */}
      <button
        onClick={startUpload}
        disabled={isUploading || (!webcamBlob && !screenBlob)}
        style={{
          padding: '12px 24px',
          backgroundColor: isUploading ? '#6c757d' : '#17a2b8',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: isUploading ? 'not-allowed' : 'pointer',
          fontSize: '16px',
          fontWeight: 'bold',
          width: '100%'
        }}
      >
        {isUploading ? '⏳ Uploading...' : '📤 Upload to S3'}
      </button>
    </div>
  );
}