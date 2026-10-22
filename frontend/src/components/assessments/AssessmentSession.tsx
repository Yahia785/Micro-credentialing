import { CodeEditor } from '../CodeEditor';
import { ProctoringInstructions } from '../proctoring/ProctoringInstructions';
import { BlockingOverlay } from '../ui';
import type { AssessmentSessionState } from '../../hooks/useAssessmentSession';
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
    editorRef,
    handleProctoringGranted,
    handleProctoringCancelled,
    handleCloseEditor,
    handleSubmitSuccess,
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

      {selectedAssessment && (
        <CodeEditor
          ref={editorRef}
          onSubmitSettled={markSubmissionSettled}
          milestone={toEditorMilestone(selectedAssessment)}
          userProfile={userProfile}
          webcamStream={webcamStream}
          screenStream={screenStream}
          onClose={handleCloseEditor}
          onSubmitSuccess={handleSubmitSuccess}
          isViewMode={!webcamStream && !screenStream} // View mode if no streams
        />
      )}
    </>
  );
}
