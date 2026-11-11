import { CodeEditor } from '../CodeEditor';
import { StudentInterviewScreen } from '../interview/StudentInterviewScreen';
import { ProctoringInstructions } from '../proctoring/ProctoringInstructions';
import { BlockingOverlay } from '../ui';
import type { AssessmentSessionState } from '../../hooks/useAssessmentSession';
import { WorkspaceInactiveContext } from '../workspace/WorkspaceInactiveContext';
import { toEditorMilestone } from '../../utils/assessments';

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
          uploading={interviewTarget.uploading === true}
          initialCode={interviewTarget.code}
          onClose={closeInterview}
        />
      )}

      {selectedAssessment && (
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
