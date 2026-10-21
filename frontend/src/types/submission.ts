/**
 * Why a proctored submission ended. Sent with the submission and stored by the backend.
 * - submit_button: the student pressed Submit.
 * - left_page: the student left mid-session and the app auto-submitted their code.
 */
export type SubmissionEndedBy = 'submit_button' | 'left_page';

export interface SubmitOutcome {
  ok: boolean;
  error?: string;
}
