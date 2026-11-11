import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import {
  getAdminInterview,
  listSubmissionInterviews,
  saveInterviewReview,
  startPracticeInterview,
} from '../api/interviews';
import { getMilestone } from '../api/milestones';
import { getSubmission } from '../api/submissions';
import { CodePanel } from '../components/interview/CodePanel';
import { DisclosureSignalContext } from '../components/interview/disclosureSignal';
import type { DisclosureSignal } from '../components/interview/disclosureSignal';
import { QuestionReviewCard } from '../components/interview/QuestionReviewCard';
import { CodeStatusBanner } from '../components/interview/ObservedBehavior';
import { Alert, Badge, Button, Card, EmptyState, FormField, Input, PageHeader, Spinner, Textarea } from '../components/ui';
import { classNames } from '../utils/classNames';
import type { AdminInterview, InterviewSummary, ReviewOverrides } from '../types/interview';
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
  const [startingPractice, setStartingPractice] = useState(false);
  const [practiceError, setPracticeError] = useState<string | null>(null);
  // The instructor's review as it is being edited. Saved only when Save is selected.
  const [draft, setDraft] = useState<ReviewOverrides>({});
  const [grade, setGrade] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [signal, setSignal] = useState<DisclosureSignal>({ open: false, tick: 0 });

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

  const loadInterview = useCallback(async (interviewId: string) => {
    setLoadingInterview(true);
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

  // A freshly loaded interview starts the editable review from what was saved.
  const loadedReviewKey = interview ? `${interview.interviewId}:${interview.review?.reviewedAt ?? ''}` : '';
  useEffect(() => {
    setDraft(interview?.review?.overrides ?? {});
    setGrade(interview?.review?.grade === null || interview?.review?.grade === undefined ? '' : String(interview.review.grade));
    setNote(interview?.review?.note ?? '');
    setSaveError(null);
    // Only when a different interview or a different saved version arrives, not on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedReviewKey]);

  const decide = (questionIndex: number, itemId: string, value: boolean | null) => {
    setDraft((current) => {
      const key = String(questionIndex);
      const forQuestion = { ...(current[key] ?? {}) };
      if (value === null) delete forQuestion[itemId];
      else forQuestion[itemId] = value;
      const next = { ...current };
      if (Object.keys(forQuestion).length > 0) next[key] = forQuestion;
      else delete next[key];
      return next;
    });
  };

  const parsedGrade = grade.trim() === '' ? null : Number(grade);
  const gradeInvalid = parsedGrade !== null && (!Number.isFinite(parsedGrade) || parsedGrade < 0 || parsedGrade > 100);
  const saved = interview?.review ?? null;
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(saved?.overrides ?? {}) ||
    parsedGrade !== (saved?.grade ?? null) ||
    note.trim() !== (saved?.note ?? '');
  const changedCount = Object.values(draft).reduce((count, items) => count + Object.keys(items).length, 0);

  const saveReview = async () => {
    if (!interview || gradeInvalid) return;
    setSaving(true);
    setSaveError(null);
    try {
      const review = await saveInterviewReview(interview.interviewId, { overrides: draft, grade: parsedGrade, note: note.trim() });
      setInterview((current) => (current ? { ...current, review } : current));
    } catch (error) {
      setSaveError(errorText(error, 'Could not save the review. Please try again.'));
    } finally {
      setSaving(false);
    }
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

        {ordered.length > 1 && (
          <nav aria-label="Interviews of this submission" className={styles.picker}>
            <ul className={styles.pickerList}>
              {ordered.map((item) => {
                const current = item.interviewId === selectedId;
                return (
                  <li key={item.interviewId}>
                    <button
                      type="button"
                      aria-current={current ? 'true' : undefined}
                      className={classNames(styles.pickerItem, current && styles.pickerItemCurrent)}
                      onClick={() => select(item.interviewId)}
                    >
                      <span className={styles.pickerName}>{optionLabel(item)}</span>
                      <Badge variant={STATUS_VARIANTS[item.status]}>{STATUS_LABELS[item.status]}</Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
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
                  This interview is still running. Reload this page to see new answers.
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

            <CodeStatusBanner status={interview.codeStatus} />

            <section className={styles.reviewPanel} aria-labelledby="instructor-review-title">
              <div className={styles.reviewHead}>
                <h2 id="instructor-review-title" className={styles.reviewTitle}>
                  Instructor review
                </h2>
                <p className={styles.reviewHelp}>
                  Your decisions are kept next to the agent&apos;s checks. The agent&apos;s original check is never changed.
                </p>
              </div>
              <div className={styles.reviewBody}>
                <FormField
                  label="Interview grade (0 to 100)"
                  className={styles.gradeField}
                  error={gradeInvalid ? 'Enter a number from 0 to 100, or leave it empty.' : undefined}
                >
                  <Input type="number" min={0} max={100} step="any" inputMode="decimal" value={grade} onChange={(event) => setGrade(event.target.value)} />
                </FormField>
                <FormField label="Note" className={styles.noteField}>
                  <Textarea rows={2} value={note} maxLength={4000} onChange={(event) => setNote(event.target.value)} />
                </FormField>
                <div className={styles.saveColumn}>
                  <Button onClick={() => void saveReview()} loading={saving} disabled={!dirty || gradeInvalid}>
                    {saving ? 'Saving…' : 'Save review'}
                  </Button>
                  <p className={styles.saveStatus} role="status">
                    {dirty
                      ? 'Unsaved changes'
                      : saved?.reviewedAt
                        ? `Saved ${formatDateTime(saved.reviewedAt)}`
                        : 'Nothing saved yet'}
                  </p>
                  {changedCount > 0 && (
                    <Badge variant="changed">{`${changedCount} ${changedCount === 1 ? 'item' : 'items'} changed by instructor`}</Badge>
                  )}
                </div>
              </div>
              {saveError && (
                <Alert variant="danger" title="Could not save the review" onDismiss={() => setSaveError(null)}>
                  {saveError}
                </Alert>
              )}
            </section>

            <div className={styles.layout}>
              <CodePanel
                title="Submitted code"
                code={interview.code}
                error={interview.code === null ? 'The submitted code could not be loaded.' : null}
                className={styles.code}
              />

              <div className={styles.questions}>
                <div className={styles.toolbar}>
                  <h2 className={styles.toolbarTitle}>Questions</h2>
                  <div className={styles.toolbarActions}>
                    <Button size="sm" variant="secondary" onClick={() => setSignal((s) => ({ open: true, tick: s.tick + 1 }))}>
                      Expand all
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setSignal((s) => ({ open: false, tick: s.tick + 1 }))}>
                      Collapse all
                    </Button>
                  </div>
                </div>
                {interview.mainQuestions.length === 0 && (
                  <EmptyState headingLevel={2} title="No questions yet" description="Nothing has been asked in this interview." />
                )}
                <DisclosureSignalContext.Provider value={signal}>
                  {interview.mainQuestions.map((question) => (
                    <QuestionReviewCard
                      key={question.index}
                      question={question}
                      draft={draft[String(question.index)]}
                      disabled={saving}
                      onDecide={decide}
                    />
                  ))}
                </DisclosureSignalContext.Provider>
              </div>
            </div>
          </>
        )}

      </div>
    </>
  );
}
