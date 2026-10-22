import { useEffect, useRef, useState } from 'react';
import { deleteAssessment, getAllAssessments, setAssessmentCourse } from '../api/assessments';
import { AssessmentCard } from '../components/assessments/AssessmentCard';
import { AssessmentCreateForm } from '../components/assessments/AssessmentCreateForm';
import { AssessmentSession } from '../components/assessments/AssessmentSession';
import { Alert, Button, EmptyState, FormField, PageHeader, Select, Spinner } from '../components/ui';
import { useUser } from '../context/UserContext';
import { useAssessmentSession, useEmbeddedReviewStatuses } from '../hooks/useAssessmentSession';
import type { Assessment } from '../types/assessment';
import {
  ALL_COURSES,
  NO_COURSE,
  NO_COURSE_LABEL,
  filterGroups,
  getCourseNames,
  groupByCourse,
  normalizeCourseName,
} from '../utils/assessments';
import styles from './AssessmentsPage.module.css';

export function AssessmentsPage() {
  const { refreshProfile } = useUser();
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  // Only the very first load replaces the page with a spinner; later reloads refresh quietly.
  const [initialLoading, setInitialLoading] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [courseFilter, setCourseFilter] = useState(ALL_COURSES);

  const loadedOnce = useRef(false);

  async function loadAssessments() {
    try {
      const result = await getAllAssessments();
      // A quiet reload that fails keeps the list on screen instead of replacing it with a partial one.
      setAssessments(result.errors.length > 0 && loadedOnce.current ? (current) => current : result.assessments);
      setErrors(result.errors);
      loadedOnce.current = true;
    } finally {
      setInitialLoading(false);
    }
  }

  // The proctored-session logic (streams, navigation guard, leave-and-submit) is shared by both kinds.
  const session = useAssessmentSession(loadAssessments);
  const { userProfile } = session;
  const isAdmin = userProfile?.role === 'admin';
  const reviewStatuses = useEmbeddedReviewStatuses(assessments);

  useEffect(() => {
    loadAssessments();
    // Re-read the profile quietly so completed assessments are always recognised, even if the profile
    // in memory is stale (e.g. a submission made from another tab or session).
    refreshProfile();
  }, [refreshProfile]);

  const handleDelete = async (assessment: Assessment) => {
    const message =
      assessment.kind === 'coding'
        ? 'Are you sure you want to delete this problem? This will also delete all associated test cases.'
        : 'Are you sure you want to delete this problem?';
    if (!window.confirm(message)) return;

    try {
      setErrors([]);
      await deleteAssessment(assessment);
      setAssessments((current) => current.filter((a) => a.milestoneId !== assessment.milestoneId));
    } catch (err) {
      console.error('Failed to delete assessment:', err);
      setErrors(['Failed to delete assessment. Please try again.']);
    }
  };

  const handleSaveCourse = async (assessment: Assessment, course: string) => {
    // Throws if the server did not store the course, so the card can say so.
    await setAssessmentCourse(assessment, course);
    const saved = normalizeCourseName(course);
    setAssessments((current) =>
      current.map((a) => (a.milestoneId === assessment.milestoneId ? { ...a, course: saved } : a))
    );
  };

  const handleCreated = async (warning?: string) => {
    await loadAssessments();
    setIsCreating(false);
    setNotice(warning ?? null);
  };

  const courseNames = getCourseNames(assessments);
  const hasUncategorized = assessments.some((a) => !a.course);
  const filterOptions = [ALL_COURSES, ...courseNames, ...(hasUncategorized ? [NO_COURSE] : [])];
  // If the chosen course no longer exists (e.g. after renaming its last assessment), show everything.
  const activeFilter = filterOptions.includes(courseFilter) ? courseFilter : ALL_COURSES;

  const groups = filterGroups(groupByCourse(assessments), activeFilter);

  return (
    <>
      <PageHeader
        title="Assessments"
        subtitle="Choose an assessment to start, or open one you have already submitted."
        actions={
          isAdmin ? (
            <Button
              variant={isCreating ? 'secondary' : 'primary'}
              onClick={() => {
                setErrors([]);
                setNotice(null);
                setIsCreating(!isCreating);
              }}
            >
              {isCreating ? 'Cancel' : 'Add assessment'}
            </Button>
          ) : undefined
        }
      />

      {initialLoading ? (
        <div className={styles.loading}>
          <Spinner decorative />
          <p className={styles.loadingText} role="status">
            Loading assessments…
          </p>
        </div>
      ) : (
        <div className={styles.page}>
          {errors.map((message) => (
            <Alert key={message} variant="danger">
              {message}
            </Alert>
          ))}

          {notice && (
            <Alert variant="warning" onDismiss={() => setNotice(null)}>
              {notice}
            </Alert>
          )}

          {isAdmin && isCreating && (
            <AssessmentCreateForm
              courseSuggestions={courseNames}
              onCreated={handleCreated}
              onCancel={() => setIsCreating(false)}
            />
          )}

          {assessments.length > 0 && (
            <div className={styles.toolbar}>
              <FormField label="Course" className={styles.filter}>
                <Select value={activeFilter} onChange={(e) => setCourseFilter(e.target.value)}>
                  <option value={ALL_COURSES}>All courses</option>
                  {courseNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                  {hasUncategorized && <option value={NO_COURSE}>{NO_COURSE_LABEL}</option>}
                </Select>
              </FormField>
              <p className={styles.count}>
                Total assessments: <strong>{assessments.length}</strong>
              </p>
            </div>
          )}

          {groups.map((group) => (
            <section key={group.course ?? NO_COURSE} className={styles.group}>
              <h2 className={styles.groupTitle}>
                {group.label} <span className={styles.groupCount}>({group.items.length})</span>
              </h2>
              <div className={styles.grid}>
                {group.items.map((assessment) => (
                  <AssessmentCard
                    key={assessment.milestoneId}
                    assessment={assessment}
                    completed={userProfile?.completedMilestones?.find((m) => m.milestoneId === assessment.milestoneId)}
                    reviewStatus={reviewStatuses[assessment.milestoneId]}
                    isAdmin={isAdmin}
                    courseSuggestions={courseNames}
                    onOpen={session.openAssessment}
                    onDelete={handleDelete}
                    onSaveCourse={handleSaveCourse}
                  />
                ))}
              </div>
            </section>
          ))}

          {assessments.length === 0 && (
            <EmptyState
              headingLevel={2}
              title="No assessments available yet"
              description={
                isAdmin
                  ? 'Select "Add assessment" to create your first one.'
                  : 'Check back later for new assessments.'
              }
            />
          )}

          <AssessmentSession session={session} />
        </div>
      )}
    </>
  );
}
