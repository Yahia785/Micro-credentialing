import { useState, useEffect, useRef, useImperativeHandle } from 'react';
import type { Ref } from 'react';
import type { SubmissionEndedBy, SubmitOutcome } from '../types/submission';
import Editor from '@monaco-editor/react';
import { submitCode, getSubmission } from '../api/submissions';
import { submitEmbeddedAssessment } from '../api/embedded-assessments';
import { getTestCases } from '../api/testcases';
import { TestCaseResult } from './TestCaseResult';
import { uploadRecording, saveRecordingMetadata, sendClientLogs } from '../api/proctoring';
import { useNavigate } from 'react-router';
import { fetchAuthSession } from 'aws-amplify/auth';
import type { Difficulty } from '../utils/difficulty';
import { Alert, Badge, Button, DifficultyBadge } from './ui';
import { SplitPane } from './workspace/SplitPane';
import { WorkspaceShell } from './workspace/WorkspaceShell';
import { WorkspaceTabs } from './workspace/WorkspaceTabs';
import styles from './CodeEditor.module.css';
import { proctoringLogger } from '../utils/proctoringLogger';
import { useRunCode } from '../hooks/useRunCode';
import { RunControls } from './run/RunControls';
import { RunPanel } from './run/RunPanel';
import { SampleTestBox } from './run/SampleTestBox';
import { sampleStatusFor } from './run/sampleStatus';
import { MarkdownText } from './markdown/MarkdownText';

interface TestResult {
  testCaseId?: string;
  passed: boolean;
  input: string;
  actualOutput: string;
  expectedOutput: string;
  executionTime?: number;
  memory?: number;
  error?: string;
  isHidden?: boolean;
}

interface TestCase {
  testCaseId: string;
  milestoneId: string;
  input: string;
  expectedOutput: string;
  isHidden: boolean;
  order?: number;
}

interface Milestone {
  milestoneId: string;
  title: string;
  description: string;
  concept?: string;
  difficulty: string;
  language?: string;
  starterCode?: string;
  timeLimit?: number;
  memoryLimit?: number;
  type?: string;
}

const UNGRADED_GRADING_FAILED_MESSAGE =
  'Your work has been saved. Automatic grading is unavailable right now, so your instructor will review your submission.';
const UNGRADED_MANUAL_MESSAGE = 'Your work has been submitted. Your instructor will review and grade it.';
// A problem with the interview: nothing about the result is shown until the instructor has reviewed it.
const UNDER_REVIEW_MESSAGE =
  'Your submission is under review. Your results, the test cases and your code will be visible after your instructor reviews it.';
const UNDER_REVIEW_CODE = '// Your submitted code is hidden while your submission is under review.\n// It will become visible after your instructor reviews it.';

interface CodeEditorProps {
  milestone: Milestone;
  userProfile: any;
  webcamStream: MediaStream | null;
  screenStream: MediaStream | null;
  onClose: () => void;
  onSubmitSuccess?: () => void;
  isViewMode?: boolean;
  /** Called as soon as the submission is saved (before the recordings are uploaded), so the page can show what comes next meanwhile. */
  onSubmitted?: (outcome: SubmitOutcome) => void;
  /** Called when a submission attempt has fully finished (grading, uploads, metadata), success or not. */
  onSubmitSettled?: (outcome: SubmitOutcome) => void;
  ref?: Ref<CodeEditorHandle>;
}

/** Lets the parent end the session by submitting, without the editor's own confirm dialog. */
export interface CodeEditorHandle {
  submitAndEnd: (reason: SubmissionEndedBy) => Promise<SubmitOutcome>;
}

export function CodeEditor({
  milestone,
  userProfile,
  webcamStream,
  screenStream,
  onClose,
  onSubmitSuccess,
  isViewMode = false,
  onSubmitted,
  onSubmitSettled,
  ref
}: CodeEditorProps) {
  const navigate = useNavigate();
  // Default language and starter code if not provided
  const defaultLanguage = milestone.language || 'python';
  const defaultStarterCode = milestone.starterCode || getDefaultStarterCode(defaultLanguage);

  const [code, setCode] = useState(defaultStarterCode);
  const [actualOutput, setOutput] = useState('');
  const [testResults, setTestResults] = useState<TestResult[]>([]);
  const [loadingSubmission, setLoadingSubmission] = useState(false);
  const [submissionData, setSubmissionData] = useState<any>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState<'description' | 'output'>('description');
  const [submissionStatus, setSubmissionStatus] = useState<'idle' | 'success' | 'failed'>('idle');
  const [copiedToClipboard, setCopiedToClipboard] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  
  // Test cases state
  const [sampleTestCases, setSampleTestCases] = useState<TestCase[]>([]);
  const [loadingTestCases, setLoadingTestCases] = useState(true);
  const [testCasesError, setTestCasesError] = useState<string | null>(null);
  
  // Proctoring state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingStartTime, setRecordingStartTime] = useState<string | null>(null);
  const webcamRecorderRef = useRef<MediaRecorder | null>(null);
  const screenRecorderRef = useRef<MediaRecorder | null>(null);
  
  // USE REFS FOR CHUNKS (instead of state to avoid async issues)
  const webcamChunksRef = useRef<Blob[]>([]);
  const screenChunksRef = useRef<Blob[]>([]);

  // Check if milestone is already completed
  const isAlreadyCompleted = userProfile?.completedMilestones?.some(
    (m: any) => m.milestoneId === milestone.milestoneId
  );
  
  const completedMilestone = userProfile?.completedMilestones?.find(
    (m: any) => m.milestoneId === milestone.milestoneId
  );

  // Run button (C++ problems only): the run state lives in the hook; running never touches recording, submit or the leave guard.
  const runAvailable = defaultLanguage.toLowerCase() === 'cpp' && milestone.type !== 'embedded' && !isViewMode && !isAlreadyCompleted;
  const run = useRunCode({
    milestoneId: milestone.milestoneId,
    getCode: () => code,
    enabled: runAvailable && !hasSubmitted && !isSubmitting,
  });

// Reset code when milestone changes OR load submitted code in view mode
  useEffect(() => {
    async function loadSubmittedCode() {
      if (isViewMode && completedMilestone?.submissionId) {
        setLoadingSubmission(true);
        try {
          console.log('📖 Loading submitted code for view mode...');
          console.log('Submission ID:', completedMilestone.submissionId);
          
          // Fetch the submission using the submissionId from completedMilestone
          const result = await getSubmission(completedMilestone.submissionId);
          
          if (result.submission) {
            const submission = result.submission;
            console.log('✅ Found submitted code:', submission);
            
            setSubmissionData(submission);

            // Held for the instructor: the server sent only its status and time. Show the message, no code and no results.
            if (submission.underReview) {
              setCode(UNDER_REVIEW_CODE);
              setOutput(`${UNDER_REVIEW_MESSAGE}\n\nSubmitted: ${new Date(submission.submittedAt).toLocaleString()}`);
              setActiveTab('output');
              return;
            }
            
            const reviewStatus = submission.proctoringData?.reviewStatus;
            const isReviewed = reviewStatus === 'approved' || reviewStatus === 'rejected';
            
            // Only load actual code if reviewed — hide it otherwise
            if (submission.type === 'embedded' && !isReviewed) {
              setCode('// Your submitted code is hidden while your submission is under review.\n// It will become visible after the instructor completes the review.');
            } else {
              setCode(submission.code);
            }
            
            if (submission.type === 'embedded') {
              if (isReviewed) {
                setOutput(
                  `AI Grading Results\n\n` +
                  `Score: ${submission.passedCriteria}/${submission.totalCriteria} criteria (${submission.score}%)\n` +
                  `Submitted: ${new Date(submission.submittedAt || submission.createdAt).toLocaleString()}`
                );
              } else {
                setOutput(
                  `Your submission has been recorded and is under review by the instructor.\n\n` +
                  `Results will be available after the review is complete.`
                );
              }
              setActiveTab('output');
            } else if (submission.status === 'grading_failed' && !isReviewed) {
              setOutput(`${UNGRADED_GRADING_FAILED_MESSAGE}\n\nSubmitted: ${new Date(submission.submittedAt || submission.createdAt).toLocaleString()}`);
              setActiveTab('output');
            } else if (submission.testResults) {
              setTestResults(submission.testResults);
              setOutput(
                `Submission Results\n\n` +
                `Score: ${submission.passedTests}/${submission.totalTests} (${submission.score}%)\n` +
                `Submitted: ${new Date(submission.submittedAt || submission.createdAt).toLocaleString()}\n\n` +
                `View test results below.`
              );
              setActiveTab('output');
            }
                      } else {
            console.log('⚠️ No submission data found, using starter code');
            setCode(defaultStarterCode);
          }
        } catch (error) {
          console.error('❌ Error loading submitted code:', error);
          setCode(defaultStarterCode);
          setOutput('⚠️ Could not load previous submission. Showing starter code instead.');
        } finally {
          setLoadingSubmission(false);
        }
      } else {
        // Not in view mode, reset to starter code
        setCode(defaultStarterCode);
        setOutput('');
        setTestResults([]);
        setSubmissionStatus('idle');
        setCopiedToClipboard(false);
        setHasSubmitted(false);
      }
    }
    
    loadSubmittedCode();
  }, [milestone.milestoneId, defaultStarterCode, isViewMode, completedMilestone]);

  // Fetch test cases when milestone changes
  useEffect(() => {
    async function fetchTestCases() {
      try {
        setLoadingTestCases(true);
        setTestCasesError(null);
        console.log('Fetching test cases for milestone:', milestone.milestoneId);
        
        const result = await getTestCases(milestone.milestoneId);
        console.log('Test cases fetched:', result);
        
        // Filter to only get non-hidden test cases (sample ones)
        const sampleCases = (result.testCases || [])
          .filter((tc: TestCase) => !tc.isHidden)
          .sort((a: TestCase, b: TestCase) => (a.order || 0) - (b.order || 0));
        
        setSampleTestCases(sampleCases);
        console.log('Sample test cases:', sampleCases);
        
      } catch (error: any) {
        console.error('Failed to fetch test cases:', error);
        setTestCasesError('Failed to load test cases');
      } finally {
        setLoadingTestCases(false);
      }
    }
    
    fetchTestCases();
  }, [milestone.milestoneId]);

// Start recording when component mounts with streams
// Start recording when component mounts with streams (only if NOT in view mode)
useEffect(() => {
  let mounted = true;
  
  // Skip recording if in view mode
  if (isViewMode) {
    console.log('📖 View mode: Skipping recording');
    return;
  }
  
  if (webcamStream && screenStream && !isRecording && mounted) {
    startRecording();
  }
  
  // Cleanup on unmount only
  return () => {
    mounted = false;
    // Only stop if component is actually unmounting
    if (webcamRecorderRef.current && webcamRecorderRef.current.state !== 'inactive') {
      console.log('🛑 Cleanup: Stopping webcam recorder');
      webcamRecorderRef.current.stop();
    }
    if (screenRecorderRef.current && screenRecorderRef.current.state !== 'inactive') {
      console.log('🛑 Cleanup: Stopping screen recorder');
      screenRecorderRef.current.stop();
    }
  };
}, [isViewMode]); // Add isViewMode as dependency // EMPTY DEPS - only run once on mount!

const startRecording = () => {
  if (!webcamStream || !screenStream) {
    console.log('⚠️ Cannot start recording - streams not available');
    proctoringLogger.log('recording_start_skipped', 'warn', {
      reason: 'streams_not_available',
      hasWebcam: !!webcamStream,
      hasScreen: !!screenStream,
    });
    return;
  }

  // Prevent starting if already recording
  if (isRecording) {
    console.log('⚠️ Already recording, skipping start');
    proctoringLogger.log('recording_start_skipped', 'warn', { reason: 'already_recording' });
    return;
  }

  try {
    console.log('🔴 Starting proctoring recording...');
    const startTime = new Date().toISOString();
    setRecordingStartTime(startTime);

    // Clear previous chunks
    webcamChunksRef.current = [];
    screenChunksRef.current = [];

    // Start webcam recording
    const webcamMimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
      ? 'video/webm;codecs=vp8'
      : 'video/webm';
    const webcamMR = new MediaRecorder(webcamStream, {
      mimeType: webcamMimeType,
      videoBitsPerSecond: 500000
    });

    webcamMR.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        webcamChunksRef.current.push(e.data);
        console.log('📹 Webcam chunk received:', e.data.size, 'bytes, total chunks:', webcamChunksRef.current.length);
      }
    };

    webcamMR.onstop = () => {
      console.log('📹 Webcam recording stopped, total chunks:', webcamChunksRef.current.length);
    };

    webcamMR.onerror = (e: any) => {
      console.error('❌ Webcam recorder error:', e);
      proctoringLogger.log('recorder_error', 'error', {
        source: 'webcam',
        error: e?.error?.toString() ?? String(e),
      });
    };

    webcamMR.start(1000); // Collect data every second
    webcamRecorderRef.current = webcamMR; // Use ref instead of setState
    console.log('✅ Webcam recorder started, state:', webcamMR.state);

    // Start screen recording
    const screenMimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
      ? 'video/webm;codecs=vp8'
      : 'video/webm';
    const screenMR = new MediaRecorder(screenStream, {
      mimeType: screenMimeType,
      videoBitsPerSecond: 2000000
    });

    screenMR.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        screenChunksRef.current.push(e.data);
        console.log('🖥️ Screen chunk received:', e.data.size, 'bytes, total chunks:', screenChunksRef.current.length);
      }
    };

    screenMR.onstop = () => {
      console.log('🖥️ Screen recording stopped, total chunks:', screenChunksRef.current.length);
    };

    screenMR.onerror = (e: any) => {
      console.error('❌ Screen recorder error:', e);
      proctoringLogger.log('recorder_error', 'error', {
        source: 'screen',
        error: e?.error?.toString() ?? String(e),
      });
    };

    screenMR.start(1000); // Collect data every second
    screenRecorderRef.current = screenMR; // Use ref instead of setState
    console.log('✅ Screen recorder started, state:', screenMR.state);

    setIsRecording(true);
    console.log('✅ Recording started successfully at', startTime);

    proctoringLogger.log('recording_started', 'info', {
      startTime,
      webcamMimeType,
      screenMimeType,
      webcamTracks: webcamStream.getTracks().map(t => ({
        kind: t.kind, label: t.label, readyState: t.readyState,
      })),
      screenTracks: screenStream.getTracks().map(t => ({
        kind: t.kind, label: t.label, readyState: t.readyState,
      })),
    });
  } catch (err: any) {
    console.error('❌ Failed to start recording:', err);
    proctoringLogger.log('recording_start_failed', 'error', {
      error: err?.message ?? String(err),
    });
  }
};

const stopRecording = () => {
  console.log('⏹️ Stopping proctoring recording...');

  const webcamState = webcamRecorderRef.current?.state ?? 'not_created';
  const screenState = screenRecorderRef.current?.state ?? 'not_created';

  if (webcamRecorderRef.current && webcamRecorderRef.current.state !== 'inactive') {
    webcamRecorderRef.current.stop();
  }

  if (screenRecorderRef.current && screenRecorderRef.current.state !== 'inactive') {
    screenRecorderRef.current.stop();
  }

  setIsRecording(false);
  console.log('⏹️ Recording stop initiated');

  proctoringLogger.log('recording_stopped', 'info', {
    webcamRecorderState: webcamState,
    screenRecorderState: screenState,
    webcamChunks: webcamChunksRef.current.length,
    screenChunks: screenChunksRef.current.length,
  });
};

  /**
   * Open OnlineGDB in new tab
   */
  const handleOpenInOnlineGDB = () => {
    console.log('🔗 Opening OnlineGDB...');
    
    const onlineGDBUrl = `https://www.onlinegdb.com/`;
    
    console.log('Opening URL:', onlineGDBUrl);
    window.open(onlineGDBUrl, '_blank');
  };

  /**
   * Copy starter code to clipboard
   */
  const handleCopyCode = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopiedToClipboard(true);
      setTimeout(() => setCopiedToClipboard(false), 3000);
    });
  };

  const handleSubmit = async () => {
    const isEmbedded = milestone.type === 'embedded';

    if (!window.confirm(
      isEmbedded
        ? '⚠️ IMPORTANT: Before submitting, make sure:\n\n' +
          '✅ Your code is complete and ready for grading\n' +
          '✅ You have implemented all required functionality\n\n' +
          'This submission will be graded automatically.\n\n' +
          'Continue with submission?'
        : '⚠️ IMPORTANT: Before submitting, make sure:\n\n' +
          '✅ You tested your code in OnlineGDB\n' +
          '✅ Your code works with the sample test cases\n' +
          '✅ You copied your final code back to this editor\n\n' +
          'This submission will use Judge0 to test your code against all test cases (including hidden ones).\n\n' +
          'Continue with submission?'
    )) {
      return;
    }

    await trackedSubmit('submit_button');
  };

  // At most one submission runs at a time; callers share the in-flight one.
  const submitInFlightRef = useRef<Promise<SubmitOutcome> | null>(null);
  const trackedSubmit = (endedBy: SubmissionEndedBy): Promise<SubmitOutcome> => {
    if (submitInFlightRef.current) return submitInFlightRef.current;
    const promise = runSubmit(endedBy).finally(() => {
      submitInFlightRef.current = null;
    });
    submitInFlightRef.current = promise;
    return promise;
  };

  useImperativeHandle(ref, () => ({
    submitAndEnd: (reason) => {
      if (submitInFlightRef.current) return submitInFlightRef.current;
      if (hasSubmitted || isAlreadyCompleted || isViewMode) return Promise.resolve({ ok: true });
      return trackedSubmit(reason);
    },
  }));

  const runSubmit = async (endedBy: SubmissionEndedBy): Promise<SubmitOutcome> => {
    const isEmbedded = milestone.type === 'embedded';
    let outcome: SubmitOutcome = { ok: true };

    // STOP RECORDING BEFORE SUBMISSION
    stopRecording();
    
    // Wait for recordings to finalize
    await new Promise(resolve => setTimeout(resolve, 1000));

    setIsSubmitting(true);
    setOutput(
      isEmbedded
        ? '⏳ Submitting your code for grading...\n\nPlease wait...'
        : '⏳ Submitting your code to Judge0 for grading...\n\nPlease wait...'
    );
    setTestResults([]);
    setActiveTab('output');
    setSubmissionStatus('idle');

    try {
      let result: any;

      if (isEmbedded) {
        console.log('📤 Submitting embedded code for LLM grading...');
        const embeddedResult = await submitEmbeddedAssessment(
          milestone.milestoneId,
          code,
          endedBy
        );
        // Shape the result to match the existing flow
        result = {
          submission: {
            submissionId: embeddedResult.submissionId,
            gradingFailed: embeddedResult.gradingFailed,
            gradingMode: embeddedResult.gradingMode,
            status: embeddedResult.passed ? 'passed' : 'failed',
            passedTests: embeddedResult.passedCriteria,
            totalTests: embeddedResult.totalCriteria,
            testResults: [],
          }
        };
      } else {
        console.log('📤 Submitting code to Judge0...');
        result = await submitCode({
          milestoneId: milestone.milestoneId,
          code,
          language: defaultLanguage,
          endedBy,
        });
      }

      console.log('✅ Submission result:', result);

      if (result.error) {
        outcome = { ok: false, error: String(result.error) };
        setOutput(`❌ Error: ${result.error}`);
        setSubmissionStatus('failed');
        setHasSubmitted(true);
      } else if (result.submission) {
        const { status, passedTests, totalTests, testResults: submissionResults, submissionId, gradingFailed, gradingMode } = result.submission;
        // Lets the page continue with the interview after a submit (see useAssessmentSession).
        outcome = { ok: true, submissionId, code, endedBy };
        onSubmitted?.(outcome);
        // Never graded automatically: the instructor will review it, so don't show a score or a failure.
        const ungradedMessage = gradingFailed === true
          ? UNGRADED_GRADING_FAILED_MESSAGE
          : gradingMode === 'manual' ? UNGRADED_MANUAL_MESSAGE : null;
        
        setTestResults(submissionResults || []);
        setHasSubmitted(true);

        // UPLOAD PROCTORING RECORDINGS
        const hasWebcamChunks = webcamChunksRef.current.length > 0;
        const hasScreenChunks = screenChunksRef.current.length > 0;

        // Init logger with this submissionId so all upload events are tied to it
        proctoringLogger.init(submissionId);
        proctoringLogger.log('upload_check', 'info', {
          hasSubmissionId: !!submissionId,
          hasWebcamChunks,
          webcamChunkCount: webcamChunksRef.current.length,
          hasScreenChunks,
          screenChunkCount: screenChunksRef.current.length,
          hasRecordingStartTime: !!recordingStartTime,
        });

        if (submissionId && (hasWebcamChunks || hasScreenChunks) && recordingStartTime) {
          console.log('📤 Uploading proctoring recordings for submission:', submissionId);

          const session = await fetchAuthSession();
          const userId = session.tokens?.idToken?.payload.sub as string;

          if (!userId) {
            console.error('❌ No user ID found - cannot upload recordings');
            proctoringLogger.log('upload_skipped', 'error', { reason: 'no_user_id' });
          } else {
            let webcamKey: string | undefined;
            let screenKey: string | undefined;
            let anyUploadFailed = false;

            // Upload webcam independently
            if (hasWebcamChunks) {
              const webcamBlob = new Blob(webcamChunksRef.current, { type: 'video/webm' });
              const webcamSizeMB = parseFloat((webcamBlob.size / 1024 / 1024).toFixed(2));
              proctoringLogger.log('s3_upload_started', 'info', { fileType: 'webcam', sizeMB: webcamSizeMB });
              const t0 = Date.now();
              try {
                console.log('📹 Uploading webcam recording:', webcamSizeMB, 'MB');
                webcamKey = await uploadRecording(submissionId, 'webcam', webcamBlob);
                console.log('✅ Webcam uploaded');
                proctoringLogger.log('s3_upload_completed', 'info', {
                  fileType: 'webcam', sizeMB: webcamSizeMB, durationMs: Date.now() - t0,
                });
              } catch (err: any) {
                anyUploadFailed = true;
                console.error('❌ Webcam upload failed:', err.message);
                proctoringLogger.log('s3_upload_failed', 'error', {
                  fileType: 'webcam', sizeMB: webcamSizeMB,
                  durationMs: Date.now() - t0, error: err.message,
                });
              }
            }

            // Upload screen independently
            if (hasScreenChunks) {
              const screenBlob = new Blob(screenChunksRef.current, { type: 'video/webm' });
              const screenSizeMB = parseFloat((screenBlob.size / 1024 / 1024).toFixed(2));
              proctoringLogger.log('s3_upload_started', 'info', { fileType: 'screen', sizeMB: screenSizeMB });
              const t0 = Date.now();
              try {
                console.log('🖥️ Uploading screen recording:', screenSizeMB, 'MB');
                screenKey = await uploadRecording(submissionId, 'screen', screenBlob);
                console.log('✅ Screen uploaded');
                proctoringLogger.log('s3_upload_completed', 'info', {
                  fileType: 'screen', sizeMB: screenSizeMB, durationMs: Date.now() - t0,
                });
              } catch (err: any) {
                anyUploadFailed = true;
                console.error('❌ Screen upload failed:', err.message);
                proctoringLogger.log('s3_upload_failed', 'error', {
                  fileType: 'screen', sizeMB: screenSizeMB,
                  durationMs: Date.now() - t0, error: err.message,
                });
              }
            }

            // Save metadata if at least one upload succeeded
            if (webcamKey || screenKey) {
              try {
                console.log('💾 Saving recording metadata to DynamoDB...');
                proctoringLogger.log('metadata_save_started', 'info', {
                  hasWebcamKey: !!webcamKey, hasScreenKey: !!screenKey,
                });
                await saveRecordingMetadata({ submissionId, webcamKey, screenKey });
                console.log('✅ All proctoring recordings uploaded and metadata saved successfully!');
                proctoringLogger.log('metadata_save_completed', 'info', {});
              } catch (err: any) {
                anyUploadFailed = true;
                console.error('❌ Metadata save failed:', err.message);
                proctoringLogger.log('metadata_save_failed', 'error', { error: err.message });
              }
            } else {
              console.error('❌ Both recording uploads failed — metadata not saved');
              anyUploadFailed = true;
              proctoringLogger.log('metadata_save_skipped', 'error', {
                reason: 'no_successful_uploads',
              });
            }

            if (anyUploadFailed) {
              console.error('⚠️ One or more recording uploads failed for submission:', submissionId);
            }
          }
        } else {
          console.warn('⚠️ Skipping recording upload - missing data:', {
            hasSubmissionId: !!submissionId,
            hasWebcamChunks,
            hasScreenChunks,
            hasRecordingStartTime: !!recordingStartTime
          });
          proctoringLogger.log('upload_skipped', 'warn', {
            reason: 'missing_prerequisites',
            hasSubmissionId: !!submissionId,
            hasWebcamChunks,
            hasScreenChunks,
            hasRecordingStartTime: !!recordingStartTime,
          });
        }

        // Always flush logs to the server — this is the last thing we do
        // regardless of whether uploads succeeded or failed
        await proctoringLogger.flush(sendClientLogs);
        
         const isEmbeddedSubmission = milestone.type === 'embedded';
        
        if (result.submission.underReview) {
          // No score and no results: the instructor decides.
          setOutput(UNDER_REVIEW_MESSAGE);
          setSubmissionStatus('idle');
        } else if (ungradedMessage) {
          setOutput(`${ungradedMessage}\n\nYou can now close the editor.`);
          setSubmissionStatus('idle');
          if (isEmbeddedSubmission) {
            setCode('// Your submitted code is hidden while your submission is under review.\n// It will become visible after the instructor completes the review.');
          }
        } else if (isEmbeddedSubmission) {
          // For embedded assessments, don't reveal score — it's under instructor review
          setOutput(
            `✅ Submission Received\n\n` +
            `Your code has been submitted successfully.\n\n` +
            `Your submission is now under review by the instructor.\n` +
            `Results will be available after the review is complete.\n\n` +
            `You can now close the editor.`
          );
          setSubmissionStatus(status === 'passed' ? 'success' : 'failed');
          setCode('// Your submitted code is hidden while your submission is under review.\n// It will become visible after the instructor completes the review.');
        } else if (status === 'passed') {
          setOutput(
            `🎉 CONGRATULATIONS! 🎉\n\n` +
            `All ${totalTests} test cases passed!\n\n` +
            `✅ Your solution has been accepted\n` +
            `🏆 Your credential will be awarded shortly\n` +
            `📹 Proctoring recordings uploaded to S3\n\n` +
            `Great job! You can now close the editor and move on to the next problem.`
          );
          setSubmissionStatus('success');
        } else {
          setOutput(
            `📊 Submission Results: ${passedTests}/${totalTests} test cases passed\n\n` +
            `❌ Some test cases failed.\n\n` +
            `You can review the results below.`
          );
          setSubmissionStatus('failed');
        }
      } else {
        outcome = { ok: false, error: 'Submission completed but no results received' };
        setOutput('⚠️ Submission completed but no results received. Please try again.');
        setHasSubmitted(true);
      }
    } catch (error: any) {
      outcome = { ok: false, error: error?.message || 'Failed to submit code' };
      console.error('❌ Error submitting code:', error);
      setOutput(
        `❌ Submission Error\n\n` +
        `${error.message || 'Failed to submit code.'}\n\n` +
        `Please check your internet connection and try again.`
      );
      setSubmissionStatus('failed');
      setHasSubmitted(true);
    } finally {
      setIsSubmitting(false);
    }

    onSubmitSettled?.(outcome);
    return outcome;
  };

  // ---- Layout (markup only): the full-window workspace. All handlers and state above are unchanged. ----
  const sessionOpen = !hasSubmitted && !isAlreadyCompleted && !isViewMode;
  const difficultyKey = String(milestone.difficulty).toLowerCase();
  const knownDifficulty = difficultyKey === 'easy' || difficultyKey === 'medium' || difficultyKey === 'hard';

  /**
   * Before the submission the session cannot simply be closed: leaving goes through the existing leave guard, which asks for
   * confirmation and then submits the current code. After the submission this is the old Close button.
   */
  const handleExit = async () => {
    if (sessionOpen) {
      navigate('/');
      return;
    }
    // Call onSubmitSuccess if there was a successful submission
    if (submissionStatus === 'success' && onSubmitSuccess) {
      console.log('✅ Submission successful, refreshing problems list...');
      await onSubmitSuccess();
      console.log('✅ Problems list refreshed');
    }

    console.log('🔄 Closing editor and reloading problems...');
    await onClose();
    console.log('✅ Editor closed and problems updated');
  };

  const sessionNotice = isAlreadyCompleted && completedMilestone ? (() => {
    const reviewStatus = submissionData?.proctoringData?.reviewStatus;
    const isReviewed = reviewStatus === 'approved' || reviewStatus === 'rejected';
    const isEmbeddedType = milestone.type === 'embedded';
    const isApproved = reviewStatus === 'approved';
    const isRejected = reviewStatus === 'rejected';
    const effectiveScore = submissionData?.score;
    const isPassed = isApproved && effectiveScore >= 83;
    // Embedded work is always held for review; coding work only when it was never graded.
    const isHeldCoding = !isEmbeddedType && completedMilestone.heldForReview === true;
    const isUnderReview = !isReviewed && (isEmbeddedType || completedMilestone.gradingFailed === true || completedMilestone.underReview === true);

    let variant: 'info' | 'success' | 'warning' | 'danger';
    let message: string;

    if (isUnderReview) {
      variant = 'info';
      message = 'Submission under review';
    } else if (isHeldCoding && (isApproved || isRejected)) {
      // A problem with the interview, after the instructor's decision.
      variant = isApproved ? 'success' : 'danger';
      message = isApproved ? 'Approved by your instructor' : 'Rejected by your instructor';
    } else if (isEmbeddedType && isApproved && isPassed) {
      variant = 'success';
      message = 'Passed';
    } else if (isEmbeddedType && isApproved) {
      // Approved (reviewed) but below the passing threshold: no credential issued
      variant = 'warning';
      message = 'Reviewed and approved';
    } else if (isEmbeddedType && isRejected) {
      variant = 'danger';
      message = 'Submission rejected';
    } else {
      // Regular coding problem: shown by score
      variant = completedMilestone.score === 100 ? 'success' : 'danger';
      message = completedMilestone.score === 100 ? 'Problem completed successfully' : 'Failed';
    }

    const submittedOn = new Date(completedMilestone.completedAt).toLocaleDateString();
    const instructorFeedback = isHeldCoding && (isApproved || isRejected)
      ? (submissionData?.proctoringData?.rejectionReason || submissionData?.proctoringData?.reviewNotes || null)
      : null;
    return (
      <Alert variant={variant} title={message}>
        <div className={styles.notice}>
          <p className={styles.noticeLine}>
            {isUnderReview
              ? `Submitted on: ${submittedOn}`
              : isEmbeddedType
                ? `Score: ${submissionData?.score}% | Submitted on: ${submittedOn}`
                : `Score: ${completedMilestone.passedTests}/${completedMilestone.totalTests} (${completedMilestone.score}%) | Submitted on: ${submittedOn}`}
          </p>
          <p className={styles.noticeLine}>
            {isUnderReview
              ? (completedMilestone.underReview ? UNDER_REVIEW_MESSAGE : 'Your submission is being reviewed by the instructor. Results will be available after the review is complete.')
              : isHeldCoding && (isApproved || isRejected)
              ? 'Your instructor has reviewed your submission. Viewing your solution in read-only mode.'
              : isEmbeddedType && isPassed
                ? 'You have successfully passed this assessment. Viewing your solution in read-only mode.'
                : isEmbeddedType && isApproved
                  ? 'Your submission was reviewed and approved but did not meet the passing threshold. Viewing your submission in read-only mode.'
                  : isEmbeddedType && isRejected
                    ? 'Your submission was rejected for a policy violation. Please review the feedback below.'
                    : completedMilestone.score === 100
                      ? 'You have successfully completed this problem. Viewing your solution in read-only mode.'
                      : 'You have submitted this problem. Only one submission is allowed per problem. Viewing your submission in read-only mode.'}
          </p>
          {instructorFeedback && (
            <p className={styles.noticeLine}>
              <strong>Instructor feedback:</strong> {instructorFeedback}
            </p>
          )}
          {isEmbeddedType && isRejected && (submissionData?.proctoringData?.rejectionReason || submissionData?.proctoringData?.reviewNotes) && (
            <p className={styles.noticeLine}>
              <strong>Rejection reason:</strong> {submissionData.proctoringData.rejectionReason || submissionData.proctoringData.reviewNotes}
            </p>
          )}
          {isEmbeddedType && isRejected && submissionData?.proctoringData?.policyViolated && (
            <p className={styles.noticeLine}>
              <strong>Policy violated:</strong> {submissionData.proctoringData.policyViolated}
            </p>
          )}
          {isEmbeddedType && isRejected && submissionData?.proctoringData?.rejectionReason && submissionData?.proctoringData?.reviewNotes && submissionData.proctoringData.reviewNotes !== 'Rejected' && (
            <p className={styles.noticeLine}>
              <strong>Instructor notes:</strong> {submissionData.proctoringData.reviewNotes}
            </p>
          )}
        </div>
      </Alert>
    );
  })() : null;

  const descriptionTab = (() => {
    const reviewStatus = submissionData?.proctoringData?.reviewStatus;
    const isReviewed = reviewStatus === 'approved' || reviewStatus === 'rejected';
    const isEmbeddedType = milestone.type === 'embedded';
    const hideDescription = isEmbeddedType && (isViewMode || hasSubmitted) && !isReviewed;

    return (
      <>
        {milestone.concept && <p className={styles.concept}>Concept: {milestone.concept}</p>}

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Problem description</h2>
          {hideDescription ? (
            <p className={styles.locked}>
              Problem details are hidden while your submission is under review.
              They will become available after the instructor completes the review.
            </p>
          ) : (
            <MarkdownText>{milestone.description}</MarkdownText>
          )}
        </section>

        {completedMilestone?.underReview !== true && (<>
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Sample test cases</h2>
          {loadingTestCases ? (
            <p className={styles.hint} role="status">Loading test cases…</p>
          ) : testCasesError ? (
            <Alert variant="danger">{testCasesError}</Alert>
          ) : sampleTestCases.length > 0 ? (
            <>
              <p className={styles.hint}>Use these examples to check your output before submitting.</p>
              {sampleTestCases.map((testCase, index) => (
                <SampleTestBox
                  key={testCase.testCaseId || index}
                  title={`Test case ${index + 1}`}
                  status={sampleStatusFor(run.state, index + 1)}
                >
                  <p className={styles.boxLabel}>Input</p>
                  <pre className={styles.box}>{testCase.input}</pre>
                  <p className={styles.boxLabel}>Expected output</p>
                  <pre className={styles.box}>{testCase.expectedOutput}</pre>
                </SampleTestBox>
              ))}
            </>
          ) : (
            <Alert variant="warning">
              No sample test cases available. Submit your solution to test against hidden test cases.
            </Alert>
          )}
        </section>

        <section className={styles.howTo}>
          <h2 className={styles.howToTitle}>How to test your code?</h2>
          <ol className={styles.howToList}>
            <li> Copy your code and test in onlineGDB</li>
          </ol>
          <div className={styles.buttonRow}>
            <Button
              size="sm"
              variant={copiedToClipboard ? 'secondary' : 'primary'}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('📋 Copy Code button clicked!');
                handleCopyCode();
              }}
            >
              {copiedToClipboard ? 'Copied' : 'Copy code'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('🔗 Open OnlineGDB button clicked!');
                handleOpenInOnlineGDB();
              }}
            >
              Open OnlineGDB
            </Button>
          </div>
        </section>
        </>)}
      </>
    );
  })();

  const resultsTab = (
    <>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Submission results</h2>
        <pre className={styles.results}>{actualOutput || 'Click "Submit" to see results here...'}</pre>

        {submissionStatus === 'success' && milestone.type !== 'embedded' && (
          <div className={styles.accepted}>
            <h3 className={styles.acceptedTitle}>Submission accepted</h3>
            <p>Congratulations! Your credential will be awarded shortly.</p>
          </div>
        )}
      </section>

      {testResults.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Test case results</h2>
          {testResults.map((result, index) => (
            <TestCaseResult key={index} result={result} index={index} />
          ))}
        </section>
      )}

      {/* Rubric breakdown for reviewed embedded submissions */}
      {isViewMode && submissionData?.type === 'embedded' && (() => {
        const reviewStatus = submissionData?.proctoringData?.reviewStatus;
        const isReviewed = reviewStatus === 'approved' || reviewStatus === 'rejected';

        if (!isReviewed || !submissionData.rubricResults) return null;

        return (
          <div className={styles.stack}>
            {reviewStatus === 'rejected' && (
              <Alert variant="danger" title="Submission rejected">
                {(submissionData.proctoringData?.rejectionReason || submissionData.proctoringData?.reviewNotes) && (
                  <>Reason: {submissionData.proctoringData.rejectionReason || submissionData.proctoringData.reviewNotes}</>
                )}
              </Alert>
            )}

            {reviewStatus === 'approved' && (
              <Alert variant="success" title="Submission reviewed and approved">
                {submissionData.originalScore !== undefined && submissionData.originalScore !== submissionData.score && (
                  <>Score adjusted by instructor: {submissionData.originalScore}% → {submissionData.score}%</>
                )}
              </Alert>
            )}

            <section>
              <h2 className={styles.sectionTitle}>AI grading results</h2>
              <p className={styles.scoreLine}>
                Score: {submissionData.passedCriteria}/{submissionData.totalCriteria} criteria ({submissionData.score}%)
              </p>
              <p className={styles.scoreLine}>
                Submitted: {new Date(submissionData.submittedAt || submissionData.createdAt).toLocaleString()}
              </p>
            </section>

            <section>
              <h2 className={styles.sectionTitle}>Grading breakdown</h2>
              {submissionData.rubricResults.map((result: any, index: number) => {
                // Check if this criterion was modified by instructor
                const wasModified = submissionData.criteriaModifications && submissionData.criteriaModifications[index] !== undefined;
                const instructorValue = wasModified ? submissionData.criteriaModifications[index] : result.passed;

                return (
                  <div key={index} className={`${styles.rubricItem} ${instructorValue ? styles.rubricPass : styles.rubricFail}`}>
                    <Badge variant={instructorValue ? 'success' : 'danger'}>{instructorValue ? 'Pass' : 'Fail'}</Badge>
                    <div className={styles.rubricBody}>
                      <p className={styles.rubricCriterion}>
                        {result.criterion}
                        {wasModified && <Badge variant="warning">Updated by instructor</Badge>}
                      </p>
                      <p className={styles.rubricFeedback}>{result.feedback}</p>
                    </div>
                  </div>
                );
              })}
            </section>
          </div>
        );
      })()}
    </>
  );

  return (
    <WorkspaceShell
      label={`Coding workspace: ${milestone.title}`}
      exit={
        <Button
          variant="secondary"
          size="sm"
          onClick={handleExit}
          title={sessionOpen ? 'Leaving asks for confirmation and submits your current code as your final answer' : 'Close the coding environment'}
        >
          {sessionOpen ? 'Exit' : 'Close'}
        </Button>
      }
      title={milestone.title}
      badges={
        <>
          {knownDifficulty && <DifficultyBadge difficulty={difficultyKey as Difficulty} />}
          {isAlreadyCompleted && <Badge variant="success">Completed</Badge>}
        </>
      }
      status={
        isRecording && !isViewMode ? (
          <span className={styles.recording}>
            <span className={styles.recordingDot} aria-hidden="true" />
            Recording
          </span>
        ) : undefined
      }
      actions={
        <Button
          onClick={handleSubmit}
          disabled={isSubmitting || hasSubmitted || isAlreadyCompleted || isViewMode}
          loading={isSubmitting}
          title={
            isViewMode
              ? 'View mode - submission disabled'
              : isAlreadyCompleted
              ? 'Already completed'
              : hasSubmitted
              ? 'Already submitted in this session'
              : 'Submit for final grading (uses Judge0)'
          }
        >
          {isSubmitting ? 'Submitting…' : hasSubmitted ? 'Submitted' : 'Submit'}
        </Button>
      }
      notice={sessionNotice}
    >
      <SplitPane
        dividerLabel="Resize the description and editor panels"
        left={
          <WorkspaceTabs
            label="Problem"
            active={activeTab}
            onChange={setActiveTab}
            tabs={[
              { id: 'description', label: 'Description' },
              { id: 'output', label: 'Submission Results' },
            ]}
          >
            {activeTab === 'description' ? descriptionTab : resultsTab}
          </WorkspaceTabs>
        }
        right={
          <section className={styles.editorPane} aria-label="Code editor">
            <div className={styles.editorHeader}>
              <span>Code editor: {defaultLanguage.toUpperCase()}</span>
              {(isAlreadyCompleted || isViewMode) && <span className={styles.editorMode}>Read only</span>}
              {runAvailable && (
                <RunControls
                  onRun={run.run}
                  onRunSamples={run.runSamples}
                  running={run.running}
                  disabled={hasSubmitted || isSubmitting}
                  disabledReason="Running is closed because you have submitted"
                />
              )}
            </div>

            {/* Monaco Editor */}
            <div className={styles.editorBody}>
              {loadingSubmission && <div className={styles.loadingOverlay} role="status">Loading your submitted code…</div>}
              <Editor
                height="100%"
                language={defaultLanguage}
                value={code}
                onChange={(value) => setCode(value || '')}
                onMount={(editor, monaco) => {
                  // Ctrl+Enter (Cmd+Enter on a Mac) runs the code; the hook ignores it when running is not allowed.
                  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => { void run.run(); });
                }}
                theme="vs-dark"
                options={{
                  minimap: { enabled: false },
                  fontSize: 14,
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 4,
                  wordWrap: 'on',
                  padding: { top: 10 },
                  readOnly: isAlreadyCompleted || isViewMode
                }}
              />
            </div>

            {runAvailable && (
              <RunPanel
                state={run.state}
                input={run.input}
                onInputChange={run.setInput}
                onRun={run.run}
                disabled={hasSubmitted || isSubmitting}
              />
            )}

            {(isAlreadyCompleted || isViewMode) && (
              <div className={`${styles.editorFooter} ${styles.editorFooterView}`}>
                <strong>View mode:</strong> You are viewing your previous submission. Editor is read-only.
              </div>
            )}
          </section>
        }
      />
    </WorkspaceShell>
  );
}

// Helper function to get default starter code based on language
function getDefaultStarterCode(language: string): string {
  const starterCodes: { [key: string]: string } = {
    python: `# Write your solution here
def solution():
    # Your code here
    pass

# Do not modify below this line
if __name__ == "__main__":
    solution()
`,
    javascript: `// Write your solution here
function solution() {
    // Your code here
}

// Do not modify below this line
solution();
`,
    java: `public class Solution {
    // Write your solution here
    public static void main(String[] args) {
        // Your code here
    }
}
`,
    cpp: `#include <iostream>
using namespace std;

// Write your solution here
int main() {
    // Your code here
    return 0;
}
`,
    c: `#include <stdio.h>

// Write your solution here
int main() {
    // Your code here
    return 0;
}
`
  };

  return starterCodes[language] || starterCodes['python'];
}