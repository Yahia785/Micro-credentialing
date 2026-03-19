import { useState, useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import { submitCode, getSubmission } from '../api/submissions';
import { submitEmbeddedAssessment } from '../api/embedded-assessments';
import { getTestCases } from '../api/testcases';
import { TestCaseResult } from './TestCaseResult';
import { uploadRecording, saveRecordingMetadata } from '../api/proctoring';
import { fetchAuthSession } from 'aws-amplify/auth';

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
  isViewMode?: boolean; // ADD THIS
}

export function CodeEditor({ 
  milestone, 
  userProfile, 
  webcamStream,
  screenStream,
  onClose, 
  onSubmitSuccess,
  isViewMode = false // ADD THIS with default value
}: CodeEditorProps) {
  // Default language and starter code if not provided
  const defaultLanguage = milestone.language || 'python';
  const defaultStarterCode = milestone.starterCode || getDefaultStarterCode(defaultLanguage);

  const [code, setCode] = useState(defaultStarterCode);
  const [actualOutput, setOutput] = useState('');
  const [testResults, setTestResults] = useState<TestResult[]>([]);
  const [loadingSubmission, setLoadingSubmission] = useState(false); // ADD THIS
  //const [submissionData, setSubmissionData] = useState<any>(null); // ADD THIS
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
            
            // Load the code
            setCode(submission.code);
        //    setSubmissionData(submission);
            
            if (submission.type === 'embedded' && submission.rubricResults) {
              setOutput(
                `AI Grading Results\n\n` +
                `Score: ${submission.passedCriteria}/${submission.totalCriteria} criteria (${submission.score}%)\n` +
                `Submitted: ${new Date(submission.submittedAt || submission.createdAt).toLocaleString()}`
              );
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
    return;
  }
  
  // Prevent starting if already recording
  if (isRecording) {
    console.log('⚠️ Already recording, skipping start');
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
    const webcamMR = new MediaRecorder(webcamStream, {
      mimeType: 'video/webm;codecs=vp9',
      videoBitsPerSecond: 2500000
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
    
    webcamMR.onerror = (e) => {
      console.error('❌ Webcam recorder error:', e);
    };
    
    webcamMR.start(1000); // Collect data every second
    webcamRecorderRef.current = webcamMR; // Use ref instead of setState
    console.log('✅ Webcam recorder started, state:', webcamMR.state);
    
    // Start screen recording
    const screenMR = new MediaRecorder(screenStream, {
      mimeType: 'video/webm;codecs=vp9',
      videoBitsPerSecond: 5000000
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
    
    screenMR.onerror = (e) => {
      console.error('❌ Screen recorder error:', e);
    };
    
    screenMR.start(1000); // Collect data every second
    screenRecorderRef.current = screenMR; // Use ref instead of setState
    console.log('✅ Screen recorder started, state:', screenMR.state);
    
    setIsRecording(true);
    console.log('✅ Recording started successfully at', startTime);
  } catch (err) {
    console.error('❌ Failed to start recording:', err);
  }
};

const stopRecording = () => {
  console.log('⏹️ Stopping proctoring recording...');
  
  if (webcamRecorderRef.current) {
    console.log('Webcam recorder state:', webcamRecorderRef.current.state);
    if (webcamRecorderRef.current.state !== 'inactive') {
      webcamRecorderRef.current.stop();
    }
  }
  
  if (screenRecorderRef.current) {
    console.log('Screen recorder state:', screenRecorderRef.current.state);
    if (screenRecorderRef.current.state !== 'inactive') {
      screenRecorderRef.current.stop();
    }
  }
  
  setIsRecording(false);
  console.log('⏹️ Recording stop initiated');
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
        
        // DEBUG: Log all values to see what's available
        console.log('🔍 DEBUG - Upload Check:', {
          submissionId: submissionId,
          webcamChunksLength: webcamChunksRef.current.length,
          screenChunksLength: screenChunksRef.current.length,
          recordingStartTime: recordingStartTime,
          willUpload: !!(submissionId && webcamChunksRef.current.length > 0 && screenChunksRef.current.length > 0 && recordingStartTime)
        });
        
        // UPLOAD PROCTORING RECORDINGS
        if (submissionId && webcamChunksRef.current.length > 0 && screenChunksRef.current.length > 0 && recordingStartTime) {
          try {
            console.log('📤 Uploading proctoring recordings for submission:', submissionId);
            
            // Get user ID
            const session = await fetchAuthSession();
            const userId = session.tokens?.idToken?.payload.sub as string;
            
            if (!userId) {
              console.error('❌ No user ID found - cannot upload recordings');
            } else {
              // Create blobs from chunks (using refs now!)
              const webcamBlob = new Blob(webcamChunksRef.current, { type: 'video/webm' });
              const screenBlob = new Blob(screenChunksRef.current, { type: 'video/webm' });
              
              console.log('📹 Webcam blob size:', (webcamBlob.size / 1024 / 1024).toFixed(2), 'MB');
              console.log('🖥️ Screen blob size:', (screenBlob.size / 1024 / 1024).toFixed(2), 'MB');
              
              //const completedAt = new Date().toISOString();
              
              // Define completedAt timestamp
                const completedAt = new Date().toISOString();

                // Upload webcam recording
                console.log('📤 Uploading webcam recording...');
                const webcamKey = await uploadRecording(
                  submissionId,
                  'webcam',
                  webcamBlob
                );

                // Upload screen recording
                console.log('📤 Uploading screen recording...');
                const screenKey = await uploadRecording(
                  submissionId,
                  'screen',
                  screenBlob
                );

                // Save metadata to DynamoDB
                console.log('💾 Saving recording metadata to DynamoDB...');
                await saveRecordingMetadata({
                  submissionId,
                  webcamKey,
                  screenKey
                });
              
              console.log('✅ All proctoring recordings uploaded and metadata saved successfully!');
            }
          } catch (uploadErr: any) {
            console.error('❌ Failed to upload proctoring recordings:', uploadErr);
            console.error('Error details:', uploadErr.message);
            // Don't fail the submission if recording upload fails
          }
        } else {
          console.warn('⚠️ Skipping recording upload - missing data:', {
            hasSubmissionId: !!submissionId,
            hasWebcamChunks: webcamChunksRef.current.length > 0,
            hasScreenChunks: screenChunksRef.current.length > 0,
            hasRecordingStartTime: !!recordingStartTime
          });
        }
        
        if (status === 'passed') {
          setOutput(
            `🎉 CONGRATULATIONS! 🎉\n\n` +
            `All ${totalTests} test cases passed!\n\n` +
            `✅ Your solution has been accepted\n` +
            `🏆 Your credential will be awarded shortly\n` +
            `📹 Proctoring recordings uploaded to S3\n\n` +
            `Great job! You can now close the editor and move on to the next problem.`
          );
          setSubmissionStatus('success');
          
          // Don't call onSubmitSuccess here - let the Close button handle it
        } else {
          setOutput(
            `📊 Submission Results: ${passedTests}/${totalTests} test cases passed\n\n` +
            `❌ Some test cases failed.\n\n` +
            `You can review the results below. The Submit button is now disabled.`
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

        {/* Submission Status Banner */}
        {isAlreadyCompleted && completedMilestone && (
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
              Score: {completedMilestone.passedTests}/{completedMilestone.totalTests} ({completedMilestone.score}%) | 
              Submitted on: {new Date(completedMilestone.completedAt).toLocaleDateString()}
            </p>
            <p style={{ margin: '5px 0 0 0', fontSize: '13px', fontStyle: 'italic' }}>
              {completedMilestone.score === 100 
                ? 'You have successfully completed this problem. Viewing your solution in read-only mode.'
                : 'You have submitted this problem. Only one submission is allowed per problem. Viewing your submission in read-only mode.'}
            </p>
          </div>
        )}

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
                  <p style={{ color: '#666', lineHeight: '1.6', whiteSpace: 'pre-wrap' }}>
                    {milestone.description}
                  </p>

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

                  {/* Constraints */}
                  {/* <div style={{
                    marginTop: '20px',
                    padding: '15px',
                    backgroundColor: '#fff3cd',
                    borderRadius: '8px',
                    border: '1px solid #ffc107'
                  }}>
                    <h4 style={{ color: '#856404', marginTop: 0 }}>⚙️ Constraints</h4>
                    <ul style={{ color: '#856404', lineHeight: '1.6', margin: 0 }}>
                      <li>Language: <strong>{defaultLanguage.toUpperCase()}</strong></li>
                      <li>Time Limit: <strong>{milestone.timeLimit || 5000}ms</strong></li>
                      <li>Memory Limit: <strong>{(milestone.memoryLimit || 256000) / 1024}MB</strong></li>
                    </ul>
                  </div> */}
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
                  
                  {submissionStatus === 'success' && (
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
                  readOnly: isAlreadyCompleted || isViewMode // ADD isViewMode
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