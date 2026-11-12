import type { CompletedMilestone } from '../../types/user';
import { Button, StatusBadge } from '../ui';
import { WorkspaceShell } from '../workspace/WorkspaceShell';
import styles from './SubmissionStatusView.module.css';

interface SubmissionStatusViewProps {
  title: string;
  /** The student's entry for this problem (from the profile, so nothing is fetched and nothing flashes). */
  completed: CompletedMilestone;
  onClose: () => void;
}

/**
 * What a student sees when they open a submission whose result is held for the instructor: only its status. No code, no results,
 * no problem description and no interview, before or after the decision.
 */
export function SubmissionStatusView({ title, completed, onClose }: SubmissionStatusViewProps) {
  const decision = completed.proctoringData?.reviewStatus;
  const reviewed = decision === 'approved' || decision === 'rejected';
  const submitted = completed.completedAt ? new Date(completed.completedAt).toLocaleString() : null;

  return (
    <WorkspaceShell
      label={`Submission: ${title}`}
      title={title}
      exit={
        <Button size="sm" variant="secondary" onClick={onClose}>
          Back to assessments
        </Button>
      }
    >
      <div className={styles.body}>
        <section className={styles.panel} role="status" aria-label="Submission status">
          <StatusBadge status={reviewed ? decision : 'pending'} />
          <h2 className={styles.heading}>
            {!reviewed && 'Submitted. Your instructor will review it.'}
            {decision === 'approved' && 'Your instructor approved your submission.'}
            {decision === 'rejected' && 'Your instructor did not approve your submission.'}
          </h2>
          {submitted && <p className={styles.text}>Submitted: {submitted}</p>}
        </section>
      </div>
    </WorkspaceShell>
  );
}
