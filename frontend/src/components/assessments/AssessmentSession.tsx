import { CodeEditor } from '../CodeEditor';
import { StudentInterviewScreen } from '../interview/StudentInterviewScreen';
import { ProctoringInstructions } from '../proctoring/ProctoringInstructions';
import { BlockingOverlay } from '../ui';
import type { AssessmentSessionState } from '../../hooks/useAssessmentSession';
import { WorkspaceInactiveContext } from '../workspace/WorkspaceInactiveContext';
import { toEditorMilestone } from '../../utils/assessments';
import { SubmissionStatusView } from './SubmissionStatusView';

/** Renders the proctoring setup screen, the editor and the "submitting" overlay for the open assessment. */
export function AssessmentSession({ session }: { session: AssessmentSessionState }) {
  const {
    userProfile,
    selectedAssessment,
    pendingAssessment,
    showProctoringInstructions,
    webcamStream,
    screenStream,
    isSubmittingOnLeave,
    interviewTarget,
    closeInterview,
    editorRef,
    handleProctoringGranted,
    handleProctoringCancelled,
    handleCloseEditor,
    handleSubmitSuccess,
    markSubmitted,
    markSubmissionSettled,
  } = session;

  // Opened later with no streams (view mode) and held for the instructor: the status view replaces the editor.
  const entry = selectedAssessment ? userProfile?.completedMilestones?.find((m) => m.milestoneId === selectedAssessment.milestoneId) : undefined;
  const heldEntry =
    selectedAssessment?.kind === 'coding' && !webcamStream && !screenStream && interviewTarget === null && entry?.heldForReview === true ? entry : null;

  return (
    <>
      {showProctoringInstructions && pendingAssessment && (
        <ProctoringInstructions
          problemTitle={pendingAssessment.title}
          onProceed={handleProctoringGranted}
          onCancel={handleProctoringCancelled}
        />
      )}

      {isSubmittingOnLeave && (
        <BlockingOverlay message="Submitting your work…" detail="Please keep this tab open." />
      )}

      {interviewTarget && (
        <StudentInterviewScreen
          title={interviewTarget.assessment.title}
          submissionId={interviewTarget.submissionId}
          timeLimitMinutes={interviewTarget.assessment.interviewTimeLimitMinutes}
          questionCount={interviewTarget.assessment.interviewQuestionCount}
          // Only the page session that just submitted can take the interview; "Open interview" later only shows what became of it.
          fresh={interviewTarget.uploading !== undefined}
          uploading={interviewTarget.uploading === true}
          initialCode={interviewTarget.code}
          onClose={closeInterview}
        />
      )}

      {/* A submission whose result is held for the instructor: only its status, from the profile (nothing loads, so nothing flashes). */}
      {heldEntry && selectedAssessment && <SubmissionStatusView title={selectedAssessment.title} completed={heldEntry} onClose={handleCloseEditor} />}

      {selectedAssessment && !heldEntry && (
        // While the interview waiting page is up, the editor is still here finishing the recording upload; it is out of reach until it goes.
        <WorkspaceInactiveContext.Provider value={interviewTarget !== null}>
          <CodeEditor
            ref={editorRef}
            onSubmitted={markSubmitted}
            onSubmitSettled={markSubmissionSettled}
            milestone={toEditorMilestone(selectedAssessment)}
            userProfile={userProfile}
            webcamStream={webcamStream}
            screenStream={screenStream}
            onClose={handleCloseEditor}
            onSubmitSuccess={handleSubmitSuccess}
            isViewMode={!webcamStream && !screenStream} // View mode if no streams
          />
        </WorkspaceInactiveContext.Provider>
      )}
    </>
  );
}
