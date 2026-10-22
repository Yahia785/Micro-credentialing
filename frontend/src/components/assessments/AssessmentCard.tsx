import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { CourseNotSavedError } from '../../api/assessments';
import type { Assessment } from '../../types/assessment';
import type { CompletedMilestone } from '../../types/user';
import { getTypeLabel } from '../../utils/assessments';
import { Alert, Badge, Button, Card, DifficultyBadge, FormField, Input, StatusBadge } from '../ui';
import styles from './AssessmentCard.module.css';

interface AssessmentCardProps {
  assessment: Assessment;
  /** The student's completedMilestones entry for this assessment, if any. */
  completed: CompletedMilestone | undefined;
  /** Review status of the student's embedded submission ('pending' | 'approved' | 'rejected'). */
  reviewStatus: string | undefined;
  isAdmin: boolean;
  courseSuggestions: string[];
  onOpen: (assessment: Assessment) => void;
  onDelete: (assessment: Assessment) => void;
  /** Saves the course (empty string clears it). Rejects on failure. */
  onSaveCourse: (assessment: Assessment, course: string) => Promise<void>;
}

/** The status badge, shown with text. Coding and embedded keep the statuses they always showed. */
function StatusIndicator({
  assessment,
  completed,
  reviewStatus,
}: Pick<AssessmentCardProps, 'assessment' | 'completed' | 'reviewStatus'>) {
  if (assessment.kind === 'embedded') {
    if (!completed) return null;
    if (reviewStatus === 'approved') return <StatusBadge status="approved" />;
    if (reviewStatus === 'rejected') return <StatusBadge status="rejected" />;
    // Default to pending / under review
    return <StatusBadge status="pending" />;
  }

  // Never graded (grading was unavailable): under review, not a score.
  const coding = completed?.proctoringData?.reviewStatus;
  if (completed?.gradingFailed && coding !== 'approved' && coding !== 'rejected') {
    return <StatusBadge status="pending" />;
  }
  if (completed) {
    const passed = completed.score === 100;
    return <Badge variant={passed ? 'success' : 'danger'}>Submitted ({completed.score}%)</Badge>;
  }
  return null;
}

export function AssessmentCard({
  assessment,
  completed,
  reviewStatus,
  isAdmin,
  courseSuggestions,
  onOpen,
  onDelete,
  onSaveCourse,
}: AssessmentCardProps) {
  const isCompleted = Boolean(completed);
  const [editingCourse, setEditingCourse] = useState(false);
  const [courseDraft, setCourseDraft] = useState(assessment.course ?? '');
  const [saving, setSaving] = useState(false);
  const [courseError, setCourseError] = useState<string | null>(null);
  const listId = useId();

  const startEditingCourse = () => {
    setCourseDraft(assessment.course ?? '');
    setCourseError(null);
    setEditingCourse(true);
  };

  const saveCourse = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setCourseError(null);
    try {
      await onSaveCourse(assessment, courseDraft);
      setEditingCourse(false);
    } catch (err) {
      console.error('Failed to update course:', err);
      setCourseError(
        err instanceof CourseNotSavedError
          ? 'The server did not save the course. The backend may be out of date.'
          : 'Could not update the course. Please try again.'
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      interactive
      headingLevel={3}
      title={assessment.title}
      actions={<DifficultyBadge difficulty={assessment.difficulty} />}
      footer={
        <div className={styles.footerRow}>
          <small className={styles.added}>Added: {new Date(assessment.createdAt).toLocaleDateString()}</small>

          <div className={styles.actions}>
            <Button
              size="sm"
              variant={isCompleted ? 'secondary' : 'primary'}
              onClick={() => onOpen(assessment)}
            >
              {isCompleted ? 'View submission' : 'Start assessment'}
            </Button>

            {isAdmin && (
              <>
                <Button size="sm" variant="ghost" onClick={startEditingCourse} disabled={editingCourse}>
                  Change course
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(assessment);
                  }}
                >
                  Delete
                </Button>
              </>
            )}
          </div>
        </div>
      }
    >
      {assessment.kind === 'coding' && assessment.concept && <p className={styles.concept}>{assessment.concept}</p>}

      <div className={styles.tags}>
        <Badge variant="info">{getTypeLabel(assessment)}</Badge>
        {assessment.kind === 'coding' && assessment.testCaseCount !== undefined && (
          <Badge variant="neutral">{assessment.testCaseCount} test cases</Badge>
        )}
        {assessment.kind === 'embedded' && <Badge variant="neutral">{assessment.rubric.length} criteria</Badge>}
        <StatusIndicator assessment={assessment} completed={completed} reviewStatus={reviewStatus} />
      </div>

      {isAdmin && editingCourse && (
        <form className={styles.courseForm} onSubmit={saveCourse}>
          <FormField label="Course" hint="Leave empty to show this assessment under “No course”.">
            <Input
              type="text"
              list={listId}
              value={courseDraft}
              onChange={(e) => setCourseDraft(e.target.value)}
              maxLength={80}
            />
          </FormField>
          <datalist id={listId}>
            {courseSuggestions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          {courseError && <Alert variant="danger">{courseError}</Alert>}
          <div className={styles.actions}>
            <Button type="submit" size="sm" loading={saving}>
              {saving ? 'Saving…' : 'Save course'}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setEditingCourse(false)} disabled={saving}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
