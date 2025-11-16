/**
 * Recording state for a single stream (webcam or screen)
 */
export interface RecordingState {
  isRecording: boolean;
  isPaused: boolean;
  stream: MediaStream | null;
  mediaRecorder: MediaRecorder | null;
  recordedBlob: Blob | null;
  error: string | null;
}

/**
 * Proctoring session data
 */
export interface ProctoringSession {
  submissionId: string;
  startedAt: string;
  webcamRecording: RecordingState;
  screenRecording: RecordingState;
  isUploading: boolean;
  uploadProgress: {
    webcam: number;  // 0-100
    screen: number;  // 0-100
  };
}

/**
 * Recording metadata for backend
 */
export interface RecordingMetadata {
  submissionId: string;
  webcamKey?: string;
  screenKey?: string;
  startedAt: string;
  completedAt: string;
}

/**
 * Props for ProctoringManager component
 */
export interface ProctoringManagerProps {
  submissionId: string;
  onComplete: () => void;
  onError: (error: string) => void;
}