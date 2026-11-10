import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import {
  getAdminInterview,
  listSubmissionInterviews,
  startPracticeInterview,
} from '../api/interviews';
import { getMilestone } from '../api/milestones';
import { getSubmission } from '../api/submissions';
import { CodePanel } from '../components/interview/CodePanel';
import { QuestionReviewCard } from '../components/interview/QuestionReviewCard';
import { Alert, Badge, Button, Card, EmptyState, FormField, PageHeader, Select, Spinner } from '../components/ui';
import type { AdminInterview, InterviewSummary } from '../types/interview';
import {
  STATUS_LABELS,
  STATUS_VARIANTS,
  formatDateTime,
  formatDuration,
  practicePath,
} from '../utils/interview';
import styles from './InterviewReviewPage.module.css';

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Real interviews first, then practice ones, newest first. */
function orderInterviews(list: InterviewSummary[]) {
  const real = list.filter((item) => !item.isPractice).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const practice = list.filter((item) => item.isPractice).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return [...real, ...practice];
}

function optionLabel(item: InterviewSummary) {
  const when = formatDateTime(item.startedAt);
  return item.isPractice ? `Practice, ${when}` : `Student interview, ${when}`;
}

function Fact({ label, children }: { label: string; children: string }) {
  return (
    <div className={styles.fact}>
      <dt className={styles.factLabel}>{label}</dt>
      <dd className={styles.factValue}>{children}</dd>
    </div>
  );
}

/** The instructor's review of a submission's interviews: the code, then each question with the student's answers and the agent's checks. */
export function InterviewReviewPage() {
  const { submissionId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const [list, setList] = useState<InterviewSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [interview, setInterview] = useState<AdminInterview | null>(null);
  const [interviewError, setInterviewError] = useState<string | null>(null);
  const [loadingInterview, setLoadingInterview] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [startingPractice, setStartingPractice] = useState(false);
  const [practiceError, setPracticeError] = useState<string | null>(null);

  const ordered = useMemo(() => orderInterviews(list ?? []), [list]);
  const requestedId = searchParams.get('interview');
  const selectedId =
    requestedId && ordered.some((item) => item.interviewId === requestedId) ? requestedId : ordered[0]?.interviewId ?? null;

  const loadList = useCallback(async () => {
    try {
      setList(await listSubmissionInterviews(submissionId));
      setListError(null);
    } catch (error) {
      setListError(errorText(error, 'Could not load the interviews for this submission.'));
    }
  }, [submissionId]);

  const loadInterview = useCallback(async (interviewId: string, quiet = false) => {
    if (!quiet) setLoadingInterview(true);
    try {
      setInterview(await getAdminInterview(interviewId));
      setInterviewError(null);
    } catch (error) {
      setInterviewError(errorText(error, 'Could not load this interview.'));
    } finally {
      setLoadingInterview(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // The problem's title comes from the submission it was made for.
  useEffect(() => {
    let cancelled = false;
    getSubmission(submissionId)
      .then((data: { submission?: { milestoneId?: string } }) => {
        const milestoneId = data?.submission?.milestoneId;
        return milestoneId ? getMilestone(milestoneId) : null;
      })
      .then((data: { milestone?: { title?: string } } | null) => {
        if (!cancelled && data?.milestone?.title) setTitle(data.milestone.title);
      })
      .catch(() => {
        // The title is only a heading; the review works without it.
      });
    return () => {
      cancelled = true;
    };
  }, [submissionId]);

  useEffect(() => {
    if (!selectedId) {
      setInterview(null);
      return;
    }
    setInterview(null);
    void loadInterview(selectedId);
  }, [selectedId, loadInterview]);

  const refresh = async () => {
    setRefreshing(true);
    await loadList();
    if (selectedId) await loadInterview(selectedId, true);
    setRefreshing(false);
  };

  const startPractice = async () => {
    setStartingPractice(true);
    setPracticeError(null);
    try {
      const started = await startPracticeInterview(submissionId);
      navigate(practicePath(submissionId, started.interviewId));
    } catch (error) {
      setPracticeError(errorText(error, 'Could not start a practice interview. Please try again.'));
      setStartingPractice(false);
    }
  };

  const select = (interviewId: string) => {
    setSearchParams({ interview: interviewId }, { replace: true });
  };

  const duration = interview ? formatDuration(interview.startedAt, interview.endedAt) : null;

  return (
    <>
      <PageHeader
        title="Interview review"
        subtitle={title ?? 'Review the interview that followed this submission.'}
        actions={
          <>
            <Button variant="ghost" onClick={() => navigate('/admin/reviews')}>
              Back to reviews
            </Button>
            <Button variant="secondary" onClick={() => void refresh()} loading={refreshing} disabled={!list}>
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
            <Button onClick={() => void startPractice()} loading={startingPractice}>
              {startingPractice ? 'Starting…' : 'Start practice interview'}
            </Button>
          </>
        }
      />

      <div className={styles.page}>
        <Alert variant="info">The agent&apos;s checks are suggestions. You make every final decision.</Alert>

        {practiceError && (
          <Alert variant="danger" title="Could not start a practice interview" onDismiss={() => setPracticeError(null)}>
            {practiceError}
          </Alert>
        )}

        {list === null && !listError && (
          <div className={styles.loading}>
            <Spinner decorative />
            <p className={styles.loadingText} role="status">
              Loading interviews…
            </p>
          </div>
        )}

        {listError && (
          <Alert variant="danger" title="Could not load the interviews">
            <p className={styles.alertText}>{listError}</p>
            <Button size="sm" variant="secondary" onClick={() => void loadList()}>
              Try again
            </Button>
          </Alert>
        )}

        {list !== null && ordered.length === 0 && (
          <EmptyState
            headingLevel={2}
            title="No interview yet"
            description="The student has not started the interview for this submission. You can try the interview yourself with a practice interview."
            action={
              <Button onClick={() => void startPractice()} loading={startingPractice}>
                {startingPractice ? 'Starting…' : 'Start practice interview'}
              </Button>
            }
          />
        )}

        {ordered.length > 0 && (
          <FormField label="Interview" className={styles.picker}>
            <Select value={selectedId ?? ''} onChange={(event) => select(event.target.value)}>
              {ordered.map((item) => (
                <option key={item.interviewId} value={item.interviewId}>
                  {optionLabel(item)} ({STATUS_LABELS[item.status]})
                </option>
              ))}
            </Select>
          </FormField>
        )}

        {selectedId && loadingInterview && !interview && (
          <div className={styles.loading}>
            <Spinner decorative />
            <p className={styles.loadingText} role="status">
              Loading the interview…
            </p>
          </div>
        )}

        {interviewError && (
          <Alert variant="danger" title="Could not load this interview">
            <p className={styles.alertText}>{interviewError}</p>
            <Button size="sm" variant="secondary" onClick={() => selectedId && void loadInterview(selectedId)}>
              Try again
            </Button>
          </Alert>
        )}

        {interview && (
          <>
            <Card
              headingLevel={2}
              title={title ?? 'Interview'}
              actions={
                <>
                  {interview.isPractice && <Badge variant="warning">Practice</Badge>}
                  <Badge variant={STATUS_VARIANTS[interview.status]}>{STATUS_LABELS[interview.status]}</Badge>
                </>
              }
            >
              <dl className={styles.facts}>
                <Fact label="Started">{formatDateTime(interview.startedAt)}</Fact>
                <Fact label="Ended">{interview.endedAt ? formatDateTime(interview.endedAt) : 'Not ended yet'}</Fact>
                <Fact label="Duration">{duration ?? 'Not finished'}</Fact>
              </dl>

              {interview.status === 'in_progress' && (
                <Alert variant="info" className={styles.running}>
                  This interview is still running. Select Refresh to see new answers.
                  {interview.isPractice && (
                    <>
                      {' '}
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => navigate(practicePath(submissionId, interview.interviewId))}
                      >
                        Continue practice interview
                      </Button>
                    </>
                  )}
                </Alert>
              )}

              <details className={styles.details}>
                <summary className={styles.summary}>Technical details</summary>
                <dl className={styles.techList}>
                  <Fact label="Prompt version">{interview.promptVersion ?? 'Not recorded'}</Fact>
                  <Fact label="Host model">{interview.modelId ?? 'Not recorded'}</Fact>
                  <Fact label="Checker model">{interview.checkerModelId ?? 'Not used'}</Fact>
                  <Fact label="Writer model">{interview.writerModelId ?? 'Not used'}</Fact>
                  <Fact label="End reason">{interview.endReason ?? 'Not ended yet'}</Fact>
                  <Fact label="Time added while the agent worked">{`${((interview.extraTimeMs ?? 0) / 1000).toFixed(1)} s`}</Fact>
                  <Fact label="Interview ID">{interview.interviewId}</Fact>
                </dl>
              </details>
            </Card>

            <div className={styles.layout}>
              <CodePanel
                title="Submitted code"
                code={interview.code}
                error={interview.code === null ? 'The submitted code could not be loaded.' : null}
                className={styles.code}
              />

              <div className={styles.questions}>
                {interview.mainQuestions.length === 0 && (
                  <EmptyState headingLevel={2} title="No questions yet" description="Nothing has been asked in this interview." />
                )}
                {interview.mainQuestions.map((question) => (
                  <QuestionReviewCard key={question.index} question={question} />
                ))}
              </div>
            </div>
          </>
        )}

      </div>
    </>
  );
}
