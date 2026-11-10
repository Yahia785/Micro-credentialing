/**
 * Why a proctored submission ended. Sent with the submission and stored by the backend.
 * - submit_button: the student pressed Submit.
 * - left_page: the student left mid-session and the app auto-submitted their code.
 */
export type SubmissionEndedBy = 'submit_button' | 'left_page';

export interface SubmitOutcome {
  ok: boolean;
  error?: string;
  /** Set when the submission was saved. */
  submissionId?: string;
  /** The code that was submitted, so a follow-up screen can show it without another request. */
  code?: string;
  /** How the session ended, so only a submit by button leads to the interview. */
  endedBy?: SubmissionEndedBy;
}
