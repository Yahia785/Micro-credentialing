import { useState, useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import { submitCode, getSubmission } from '../api/submissions';
import { submitEmbeddedAssessment } from '../api/embedded-assessments';
import { getTestCases } from '../api/testcases';
import { TestCaseResult } from './TestCaseResult';
import { uploadRecording, saveRecordingMetadata, sendClientLogs } from '../api/proctoring';
import { fetchAuthSession } from 'aws-amplify/auth';
import { proctoringLogger } from '../utils/proctoringLogger';

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

interface CodeEditorProps {
  milestone: Milestone;
  userProfile: any;
  webcamStream: MediaStream | null;
  screenStream: MediaStream | null;
  onClose: () => void;
  onSubmitSuccess?: () => void;
  isViewMode?: boolean;
}

export function CodeEditor({ 
  milestone, 
  userProfile, 
  webcamStream,
  screenStream,
  onClose, 
  onSubmitSuccess,
  isViewMode = false
}: CodeEditorProps) {
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

  // Determine if this is an embedded assessment
  const isEmbedded = milestone.type === 'embedded';

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
                const originalScore = submission.originalScore ?? submission.score;
                const wasAdjusted = submission.originalScore !== undefined && submission.originalScore !== submission.score;
                setOutput(
                  `AI Grading Results\n\n` +
                  `Score: ${submission.passedCriteria}/${submission.totalCriteria} criteria (${originalScore}%)\n` +
                  (wasAdjusted ? `Note: Score adjusted by instructor to ${submission.score}%\n` : '') +
                  `Submitted: ${new Date(submission.submittedAt || submission.createdAt).toLocaleString()}`
                );
              } else {
                setOutput(
                  `Your submission has been recorded and is under review by the instructor.\n\n` +
                  `Results will be available after the review is complete.`
                );
              }
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

  // Lock body scroll when modal is open
  useEffect(() => {
    // Save original body overflow
    const originalOverflow = document.body.style.overflow;
    
    // Lock scroll
    document.body.style.overflow = 'hidden';
    
    // Cleanup: restore original overflow when component unmounts
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, []);

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
    // Different confirmation dialog for embedded vs Judge0
    const confirmMessage = isEmbedded
      ? '⚠️ Are you sure you want to submit?\n\n' +
        'Make sure your code is complete and ready for grading.\n\n' +
        'You cannot change your submission after this point.'
      : '⚠️ IMPORTANT: Before submitting, make sure:\n\n' +
        '✅ You tested your code in OnlineGDB\n' +
        '✅ Your code works with the sample test cases\n' +
        '✅ You copied your final code back to this editor\n\n' +
        'This submission will use Judge0 to test your code against all test cases (including hidden ones).\n\n' +
        'Continue with submission?';

    if (!window.confirm(confirmMessage)) {
      return;
    }

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
          code
        );
        // Shape the result to match the existing flow
        result = {
          submission: {
            submissionId: embeddedResult.submissionId,
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
        });
      }

      console.log('✅ Submission result:', result);

      if (result.error) {
        setOutput(`❌ Error: ${result.error}`);
        setSubmissionStatus('failed');
        setHasSubmitted(true);
      } else if (result.submission) {
        const { status, passedTests, totalTests, testResults: submissionResults, submissionId } = result.submission;
        
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
        
        if (isEmbeddedSubmission) {
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
        setOutput('⚠️ Submission completed but no results received. Please try again.');
        setHasSubmitted(true);
      }
    } catch (error: any) {
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
  };

  const getDifficultyColor = (difficulty: string) => {
    switch (difficulty.toLowerCase()) {
      case 'easy':
        return '#28a745';
      case 'medium':
        return '#ffc107';
      case 'hard':
        return '#dc3545';
      default:
        return '#6c757d';
    }
  };

  return (
    <div 
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 1000,
        padding: '20px',
        overflow: 'hidden'
      }}
      onClick={(e) => {
        // Prevent clicks on overlay from propagating
        if (e.target === e.currentTarget) {
          e.stopPropagation();
        }
      }}
      onWheel={(e) => {
        // Prevent scroll events from propagating to background
        e.stopPropagation();
      }}
      onTouchMove={(e) => {
        // Prevent touch scroll on mobile
        e.stopPropagation();
      }}
    >
      <div style={{
        backgroundColor: 'white',
        borderRadius: '12px',
        width: '100%',
        maxWidth: '1400px',
        height: '90vh',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 10px 40px rgba(0, 0, 0, 0.3)'
      }}>
        {/* Header */}
        <div style={{
          padding: '20px 30px',
          borderBottom: '2px solid #e0e0e0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          backgroundColor: '#f8f9fa'
        }}>
          <div style={{ display: 'flex', gap: '15px', flexDirection: 'column', alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
              <h2 style={{ margin: 0, color: '#333' }}>{milestone.title}</h2>
              <span style={{
                backgroundColor: getDifficultyColor(milestone.difficulty),
                color: 'white',
                padding: '6px 12px',
                borderRadius: '4px',
                fontSize: '14px',
                fontWeight: 'bold',
                textTransform: 'capitalize'
              }}>
                {milestone.difficulty}
              </span>
              {isAlreadyCompleted && (
                <span style={{
                  backgroundColor: '#28a745',
                  color: 'white',
                  padding: '6px 12px',
                  borderRadius: '4px',
                  fontSize: '14px',
                  fontWeight: 'bold'
                }}>
                  ✅ Completed
                </span>
              )}
            </div>
            {milestone.concept && (
              <p style={{
                margin: 0,
                color: '#007bff',
                fontSize: '14px',
                fontWeight: '500',
                fontStyle: 'italic'
              }}>
                📚 Concept: {milestone.concept}
              </p>
            )}
          </div>
          <button
            onClick={async () => {
              // Call onSubmitSuccess if there was a successful submission
              if (submissionStatus === 'success' && onSubmitSuccess) {
                console.log('✅ Submission successful, refreshing problems list...');
                await onSubmitSuccess();
                console.log('✅ Problems list refreshed');
              }
              
              console.log('🔄 Closing editor and reloading problems...');
              await onClose();
              console.log('✅ Editor closed and problems updated');
            }}
            disabled={!hasSubmitted && !isAlreadyCompleted && !isViewMode}
            style={{
              padding: '8px 16px',
              backgroundColor: (!hasSubmitted && !isAlreadyCompleted && !isViewMode) ? '#dee2e6' : '#6c757d',
              color: (!hasSubmitted && !isAlreadyCompleted && !isViewMode) ? '#6c757d' : 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: (!hasSubmitted && !isAlreadyCompleted && !isViewMode) ? 'not-allowed' : 'pointer',
              fontSize: '14px',
              fontWeight: 'bold',
              opacity: (!hasSubmitted && !isAlreadyCompleted && !isViewMode) ? 0.6 : 1
            }}
            title={
              (!hasSubmitted && !isAlreadyCompleted && !isViewMode)
                ? '🔒 You must submit before closing'
                : 'Close coding environment'
            }
          >
            {(!hasSubmitted && !isAlreadyCompleted && !isViewMode) ? '🔒 Submit First' : 'Close'}
          </button>
        </div>

        {isAlreadyCompleted && completedMilestone && (() => {
          const reviewStatus = submissionData?.proctoringData?.reviewStatus;
          const isEmbeddedType = milestone.type === 'embedded';

          if (isEmbeddedType) {
            if (!reviewStatus || reviewStatus === 'pending') {
              return (
                <div style={{
                  padding: '15px 30px',
                  backgroundColor: '#e7f3ff',
                  borderBottom: '2px solid #007bff',
                  color: '#004085'
                }}>
                  <strong>📋 Submission Under Review</strong>
                  <p style={{ margin: '5px 0 0 0', fontSize: '14px' }}>
                    Submitted on: {new Date(completedMilestone.completedAt).toLocaleDateString()}
                  </p>
                  <p style={{ margin: '5px 0 0 0', fontSize: '13px', fontStyle: 'italic' }}>
                    Your submission is being reviewed by the instructor. Results will be available after the review is complete.
                  </p>
                </div>
              );
            }

            if (reviewStatus === 'approved') {
              const effectiveScore = submissionData?.score;
              const passed = effectiveScore >= 83;
              return (
                <div style={{
                  padding: '15px 30px',
                  backgroundColor: passed ? '#d4edda' : '#fff3cd',
                  borderBottom: `2px solid ${passed ? '#28a745' : '#ffc107'}`,
                  color: passed ? '#155724' : '#856404'
                }}>
                  <strong>{passed ? '✅ Passed' : '📝 Reviewed & Approved'}</strong>
                  <p style={{ margin: '5px 0 0 0', fontSize: '14px' }}>
                    Score: {effectiveScore}% | Submitted on: {new Date(completedMilestone.completedAt).toLocaleDateString()}
                  </p>
                  <p style={{ margin: '5px 0 0 0', fontSize: '13px', fontStyle: 'italic' }}>
                    {passed
                      ? 'You have successfully passed this assessment. Viewing your solution in read-only mode.'
                      : 'Your submission was reviewed and approved but did not meet the passing threshold. Viewing your submission in read-only mode.'}
                  </p>
                </div>
              );
            }

            if (reviewStatus === 'rejected') {
              return (
                <div style={{
                  padding: '15px 30px',
                  backgroundColor: '#f8d7da',
                  borderBottom: '2px solid #dc3545',
                  color: '#721c24'
                }}>
                  <strong>❌ Submission Rejected</strong>
                  <p style={{ margin: '5px 0 0 0', fontSize: '14px' }}>
                    Submitted on: {new Date(completedMilestone.completedAt).toLocaleDateString()}
                  </p>
                  {submissionData?.proctoringData?.rejectionReason && (
                    <p style={{ margin: '5px 0 0 0', fontSize: '13px', fontWeight: 'bold' }}>
                      Rejection reason: {submissionData.proctoringData.rejectionReason}
                    </p>
                  )}
                  {submissionData?.proctoringData?.reviewNotes && submissionData.proctoringData.reviewNotes !== 'Rejected' && (
                    <p style={{ margin: '5px 0 0 0', fontSize: '13px' }}>
                      Notes: {submissionData.proctoringData.reviewNotes}
                    </p>
                  )}
                </div>
              );
            }
          }

          return (
            <div style={{
              padding: '15px 30px',
              backgroundColor: completedMilestone.score === 100 ? '#d4edda' : '#f8d7da',
              borderBottom: `2px solid ${completedMilestone.score === 100 ? '#28a745' : '#dc3545'}`,
              color: completedMilestone.score === 100 ? '#155724' : '#721c24'
            }}>
              <strong>
                {completedMilestone.score === 100
                  ? '🏆 Problem Completed Successfully!'
                  : '📝 Submission Recorded'}
              </strong>
              <p style={{ margin: '5px 0 0 0', fontSize: '14px' }}>
                Score: {completedMilestone.passedTests}/{completedMilestone.totalTests} ({completedMilestone.score}%) | Submitted on: {new Date(completedMilestone.completedAt).toLocaleDateString()}
              </p>
              <p style={{ margin: '5px 0 0 0', fontSize: '13px', fontStyle: 'italic' }}>
                {completedMilestone.score === 100
                  ? 'You have successfully completed this problem. Viewing your solution in read-only mode.'
                  : 'You have submitted this problem. Only one submission is allowed per problem. Viewing your submission in read-only mode.'}
              </p>
            </div>
          );
        })()}

        {/* Main Content Area */}
        <div style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          overflow: 'hidden'
        }}>
          {/* Left Panel: Problem Description / Output */}
          <div style={{
            borderRight: '2px solid #e0e0e0',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0
          }}>
            {/* Tabs */}
            <div style={{
              display: 'flex',
              borderBottom: '2px solid #e0e0e0',
              backgroundColor: '#f8f9fa'
            }}>
              <button
                onClick={() => setActiveTab('description')}
                style={{
                  flex: 1,
                  padding: '15px',
                  border: 'none',
                  backgroundColor: activeTab === 'description' ? 'white' : 'transparent',
                  borderBottom: activeTab === 'description' ? '3px solid #007bff' : 'none',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: activeTab === 'description' ? 'bold' : 'normal',
                  color: activeTab === 'description' ? '#007bff' : '#666'
                }}
              >
                📋 Description
              </button>
              <button
                onClick={() => setActiveTab('output')}
                style={{
                  flex: 1,
                  padding: '15px',
                  border: 'none',
                  backgroundColor: activeTab === 'output' ? 'white' : 'transparent',
                  borderBottom: activeTab === 'output' ? '3px solid #007bff' : 'none',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: activeTab === 'output' ? 'bold' : 'normal',
                  color: activeTab === 'output' ? '#007bff' : '#666'
                }}
              >
                📊 Submission Results
              </button>
            </div>

            {/* Tab Content */}
            <div style={{
              flex: 1,
              minHeight: 0,
              overflow: 'auto',
              padding: '20px'
            }}>
              {activeTab === 'description' ? (
                <div>
                  <h3 style={{ color: '#333', marginTop: 0 }}>Problem Description</h3>
                  {(() => {
                    const reviewStatus = submissionData?.proctoringData?.reviewStatus;
                    const isReviewed = reviewStatus === 'approved' || reviewStatus === 'rejected';
                    const isEmbeddedType = milestone.type === 'embedded';
                   const hideDescription = isEmbeddedType && (isViewMode || hasSubmitted) && !isReviewed;
                    
                    if (hideDescription) {
                      return (
                        <div style={{
                          padding: '20px',
                          backgroundColor: '#e7f3ff',
                          borderRadius: '8px',
                          border: '1px solid #b8daff',
                          color: '#004085',
                          textAlign: 'center'
                        }}>
                          <p style={{ fontSize: '16px', margin: '0 0 8px 0' }}>🔒</p>
                          <p style={{ margin: 0, lineHeight: '1.6' }}>
                            Problem details are hidden while your submission is under review.
                            They will become available after the instructor completes the review.
                          </p>
                        </div>
                      );
                    }
                    return (
                      <p style={{ color: '#666', lineHeight: '1.6', whiteSpace: 'pre-wrap' }}>
                        {milestone.description}
                      </p>
                    );
                  })()}

                  {/* Sample Test Cases */}
                  {loadingTestCases ? (
                    <div style={{
                      marginTop: '20px',
                      padding: '15px',
                      backgroundColor: '#f8f9fa',
                      borderRadius: '8px',
                      border: '1px solid #e0e0e0',
                      textAlign: 'center',
                      color: '#666'
                    }}>
                      Loading test cases...
                    </div>
                  ) : testCasesError ? (
                    <div style={{
                      marginTop: '20px',
                      padding: '15px',
                      backgroundColor: '#f8d7da',
                      borderRadius: '8px',
                      border: '1px solid #f5c6cb',
                      color: '#721c24'
                    }}>
                      ⚠️ {testCasesError}
                    </div>
                  ) : sampleTestCases.length > 0 ? (
                    <div style={{
                      marginTop: '20px',
                      padding: '15px',
                      backgroundColor: '#f8f9fa',
                      borderRadius: '8px',
                      border: '1px solid #e0e0e0'
                    }}>
                      <h4 style={{ color: '#333', marginTop: 0 }}>📝 Sample Test Cases</h4>
                      <p style={{ color: '#666', fontSize: '13px', marginBottom: '15px' }}>
                        Use these examples to test your code in OnlineGDB before submitting.
                      </p>
                      {sampleTestCases.map((testCase, index) => (
                        <div key={testCase.testCaseId || index} style={{ marginBottom: '15px' }}>
                          <p style={{ margin: '5px 0', color: '#666', fontWeight: 'bold' }}>
                            Test Case {index + 1}:
                          </p>
                          <div style={{ margin: '5px 0', color: '#666' }}>
                            <strong>Input:</strong>
                            <pre style={{
                              background: '#fff',
                              padding: '8px',
                              borderRadius: '4px',
                              margin: '5px 0',
                              fontSize: '13px',
                              color: '#333',
                              border: '1px solid #dee2e6'
                            }}>
                              {testCase.input}
                            </pre>
                          </div>
                          <div style={{ margin: '5px 0', color: '#666' }}>
                            <strong>Expected Output:</strong>
                            <pre style={{
                              background: '#fff',
                              padding: '8px',
                              borderRadius: '4px',
                              margin: '5px 0',
                              fontSize: '13px',
                              color: '#333',
                              border: '1px solid #dee2e6'
                            }}>
                              {testCase.expectedOutput}
                            </pre>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{
                      marginTop: '20px',
                      padding: '15px',
                      backgroundColor: '#fff3cd',
                      borderRadius: '8px',
                      border: '1px solid #ffc107',
                      color: '#856404'
                    }}>
                      ℹ️ No sample test cases available. Submit your solution to test against hidden test cases.
                    </div>
                  )}

                  {/* Instructions */}
                  <div style={{
                    marginTop: '20px',
                    padding: '15px',
                    backgroundColor: '#e7f3ff',
                    borderRadius: '8px',
                    border: '2px solid #0066cc'
                  }}>
                    <h4 style={{ color: '#0066cc', marginTop: 0 }}> How to test your code? </h4>
                    <ol style={{ color: '#333', lineHeight: '1.8', paddingLeft: '20px' }}>
                      <li> Copy your code and test in onlineGDB</li>
                    </ol>

                    <div style={{
                      display: 'flex',
                      gap: '10px',
                      marginTop: '15px',
                      flexWrap: 'wrap'
                    }}>
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          console.log('📋 Copy Code button clicked!');
                          handleCopyCode();
                        }}
                        style={{
                          padding: '12px 20px',
                          background: copiedToClipboard ? '#28a745' : '#007bff',
                          color: 'white',
                          border: 'none',
                          borderRadius: '6px',
                          cursor: 'pointer',
                          fontSize: '14px',
                          fontWeight: 'bold',
                          transition: 'background 0.3s',
                          boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
                          pointerEvents: 'auto'
                        }}
                      >
                        {copiedToClipboard ? '✅ Copied!' : '📋 Copy Code'}
                      </button>

                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          console.log('🔗 Open OnlineGDB button clicked!');
                          handleOpenInOnlineGDB();
                        }}
                        style={{
                          padding: '12px 20px',
                          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                          color: 'white',
                          border: 'none',
                          borderRadius: '6px',
                          cursor: 'pointer',
                          fontSize: '14px',
                          fontWeight: 'bold',
                          boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
                          transition: 'transform 0.2s',
                          pointerEvents: 'auto'
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.transform = 'translateY(-2px)';
                          e.currentTarget.style.boxShadow = '0 6px 12px rgba(0,0,0,0.15)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.transform = 'translateY(0)';
                          e.currentTarget.style.boxShadow = '0 4px 6px rgba(0,0,0,0.1)';
                        }}
                      >
                        🔗 Open OnlineGDB
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div>
                  <h3 style={{ color: '#333', marginTop: 0 }}>Submission Results</h3>
                  <pre style={{
                    backgroundColor: '#f5f5f5',
                    padding: '15px',
                    borderRadius: '8px',
                    overflow: 'auto',
                    fontSize: '14px',
                    lineHeight: '1.5',
                    color: '#333',
                    minHeight: '100px',
                    border: '1px solid #e0e0e0',
                    whiteSpace: 'pre-wrap'
                  }}>
                    {actualOutput || 'Click "Submit" to see results here...'}
                  </pre>
                  
                 {submissionStatus === 'success' && milestone.type !== 'embedded' && (
                    <div style={{
                      marginTop: '20px',
                      padding: '20px',
                      backgroundColor: '#d4edda',
                      borderRadius: '8px',
                      border: '2px solid #28a745',
                      textAlign: 'center'
                    }}>
                      <div style={{ fontSize: '48px', marginBottom: '10px' }}>🎉</div>
                      <h3 style={{ color: '#155724', margin: '0 0 10px 0' }}>
                        Submission Accepted!
                      </h3>
                      <p style={{ color: '#155724', margin: 0, fontSize: '16px' }}>
                        Congratulations! Your credential will be awarded shortly.
                      </p>
                    </div>
                  )}

                  {testResults.length > 0 && (
                    <div style={{ marginTop: '20px' }}>
                      <h3 style={{ color: '#333' }}>Test Case Results</h3>
                      {testResults.map((result, index) => (
                        <TestCaseResult key={index} result={result} index={index} />
                      ))}
                    </div>
                  )}

                  {/* Rubric breakdown for reviewed embedded submissions */}
                  {isViewMode && submissionData?.type === 'embedded' && (() => {
                    const reviewStatus = submissionData?.proctoringData?.reviewStatus;
                    const isReviewed = reviewStatus === 'approved' || reviewStatus === 'rejected';
                    
                    if (!isReviewed || !submissionData.rubricResults) return null;
                    
                    return (
                      <div style={{ marginTop: '20px' }}>
                        {/* Rejection reason banner */}
                        {reviewStatus === 'rejected' && (
                          <div style={{
                            padding: '15px',
                            backgroundColor: '#f8d7da',
                            borderRadius: '8px',
                            border: '1px solid #f5c6cb',
                            marginBottom: '15px',
                            color: '#721c24'
                          }}>
                            <strong>❌ Submission Rejected</strong>
                            {(submissionData.proctoringData?.rejectionReason || submissionData.proctoringData?.reviewNotes) && (
                              <p style={{ margin: '8px 0 0 0', fontSize: '14px' }}>
                                Reason: {submissionData.proctoringData.rejectionReason || submissionData.proctoringData.reviewNotes}
                              </p>
                            )}
                          </div>
                        )}
                        
                        {reviewStatus === 'approved' && (
                          <div style={{
                            padding: '15px',
                            backgroundColor: '#d4edda',
                            borderRadius: '8px',
                            border: '1px solid #c3e6cb',
                            marginBottom: '15px',
                            color: '#155724'
                          }}>
                            <strong>✅ Submission Reviewed & Approved</strong>
                            {submissionData.originalScore !== undefined && submissionData.originalScore !== submissionData.score && (
                              <p style={{ margin: '8px 0 0 0', fontSize: '14px' }}>
                                Score adjusted by instructor: {submissionData.originalScore}% → {submissionData.score}%
                              </p>
                            )}
                            {(() => {
                              const notes = submissionData.proctoringData?.reviewNotes;
                              const isDefault = !notes || notes === 'Approved' || notes === 'Approved by admin';
                              return !isDefault ? (
                                <p style={{ margin: '8px 0 0 0', fontSize: '14px' }}>
                                  Instructor notes: {notes}
                                </p>
                              ) : null;
                            })()}
                          </div>
                        )}

                        <div style={{
                          padding: '12px 15px',
                          backgroundColor: '#f8f9fa',
                          borderRadius: '6px',
                          border: '1px solid #e0e0e0',
                          marginBottom: '12px'
                        }}>
                          <strong style={{ color: '#333', fontSize: '14px' }}>AI Grading Results</strong>
                          <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: '#555' }}>
                            Score: {submissionData.passedCriteria}/{submissionData.totalCriteria} criteria ({submissionData.originalScore ?? submissionData.score}%)
                          </p>
                        </div>

                        <h3 style={{ color: '#333' }}>Grading Breakdown</h3>
                        {submissionData.rubricResults.map((result: any, index: number) => {
                          const instructorOverride = submissionData.criteriaModifications?.[index];
                          const effectivePassed = instructorOverride !== undefined ? instructorOverride : result.passed;
                          const wasOverridden = instructorOverride !== undefined && instructorOverride !== result.passed;
                          return (
                            <div
                              key={index}
                              style={{
                                display: 'flex', alignItems: 'flex-start', gap: '10px',
                                padding: '10px', marginBottom: '8px',
                                background: effectivePassed ? '#d4edda' : '#f8d7da',
                                borderRadius: '6px',
                                border: `1px solid ${effectivePassed ? '#c3e6cb' : '#f5c6cb'}`
                              }}
                            >
                              <span style={{
                                background: effectivePassed ? '#28a745' : '#dc3545',
                                color: 'white', padding: '2px 8px', borderRadius: '4px',
                                fontSize: '11px', whiteSpace: 'nowrap', flexShrink: 0
                              }}>
                                {effectivePassed ? '✓' : '✗'}
                              </span>
                              <div>
                                <p style={{ margin: '0 0 4px 0', color: '#333', fontSize: '13px', fontWeight: 'bold' }}>
                                  {result.criterion}
                                  {wasOverridden && (
                                    <span style={{
                                      marginLeft: '8px',
                                      fontSize: '11px',
                                      fontWeight: 'normal',
                                      backgroundColor: '#6c757d',
                                      color: 'white',
                                      padding: '1px 6px',
                                      borderRadius: '3px'
                                    }}>
                                      Updated by Instructor
                                    </span>
                                  )}
                                </p>
                                <p style={{ margin: 0, color: '#555', fontSize: '13px' }}>
                                  {result.feedback}
                                </p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          </div>

          {/* Right Panel: Code Editor */}
          <div style={{
            display: 'flex',
            flexDirection: 'column'
          }}>
            {/* Editor Header */}
            <div style={{
              padding: '15px 20px',
              backgroundColor: '#f8f9fa',
              borderBottom: '2px solid #e0e0e0',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <span style={{
                fontSize: '14px',
                fontWeight: 'bold',
                color: '#333'
              }}>
                💻 Code Editor - {defaultLanguage.toUpperCase()}
              </span>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  onClick={handleSubmit}
                  disabled={isSubmitting || hasSubmitted || isAlreadyCompleted || isViewMode}
                  style={{
                    padding: '10px 20px',
                    backgroundColor: (isSubmitting || hasSubmitted || isAlreadyCompleted) ? '#6c757d' : '#28a745',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: (isSubmitting || hasSubmitted || isAlreadyCompleted) ? 'not-allowed' : 'pointer',
                    fontSize: '14px',
                    fontWeight: 'bold',
                    opacity: (isSubmitting || hasSubmitted || isAlreadyCompleted) ? 0.6 : 1
                  }}
                  title={
                    isViewMode
                      ? 'View mode - submission disabled'
                      : isAlreadyCompleted 
                      ? 'Already completed'
                      : hasSubmitted
                      ? 'Already submitted in this session'
                      : isEmbedded
                      ? 'Submit for LLM rubric grading'
                      : 'Submit for final grading (uses Judge0)'
                  }
                >
                  {isSubmitting ? '⏳ Submitting...' : hasSubmitted ? '🔒 Submitted' : '✅ Submit'}
                </button>
              </div>
            </div>

            {/* Monaco Editor */}
            <div style={{ flex: 1, position: 'relative' }}>
              {loadingSubmission && (
                <div style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  backgroundColor: 'rgba(0, 0, 0, 0.7)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  zIndex: 10,
                  color: 'white',
                  fontSize: '16px',
                  fontWeight: 'bold'
                }}>
                  📖 Loading your submitted code...
                </div>
              )}
              <Editor
                height="100%"
                language={defaultLanguage}
                value={code}
                onChange={(value) => setCode(value || '')}
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

            {/* Editor Footer with Instructions */}
            <div style={{
              padding: '15px 20px',
              backgroundColor: (isAlreadyCompleted || isViewMode) ? '#d4edda' : '#fff3cd',
              borderTop: `2px solid ${(isAlreadyCompleted || isViewMode) ? '#28a745' : '#ffc107'}`,
              fontSize: '13px',
              color: (isAlreadyCompleted || isViewMode) ? '#155724' : '#856404'
            }}>
              <strong>💡 {(isAlreadyCompleted || isViewMode) ? 'View Mode' : 'Workflow'}:</strong> {
                (isAlreadyCompleted || isViewMode)
                  ? 'You are viewing your previous submission. Editor is read-only.'
                  : isEmbedded
                  ? 'Write your embedded C solution → Submit for AI rubric grading'
                  : 'Copy code → Test in OnlineGDB → Paste final solution here → Submit'
              }
            </div>
          </div>
        </div>
      </div>
    </div>
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