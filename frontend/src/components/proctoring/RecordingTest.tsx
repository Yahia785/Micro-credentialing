import { useState } from 'react';
import { WebcamRecorder } from './WebcamRecorder';
import { ScreenRecorder } from './ScreenRecorder';
import { UploadManager } from './UploadManager';

export function RecordingTest() {
  const [webcamBlob, setWebcamBlob] = useState<Blob | null>(null);
  const [screenBlob, setScreenBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadComplete, setUploadComplete] = useState(false);
  const [recordingStartTime] = useState<string>(new Date().toISOString());

  // Test submission ID (in real app, this comes from actual code submission)
  const testSubmissionId = `sub_proctoring_test_123`;

  const handleWebcamComplete = (blob: Blob) => {
    console.log('✅ Webcam recording received:', blob.size, 'bytes');
    setWebcamBlob(blob);
  };

  const handleScreenComplete = (blob: Blob) => {
    console.log('✅ Screen recording received:', blob.size, 'bytes');
    setScreenBlob(blob);
  };

  const handleError = (errorMsg: string) => {
    console.error('❌ Error:', errorMsg);
    setError(errorMsg);
  };

  const handleUploadComplete = () => {
    console.log('🎉 Upload complete!');
    setUploadComplete(true);
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const resetTest = () => {
    setWebcamBlob(null);
    setScreenBlob(null);
    setError(null);
    setUploadComplete(false);
  };

  return (
    <div style={{ padding: '20px', maxWidth: '1400px', margin: '0 auto' }}>
      <h1 style={{ color: '#333' }}>🎥 Recording & Upload Test</h1>
      <p style={{ color: '#666' }}>
        Test complete workflow: Record → Upload to S3 → Save metadata to DynamoDB
      </p>

      {error && (
        <div style={{
          backgroundColor: '#f8d7da',
          color: '#721c24',
          padding: '15px',
          borderRadius: '8px',
          marginBottom: '20px'
        }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {uploadComplete && (
        <div style={{
          backgroundColor: '#d4edda',
          color: '#155724',
          padding: '20px',
          borderRadius: '8px',
          marginBottom: '20px'
        }}>
          <h2 style={{ marginTop: 0 }}>🎉 Success!</h2>
          <p style={{ margin: '10px 0' }}>
            Recordings uploaded to S3 and metadata saved to DynamoDB!
          </p>
          <p style={{ margin: '10px 0', fontSize: '14px' }}>
            <strong>Submission ID:</strong> {testSubmissionId}
          </p>
          <button
            onClick={resetTest}
            style={{
              padding: '10px 20px',
              backgroundColor: '#28a745',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px',
              marginTop: '10px'
            }}
          >
            🔄 Test Again
          </button>
        </div>
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))',
        gap: '20px',
        marginTop: '20px'
      }}>
        {/* Webcam Recorder */}
        <div>
          <WebcamRecorder
            onRecordingComplete={handleWebcamComplete}
            onError={handleError}
          />
          
          {webcamBlob && (
            <div style={{ marginTop: '15px' }}>
              <button
                onClick={() => downloadBlob(webcamBlob, 'webcam-recording.webm')}
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#007bff',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  width: '100%'
                }}
              >
                ⬇️ Download Webcam ({(webcamBlob.size / 1024 / 1024).toFixed(2)} MB)
              </button>
            </div>
          )}
        </div>

        {/* Screen Recorder */}
        <div>
          <ScreenRecorder
            onRecordingComplete={handleScreenComplete}
            onError={handleError}
          />
          
          {screenBlob && (
            <div style={{ marginTop: '15px' }}>
              <button
                onClick={() => downloadBlob(screenBlob, 'screen-recording.webm')}
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#28a745',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  width: '100%'
                }}
              >
                ⬇️ Download Screen ({(screenBlob.size / 1024 / 1024).toFixed(2)} MB)
              </button>
            </div>
          )}
        </div>

        {/* Upload Manager */}
        {(webcamBlob || screenBlob) && (
          <div>
            <UploadManager
              submissionId={testSubmissionId}
              webcamBlob={webcamBlob}
              screenBlob={screenBlob}
              startedAt={recordingStartTime}
              onComplete={handleUploadComplete}
              onError={handleError}
            />
          </div>
        )}
      </div>

      {/* Instructions */}
      <div style={{
        marginTop: '30px',
        padding: '20px',
        backgroundColor: '#e7f3ff',
        borderRadius: '8px'
      }}>
        <h3 style={{ marginTop: 0, color: '#004085' }}>📋 Complete Testing Instructions:</h3>
        <ol style={{ color: '#004085', lineHeight: '1.8' }}>
          <li><strong>Start Recordings:</strong>
            <ul>
              <li>Click "Start Preview" on webcam → Allow camera access</li>
              <li>Click "🔴 Start Recording" on webcam</li>
              <li>Click "Start Screen Share" → Select "Entire Screen"</li>
              <li>Click "🔴 Start Recording" on screen</li>
            </ul>
          </li>
          <li><strong>Record:</strong> Wait 10-20 seconds while recording</li>
          <li><strong>Stop Recordings:</strong>
            <ul>
              <li>Click "⏹️ Stop Recording" on both</li>
            </ul>
          </li>
          <li><strong>Upload:</strong>
            <ul>
              <li>Upload Manager will appear automatically</li>
              <li>Click "📤 Upload to S3"</li>
              <li>Wait for upload to complete</li>
            </ul>
          </li>
          <li><strong>Verify:</strong>
            <ul>
              <li>Check success message with Submission ID</li>
              <li>Go to AWS Console → S3 → Check your bucket</li>
              <li>Go to DynamoDB → Submissions table → Find submission</li>
            </ul>
          </li>
        </ol>
      </div>
    </div>
  );
}