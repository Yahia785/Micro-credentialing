import { useEffect, useRef, useState } from 'react';
import { getSubmission } from '../api/submissions';
import type { CodeEditorHandle } from '../components/CodeEditor';
import { useUser } from '../context/UserContext';
import type { Assessment } from '../types/assessment';
import { useAssessmentNavigationGuard } from './useAssessmentNavigationGuard';
import { useStopStreamsOnUnmount } from './useStopStreamsOnUnmount';

/**
 * The proctored-session logic shared by every kind of assessment: the proctoring permission flow,
 * the camera/screen streams, the navigation guard with its leave-and-auto-submit flow, and the
 * completed / view-mode checks. Moved here unchanged from the two old tabs.
 *
 * @param reload Reloads the assessment list (called when the editor closes or a submission succeeds).
 */
export function useAssessmentSession(reload: () => Promise<void>) {
  const { userProfile, refreshProfile } = useUser();

  const [selectedAssessment, setSelectedAssessment] = useState<Assessment | null>(null);
  const [pendingAssessment, setPendingAssessment] = useState<Assessment | null>(null);
  const [showProctoringInstructions, setShowProctoringInstructions] = useState(false);
  const [webcamStream, setWebcamStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  // True once the editor's own submission has fully finished; nothing is left to lose by leaving.
  const [submissionSettled, setSubmissionSettled] = useState(false);

  // A proctored session is live while the editor is open with streams and nothing has been submitted yet.
  const isProctoredSessionActive = Boolean(
    selectedAssessment &&
      (webcamStream || screenStream) &&
      !submissionSettled &&
      !userProfile?.completedMilestones?.some((m) => m.milestoneId === selectedAssessment.milestoneId)
  );
  const editorRef = useRef<CodeEditorHandle>(null);
  // Leaving mid-session counts as submitting the current code.
  const { isSubmitting: isSubmittingOnLeave } = useAssessmentNavigationGuard(
    isProctoredSessionActive,
    async () => (await editorRef.current?.submitAndEnd('left_page')) ?? { ok: true },
    // Otherwise the list still shows the assessment as not attempted after leaving.
    refreshProfile
  );
  useStopStreamsOnUnmount(webcamStream, screenStream);

  const openAssessment = (assessment: Assessment) => {
    // Check if the assessment is already completed
    const isCompleted = userProfile?.completedMilestones?.some(
      (m) => m.milestoneId === assessment.milestoneId
    );

    if (isCompleted) {
      // Skip proctoring for completed work: open directly in view mode (no streams)
      setSelectedAssessment(assessment);
      setWebcamStream(null);
      setScreenStream(null);
    } else {
      // Show proctoring instructions for unsolved work
      setPendingAssessment(assessment);
      setShowProctoringInstructions(true);
    }
  };

  const handleProctoringGranted = (webcam: MediaStream, screen: MediaStream) => {
    setWebcamStream(webcam);
    setScreenStream(screen);
    setSubmissionSettled(false);
    setShowProctoringInstructions(false);

    if (pendingAssessment) {
      setSelectedAssessment(pendingAssessment);
    }
  };

  const handleProctoringCancelled = () => {
    setShowProctoringInstructions(false);
    setPendingAssessment(null);
  };

  const handleCloseEditor = async () => {
    // Stop recording streams when closing the editor
    if (webcamStream) {
      webcamStream.getTracks().forEach((track) => track.stop());
      setWebcamStream(null);
    }
    if (screenStream) {
      screenStream.getTracks().forEach((track) => track.stop());
      setScreenStream(null);
    }

    await reload();
    await refreshProfile();

    setSubmissionSettled(false);
    setSelectedAssessment(null);
    setPendingAssessment(null);
  };

  const handleSubmitSuccess = async () => {
    await reload();
    await refreshProfile();
  };

  return {
    userProfile,
    selectedAssessment,
    pendingAssessment,
    showProctoringInstructions,
    webcamStream,
    screenStream,
    isSubmittingOnLeave,
    editorRef,
    openAssessment,
    handleProctoringGranted,
    handleProctoringCancelled,
    handleCloseEditor,
    handleSubmitSuccess,
    markSubmissionSettled: () => setSubmissionSettled(true),
  };
}

export type AssessmentSessionState = ReturnType<typeof useAssessmentSession>;

/**
 * Review status ('pending' | 'approved' | 'rejected') of the student's submission for each completed
 * embedded assessment. Same requests and fallbacks as the old embedded tab.
 */
export function useEmbeddedReviewStatuses(assessments: Assessment[]) {
  const { userProfile } = useUser();
  const [statuses, setStatuses] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;

    const loadSubmissionStatuses = async () => {
      try {
        const next: Record<string, string> = {};

        for (const assessment of assessments) {
          if (assessment.kind !== 'embedded') continue;

          const completedData = userProfile?.completedMilestones?.find(
            (m) => m.milestoneId === assessment.milestoneId
          );

          if (completedData?.submissionId) {
            try {
              const data = await getSubmission(completedData.submissionId);
              next[assessment.milestoneId] = data.submission?.proctoringData?.reviewStatus || 'pending';
            } catch (err) {
              // Leave this one unset (shown as under review) and keep going.
              console.error('Failed to load submission status:', err);
            }
          }
        }

        if (!cancelled) setStatuses(next);
      } catch (err) {
        console.error('Failed to load submission statuses:', err);
      }
    };

    loadSubmissionStatuses();
    return () => {
      cancelled = true;
    };
  }, [assessments, userProfile]);

  return statuses;
}
