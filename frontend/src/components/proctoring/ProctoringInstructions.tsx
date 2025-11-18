import { useState, useRef } from 'react';

interface ProctoringInstructionsProps {
  problemTitle: string;
  onProceed: (webcamStream: MediaStream, screenStream: MediaStream) => void;
  onCancel: () => void;
}

export function ProctoringInstructions({ 
  problemTitle, 
  onProceed, 
  onCancel 
}: ProctoringInstructionsProps) {
  const [webcamGranted, setWebcamGranted] = useState(false);
  const [screenGranted, setScreenGranted] = useState(false);
  const [webcamError, setWebcamError] = useState<string | null>(null);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [isRequesting, setIsRequesting] = useState(false);

  const webcamStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const webcamVideoRef = useRef<HTMLVideoElement>(null);
  const screenVideoRef = useRef<HTMLVideoElement>(null);

  const requestWebcamAccess = async () => {
    try {
      setIsRequesting(true);
      setWebcamError(null);
      console.log('🎥 Requesting webcam access...');

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user'
        },
        audio: false
      });

      webcamStreamRef.current = stream;

      if (webcamVideoRef.current) {
        webcamVideoRef.current.srcObject = stream;
      }

      setWebcamGranted(true);
      console.log('✅ Webcam access granted');
    } catch (err: any) {
      console.error('❌ Webcam access error:', err);
      const errorMessage = err.name === 'NotAllowedError' 
        ? 'Camera permission denied. Please allow camera access to continue.'
        : `Failed to access camera: ${err.message}`;
      setWebcamError(errorMessage);
    } finally {
      setIsRequesting(false);
    }
  };

  const requestScreenAccess = async () => {
    try {
      setIsRequesting(true);
      setScreenError(null);
      console.log('🖥️ Requesting screen share access...');

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          displaySurface: 'monitor'
        } as any,
        audio: false
      });

      screenStreamRef.current = stream;

      if (screenVideoRef.current) {
        screenVideoRef.current.srcObject = stream;
      }

      // Handle user stopping screen share via browser UI
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        console.log('⚠️ User stopped screen sharing');
        setScreenGranted(false);
        screenStreamRef.current = null;
        setScreenError('Screen sharing was stopped. Please share your screen again to continue.');
      });

      setScreenGranted(true);
      console.log('✅ Screen share access granted');
    } catch (err: any) {
      console.error('❌ Screen access error:', err);
      const errorMessage = err.name === 'NotAllowedError' 
        ? 'Screen share permission denied. Please allow screen sharing to continue.'
        : `Failed to access screen: ${err.message}`;
      setScreenError(errorMessage);
    } finally {
      setIsRequesting(false);
    }
  };

  const handleProceed = () => {
    if (webcamStreamRef.current && screenStreamRef.current) {
      onProceed(webcamStreamRef.current, screenStreamRef.current);
    }
  };

  const handleCancel = () => {
    // Stop all streams
    if (webcamStreamRef.current) {
      webcamStreamRef.current.getTracks().forEach(track => track.stop());
    }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(track => track.stop());
    }
    onCancel();
  };

  const canProceed = webcamGranted && screenGranted;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.8)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
      padding: '20px'
    }}>
      <div style={{
        backgroundColor: 'white',
        borderRadius: '12px',
        padding: '30px',
        maxWidth: '800px',
        width: '100%',
        maxHeight: '90vh',
        overflow: 'auto',
        boxShadow: '0 10px 40px rgba(0,0,0,0.3)'
      }}>
        {/* Header */}
        <div style={{ marginBottom: '25px' }}>
          <h2 style={{ margin: '0 0 10px 0', color: '#333', fontSize: '28px' }}>
            🎥 Proctoring Setup Required
          </h2>
          <p style={{ margin: 0, color: '#666', fontSize: '16px' }}>
            Problem: <strong>{problemTitle}</strong>
          </p>
        </div>

        {/* Instructions */}
        <div style={{
          backgroundColor: '#e7f3ff',
          borderLeft: '4px solid #0066cc',
          padding: '20px',
          borderRadius: '8px',
          marginBottom: '25px'
        }}>
          <h3 style={{ marginTop: 0, color: '#0066cc', fontSize: '20px' }}>
            📋 Important Information
          </h3>
          <ul style={{ color: '#333', lineHeight: '1.8', marginBottom: 0 }}>
            <li>This problem requires <strong>proctoring</strong> to ensure academic integrity</li>
            <li>Your <strong>webcam</strong> will record you during the assessment</li>
            <li>Your <strong>screen</strong> will be recorded during the assessment</li>
            <li>Recordings will be reviewed by instructors</li>
            <li>You must grant both permissions to proceed</li>
          </ul>
        </div>

        {/* Webcam Permission */}
        <div style={{
          border: '2px solid #dee2e6',
          borderRadius: '8px',
          padding: '20px',
          marginBottom: '20px',
          backgroundColor: webcamGranted ? '#d4edda' : '#fff'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '15px' }}>
            <h3 style={{ margin: 0, color: '#333', fontSize: '18px' }}>
              📹 Step 1: Enable Webcam
            </h3>
            {webcamGranted && (
              <span style={{ color: '#28a745', fontWeight: 'bold', fontSize: '16px' }}>
                ✅ Granted
              </span>
            )}
          </div>

          {!webcamGranted && (
            <button
              onClick={requestWebcamAccess}
              disabled={isRequesting}
              style={{
                padding: '12px 24px',
                backgroundColor: isRequesting ? '#6c757d' : '#007bff',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: isRequesting ? 'not-allowed' : 'pointer',
                fontSize: '16px',
                fontWeight: 'bold',
                width: '100%'
              }}
            >
              {isRequesting ? '⏳ Requesting Access...' : '🎥 Allow Webcam Access'}
            </button>
          )}

          {webcamError && (
            <div style={{
              marginTop: '10px',
              padding: '12px',
              backgroundColor: '#f8d7da',
              color: '#721c24',
              borderRadius: '6px',
              fontSize: '14px'
            }}>
              ⚠️ {webcamError}
            </div>
          )}

          {webcamGranted && (
            <div style={{ marginTop: '15px' }}>
              <video
                ref={webcamVideoRef}
                autoPlay
                muted
                style={{
                  width: '100%',
                  maxHeight: '200px',
                  borderRadius: '8px',
                  backgroundColor: '#000',
                  objectFit: 'cover'
                }}
              />
            </div>
          )}
        </div>

        {/* Screen Share Permission */}
        <div style={{
          border: '2px solid #dee2e6',
          borderRadius: '8px',
          padding: '20px',
          marginBottom: '25px',
          backgroundColor: screenGranted ? '#d4edda' : '#fff'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '15px' }}>
            <h3 style={{ margin: 0, color: '#333', fontSize: '18px' }}>
              🖥️ Step 2: Share Your Screen
            </h3>
            {screenGranted && (
              <span style={{ color: '#28a745', fontWeight: 'bold', fontSize: '16px' }}>
                ✅ Granted
              </span>
            )}
          </div>

          {!screenGranted && (
            <button
              onClick={requestScreenAccess}
              disabled={isRequesting}
              style={{
                padding: '12px 24px',
                backgroundColor: isRequesting ? '#6c757d' : '#28a745',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: isRequesting ? 'not-allowed' : 'pointer',
                fontSize: '16px',
                fontWeight: 'bold',
                width: '100%'
              }}
            >
              {isRequesting ? '⏳ Requesting Access...' : '🖥️ Share Screen'}
            </button>
          )}

          {screenError && (
            <div style={{
              marginTop: '10px',
              padding: '12px',
              backgroundColor: '#f8d7da',
              color: '#721c24',
              borderRadius: '6px',
              fontSize: '14px'
            }}>
              ⚠️ {screenError}
            </div>
          )}

          {screenGranted && (
            <div style={{ marginTop: '15px' }}>
              <video
                ref={screenVideoRef}
                autoPlay
                muted
                style={{
                  width: '100%',
                  maxHeight: '200px',
                  borderRadius: '8px',
                  backgroundColor: '#000',
                  objectFit: 'contain'
                }}
              />
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div style={{ display: 'flex', gap: '15px' }}>
          <button
            onClick={handleCancel}
            style={{
              flex: 1,
              padding: '14px',
              backgroundColor: '#6c757d',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '16px',
              fontWeight: 'bold'
            }}
          >
            ← Cancel
          </button>

          <button
            onClick={handleProceed}
            disabled={!canProceed}
            style={{
              flex: 2,
              padding: '14px',
              backgroundColor: canProceed ? '#28a745' : '#dee2e6',
              color: canProceed ? 'white' : '#6c757d',
              border: 'none',
              borderRadius: '6px',
              cursor: canProceed ? 'pointer' : 'not-allowed',
              fontSize: '16px',
              fontWeight: 'bold'
            }}
          >
            {canProceed ? '✅ Start Problem' : '⏸️ Grant Both Permissions to Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}