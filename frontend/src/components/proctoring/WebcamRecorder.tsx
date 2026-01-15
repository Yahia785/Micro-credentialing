import { useState, useRef, useEffect } from 'react';

interface WebcamRecorderProps {
  onRecordingComplete: (blob: Blob) => void;
  onError: (error: string) => void;
}

export function WebcamRecorder({ onRecordingComplete, onError }: WebcamRecorderProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Request webcam access and show preview
  const startPreview = async () => {
    try {
      setError(null);
      console.log('🎥 Requesting webcam access...');

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user'
        },
        audio: true
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      setIsPreviewing(true);
      console.log('✅ Webcam preview started');
    } catch (err: any) {
      console.error('❌ Webcam access error:', err);
      const errorMessage = err.name === 'NotAllowedError' 
        ? 'Camera permission denied. Please allow camera access.'
        : `Failed to access camera: ${err.message}`;
      setError(errorMessage);
      onError(errorMessage);
    }
  };

  // Start recording
  const startRecording = async () => {
    try {
      if (!streamRef.current) {
        await startPreview();
        // Wait a bit for preview to initialize
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      if (!streamRef.current) {
        throw new Error('No webcam stream available');
      }

      console.log('🔴 Starting webcam recording...');

      // Check browser support
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm';

      const mediaRecorder = new MediaRecorder(streamRef.current, {
        mimeType,
        videoBitsPerSecond: 2500000 // 2.5 Mbps
      });

      chunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
          console.log('📦 Webcam chunk received:', event.data.size, 'bytes');
        }
      };

      mediaRecorder.onstop = () => {
        console.log('⏹️ Webcam recording stopped');
        const blob = new Blob(chunksRef.current, { type: 'video/webm' });
        console.log('📹 Webcam recording complete. Size:', blob.size, 'bytes');
        onRecordingComplete(blob);
      };

      mediaRecorder.onerror = (event: any) => {
        console.error('❌ MediaRecorder error:', event.error);
        setError('Recording error occurred');
        onError('Recording error occurred');
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start(1000); // Collect data every 1 second
      setIsRecording(true);

      console.log('✅ Webcam recording started');
    } catch (err: any) {
      console.error('❌ Start recording error:', err);
      setError(err.message);
      onError(err.message);
    }
  };

  // Stop recording
  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      console.log('⏹️ Stopping webcam recording...');
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  // Stop preview and release camera
  const stopPreview = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        track.stop();
        console.log('🛑 Webcam track stopped');
      });
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsPreviewing(false);
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopRecording();
      stopPreview();
    };
  }, []);

  return (
    <div style={{
      border: '2px solid #007bff',
      borderRadius: '8px',
      padding: '15px',
      backgroundColor: '#f8f9fa'
    }}>
      <h3 style={{ margin: '0 0 15px 0', color: '#333' }}>
        🎥 Webcam Recorder
      </h3>

      {/* Video Preview */}
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        style={{
          width: '100%',
          maxWidth: '400px',
          height: 'auto',
          backgroundColor: '#000',
          borderRadius: '4px',
          display: isPreviewing ? 'block' : 'none'
        }}
      />

      {/* Status Display */}
      <div style={{ marginTop: '10px' }}>
        {!isPreviewing && !isRecording && (
          <p style={{ color: '#666', fontSize: '14px' }}>
            Camera not started
          </p>
        )}
        {isPreviewing && !isRecording && (
          <p style={{ color: '#28a745', fontSize: '14px', fontWeight: 'bold' }}>
            ✅ Camera ready
          </p>
        )}
        {isRecording && (
          <p style={{ color: '#dc3545', fontSize: '14px', fontWeight: 'bold' }}>
            🔴 Recording in progress...
          </p>
        )}
      </div>

      {/* Error Display */}
      {error && (
        <div style={{
          backgroundColor: '#f8d7da',
          color: '#721c24',
          padding: '10px',
          borderRadius: '4px',
          marginTop: '10px',
          fontSize: '14px'
        }}>
          ⚠️ {error}
        </div>
      )}

      {/* Control Buttons */}
      <div style={{ marginTop: '15px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        {!isPreviewing && (
          <button
            onClick={startPreview}
            style={{
              padding: '8px 16px',
              backgroundColor: '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px'
            }}
          >
            Start Preview
          </button>
        )}

        {isPreviewing && !isRecording && (
          <button
            onClick={startRecording}
            style={{
              padding: '8px 16px',
              backgroundColor: '#28a745',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px'
            }}
          >
            🔴 Start Recording
          </button>
        )}

        {isRecording && (
          <button
            onClick={stopRecording}
            style={{
              padding: '8px 16px',
              backgroundColor: '#dc3545',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px'
            }}
          >
            ⏹️ Stop Recording
          </button>
        )}

        {isPreviewing && (
          <button
            onClick={stopPreview}
            style={{
              padding: '8px 16px',
              backgroundColor: '#6c757d',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px'
            }}
          >
            Stop Preview
          </button>
        )}
      </div>
    </div>
  );
}