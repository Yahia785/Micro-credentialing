import { useState, useRef, useEffect, useId } from 'react';
import { Alert, Badge, Button, Card } from '../ui';
import styles from './ProctoringInstructions.module.css';

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
  const [isEntireScreen, setIsEntireScreen] = useState(false);
  const [webcamError, setWebcamError] = useState<string | null>(null);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [isRequesting, setIsRequesting] = useState(false);

  const titleId = useId();
  const reasonId = useId();

  const webcamStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const webcamVideoRef = useRef<HTMLVideoElement>(null);
  const screenVideoRef = useRef<HTMLVideoElement>(null);
  // Set once the streams are handed to the parent, which then owns stopping them.
  const handedOffRef = useRef(false);

  // If this screen unmounts without Cancel or Start (e.g. browser Back), release any granted streams.
  useEffect(() => {
    return () => {
      if (handedOffRef.current) return;
      webcamStreamRef.current?.getTracks().forEach(track => track.stop());
      screenStreamRef.current?.getTracks().forEach(track => track.stop());
    };
  }, []);

  // Video elements are always in the DOM (hidden via CSS) so their refs are
  // guaranteed to be populated. We assign srcObject here after state updates,
  // not inside the async functions where the element may not exist yet.
  useEffect(() => {
    if (webcamGranted && webcamStreamRef.current && webcamVideoRef.current) {
      webcamVideoRef.current.srcObject = webcamStreamRef.current;
    }
  }, [webcamGranted]);

  useEffect(() => {
    if (screenGranted && isEntireScreen && screenStreamRef.current && screenVideoRef.current) {
      screenVideoRef.current.srcObject = screenStreamRef.current;
    }
  }, [screenGranted, isEntireScreen]);

  const requestWebcamAccess = async () => {
    try {
      setIsRequesting(true);
      setWebcamError(null);
      console.log('🎥 Requesting webcam and microphone access...');

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user'
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      webcamStreamRef.current = stream;
      setWebcamGranted(true);
      console.log('✅ Webcam and microphone access granted');
    } catch (err: any) {
      console.error('❌ Webcam access error:', err);
      const errorMessage = err.name === 'NotAllowedError' 
        ? 'Camera and microphone permission denied. Please allow access to continue.'
        : `Failed to access camera and microphone: ${err.message}`;
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

      const videoTrack = stream.getVideoTracks()[0];
      const settings = videoTrack.getSettings();
      
      console.log('📺 Screen share settings:', settings);
      console.log('📺 Display surface:', settings.displaySurface);

      const isFullScreen = settings.displaySurface === 'monitor';
      
      if (!isFullScreen) {
        console.warn('⚠️ User did not share entire screen:', settings.displaySurface);
        stream.getTracks().forEach(track => track.stop());
        setScreenError(
          `You selected "${settings.displaySurface === 'browser' ? 'a browser tab' : 'a window'}" instead of "Entire Screen". ` +
          'Please click "Share Screen" again and select "Entire Screen" from the options.'
        );
        setScreenGranted(false);
        setIsEntireScreen(false);
        screenStreamRef.current = null;
        setIsRequesting(false);
        return;
      }

      screenStreamRef.current = stream;

      // Handle user stopping screen share via browser UI
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        console.log('⚠️ User stopped screen sharing');
        setScreenGranted(false);
        setIsEntireScreen(false);
        screenStreamRef.current = null;
        setScreenError('Screen sharing was stopped. Please share your screen again to continue.');
      });

      setScreenGranted(true);
      setIsEntireScreen(true);
      console.log('✅ Screen share access granted - Entire screen');
    } catch (err: any) {
      console.error('❌ Screen access error:', err);
      const errorMessage = err.name === 'NotAllowedError' 
        ? 'Screen share permission denied. Please allow screen sharing to continue.'
        : `Failed to access screen: ${err.message}`;
      setScreenError(errorMessage);
      setScreenGranted(false);
      setIsEntireScreen(false);
    } finally {
      setIsRequesting(false);
    }
  };

  const handleProceed = () => {
    if (webcamStreamRef.current && screenStreamRef.current && isEntireScreen) {
      handedOffRef.current = true;
      onProceed(webcamStreamRef.current, screenStreamRef.current);
    }
  };

  const handleCancel = () => {
    if (webcamStreamRef.current) {
      webcamStreamRef.current.getTracks().forEach(track => track.stop());
    }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(track => track.stop());
    }
    onCancel();
  };

  const canProceed = webcamGranted && screenGranted && isEntireScreen;

  const screenReady = screenGranted && isEntireScreen;
  const blockedReason = canProceed
    ? ''
    : !webcamGranted
      ? 'Allow your camera and microphone to continue.'
      : !screenGranted
        ? 'Share your entire screen to continue.'
        : 'Select "Entire Screen" to continue.';

  return (
    <div className={styles.overlay}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className={styles.header}>
          <h2 id={titleId} className={styles.title}>Set up proctoring</h2>
          <p className={styles.problem}>
            Assessment: <strong>{problemTitle}</strong>
          </p>
        </header>

        <Alert variant="info" title="Before you start">
          <ul className={styles.list}>
            <li>This assessment is proctored to keep it fair for everyone.</li>
            <li>Your camera, microphone and screen are recorded until you submit.</li>
            <li>Your instructors review the recordings.</li>
            <li>You need to allow all three to start.</li>
          </ul>
        </Alert>

        <Alert variant="warning" title="When you share your screen, choose Entire Screen">
          <ul className={styles.list}>
            <li>Choose <strong>Entire Screen</strong>, not a browser tab or a window. A tab or window cannot be recorded for this assessment.</li>
            <li>With more than one monitor, choose the one you will code on.</li>
          </ul>
        </Alert>

        <div className={styles.steps}>
        <Card
          headingLevel={3}
          title="Step 1: Camera and microphone"
          actions={webcamGranted ? <Badge variant="success">Granted</Badge> : undefined}
        >
          {!webcamGranted && (
            <Button onClick={requestWebcamAccess} loading={isRequesting} disabled={isRequesting}>
              {isRequesting ? 'Requesting access…' : 'Allow camera and microphone'}
            </Button>
          )}

          {webcamError && <Alert variant="danger">{webcamError}</Alert>}

          {/* Always rendered so ref is populated when stream arrives */}
          <div hidden={!webcamGranted}>
            <video
              ref={webcamVideoRef}
              className={`${styles.preview} ${styles.previewCover}`}
              autoPlay
              muted
              playsInline
              aria-label="Preview of your camera"
            />
            <p className={styles.previewNote}>Your microphone is on. Your audio will be recorded.</p>
          </div>
        </Card>

        <Card
          headingLevel={3}
          title="Step 2: Share your screen"
          actions={screenReady ? <Badge variant="success">Entire screen granted</Badge> : undefined}
        >
          {!screenGranted && (
            <Button onClick={requestScreenAccess} loading={isRequesting} disabled={isRequesting}>
              {isRequesting ? 'Requesting access…' : 'Share screen'}
            </Button>
          )}

          {screenError && <Alert variant="danger">{screenError}</Alert>}

          {/* Always rendered so ref is populated when stream arrives */}
          <div hidden={!screenReady}>
            <video
              ref={screenVideoRef}
              className={styles.preview}
              autoPlay
              muted
              playsInline
              aria-label="Preview of your shared screen"
            />
          </div>
        </Card>
        </div>

        <footer className={styles.footer}>
          {blockedReason && (
            <p id={reasonId} className={styles.reason}>{blockedReason}</p>
          )}
          <div className={styles.actions}>
            <Button variant="secondary" onClick={handleCancel}>
              Cancel
            </Button>
            <Button onClick={handleProceed} disabled={!canProceed} aria-describedby={blockedReason ? reasonId : undefined}>
              Start assessment
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
