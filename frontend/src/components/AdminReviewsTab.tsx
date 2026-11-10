import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { API_BASE } from '../api/config';
import { getAdminInterview, listSubmissionInterviews } from '../api/interviews';
import type { AdminInterview } from '../types/interview';
import { classNames } from '../utils/classNames';
import { formatDateTime, reviewPath, summarizeQuestion } from '../utils/interview';
import { Alert, Badge, Button, Spinner } from './ui';
import styles from './AdminReviewsTab.module.css';

// TODO: Make this per-assessment configurable (should match backend PASSING_THRESHOLD)
const PASSING_THRESHOLD = 83;

interface RubricResult {
  criterion: string;
  passed: boolean;
  feedback: string;
}

interface TestResult {
  testCaseId?: string;
  passed: boolean;
  isHidden?: boolean;
}

interface PendingSubmission {
  submissionId: string;
  userId: string;
  milestoneId: string;
  milestoneType?: string;
  /** The language the code was submitted in. */
  language?: string;
  studentName: string;
  studentEmail: string;
  problemTitle: string;
  score: number;
  passedTests: number;
  totalTests: number;
  passedCriteria?: number;
  totalCriteria?: number;
  rubricResults?: RubricResult[];
  /** One entry per test case, in order. */
  testResults?: TestResult[];
  submittedAt: string;
  /** 'manual_review' / 'grading_failed' = never graded automatically; the instructor grades it. */
  status?: string;
  /** 'left_page' = the student left mid-session and the code was auto-submitted. */
  endedBy?: 'submit_button' | 'left_page';
  code?: string;
  proctoringData?: {
    recordings?: {
      webcam?: { s3Key: string; uploadedAt: string };
      screen?: { s3Key: string; uploadedAt: string };
    };
    startedAt?: string;
    completedAt?: string;
  };
}

type SubTab = 'passed' | 'failed' | 'ungraded';

// Submissions the system never graded (manual grading mode, or automatic grading failed).
const isUngraded = (s: PendingSubmission) => s.status === 'manual_review' || s.status === 'grading_failed';

const scoreText = (s: PendingSubmission) =>
  isUngraded(s)
    ? 'Not graded yet'
    : s.milestoneType === 'embedded'
      ? `${s.passedCriteria ?? 0}/${s.totalCriteria ?? 0} criteria (${s.score}%)`
      : `${s.passedTests}/${s.totalTests} tests (${s.score}%)`;

/** The interview of a submission, as the grade overview needs it. */
type InterviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; interview: AdminInterview };

const hasInterview = (s: PendingSubmission) => s.milestoneType !== 'embedded' && s.language === 'cpp';

export function AdminReviewsTab() {
  const navigate = useNavigate();
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('passed');
  const [passedReviews, setPassedReviews] = useState<PendingSubmission[]>([]);
  const [failedReviews, setFailedReviews] = useState<PendingSubmission[]>([]);
  const [ungradedReviews, setUngradedReviews] = useState<PendingSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSubmission, setSelectedSubmission] = useState<PendingSubmission | null>(null);
  const [webcamUrl, setWebcamUrl] = useState<string | null>(null);
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [reviewNotes, setReviewNotes] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [adjustedScore, setAdjustedScore] = useState<string>('');
  const [processing, setProcessing] = useState(false);
  const [criteriaModifications, setCriteriaModifications] = useState<{ [key: number]: boolean }>({});
  const [interviewState, setInterviewState] = useState<InterviewState>({ kind: 'idle' });

  useEffect(() => {
    loadPendingReviews();
  }, []);

  const loadPendingReviews = async () => {
    try {
      setLoading(true);
      setError(null);

      const token = await getAuthToken();

      const [passedRes, failedRes, ungradedRes] = await Promise.all([
        fetch(`${API_BASE}/credentials/get-pending-reviews?filter=passed`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${API_BASE}/credentials/get-pending-reviews?filter=failed`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${API_BASE}/credentials/get-pending-reviews?filter=ungraded`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);

      if (!passedRes.ok || !failedRes.ok || !ungradedRes.ok) {
        throw new Error('Failed to load pending reviews');
      }

      const passedData = await passedRes.json();
      const failedData = await failedRes.json();
      const ungradedData = await ungradedRes.json();

      setPassedReviews(passedData.submissions || []);
      // The server's 'failed' list also includes ungraded work (older admin screens rely on that); keep it out of Failed here.
      setFailedReviews((failedData.submissions || []).filter((s: PendingSubmission) => !isUngraded(s)));
      setUngradedReviews(ungradedData.submissions || []);
    } catch (err: unknown) {
      console.error('Error loading pending reviews:', err);
      setError(err instanceof Error ? err.message : 'Failed to load pending reviews');
    } finally {
      setLoading(false);
    }
  };

  const loadRecordingUrls = async (submissionId: string) => {
    try {
      setLoadingVideos(true);
      setWebcamUrl(null);
      setScreenUrl(null);

      const token = await getAuthToken();
      const response = await fetch(`${API_BASE}/credentials/get-recording-urls/${submissionId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to load recording URLs');
      }

      const data = await response.json();
      setWebcamUrl(data.urls.webcam || null);
      setScreenUrl(data.urls.screen || null);
    } catch (err: unknown) {
      console.error('Error loading recordings:', err);
      alert(`Failed to load recordings: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setLoadingVideos(false);
    }
  };

  /** The student's own interview, if there is one (practice interviews are not the submission's interview). */
  const loadInterview = async (submission: PendingSubmission) => {
    if (!hasInterview(submission)) {
      setInterviewState({ kind: 'idle' });
      return;
    }
    setInterviewState({ kind: 'loading' });
    try {
      const list = await listSubmissionInterviews(submission.submissionId);
      const real = list.find((item) => !item.isPractice);
      if (!real) {
        setInterviewState({ kind: 'none' });
        return;
      }
      setInterviewState({ kind: 'ready', interview: await getAdminInterview(real.interviewId) });
    } catch (err: unknown) {
      setInterviewState({ kind: 'error', message: err instanceof Error ? err.message : 'Could not load the interview.' });
    }
  };

  const handleSelectSubmission = async (submission: PendingSubmission) => {
    setSelectedSubmission(submission);
    setReviewNotes('');
    setRejectionReason('');
    setAdjustedScore('');
    setCriteriaModifications({});
    void loadInterview(submission);
    await loadRecordingUrls(submission.submissionId);
  };

  const handleApprove = async () => {
    if (!selectedSubmission) return;

    const scoreOverride = adjustedScore.trim() !== '' ? parseInt(adjustedScore) : null;

    if (scoreOverride !== null && (isNaN(scoreOverride) || scoreOverride < 0 || scoreOverride > 100)) {
      alert('Adjusted score must be a number between 0 and 100');
      return;
    }

    const effectiveScore = scoreOverride !== null ? scoreOverride : selectedSubmission.score;
    const willIssueCredential = effectiveScore >= PASSING_THRESHOLD;

    const confirmMessage = willIssueCredential
      ? `Approve this submission and issue credential to ${selectedSubmission.studentName}? (Score: ${effectiveScore}%)`
      : `Approve this submission for ${selectedSubmission.studentName}? No credential will be issued (score: ${effectiveScore}%, threshold: ${PASSING_THRESHOLD}%).`;

    if (!window.confirm(confirmMessage)) return;

    try {
      setProcessing(true);

      const token = await getAuthToken();
      const response = await fetch(`${API_BASE}/credentials/approve-review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          submissionId: selectedSubmission.submissionId,
          reviewNotes: reviewNotes || 'Approved',
          ...(scoreOverride !== null && { adjustedScore: scoreOverride }),
          ...(Object.keys(criteriaModifications).length > 0 && { criteriaModifications }),
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || 'Failed to approve review');
      }

      alert(willIssueCredential ? 'Review approved. Credential will be issued.' : 'Review approved. No credential issued.');
      removeReviewed(selectedSubmission.submissionId);
    } catch (err: unknown) {
      console.error('Error approving review:', err);
      alert(`Failed to approve: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setProcessing(false);
    }
  };

  const handleReject = async () => {
    if (!selectedSubmission) return;

    if (!rejectionReason.trim()) {
      alert('Please provide a reason for rejection');
      return;
    }

    if (!window.confirm(`Reject this submission? This will be recorded as an integrity concern.`)) {
      return;
    }

    try {
      setProcessing(true);

      const token = await getAuthToken();
      const response = await fetch(`${API_BASE}/proctoring/reject-review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          submissionId: selectedSubmission.submissionId,
          rejectionReason: rejectionReason,
          ...(reviewNotes.trim() && { reviewNotes: reviewNotes.trim() }),
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to reject review');
      }

      alert('Review rejected.');
      removeReviewed(selectedSubmission.submissionId);
    } catch (err: unknown) {
      console.error('Error rejecting review:', err);
      alert(`Failed to reject: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setProcessing(false);
    }
  };

  /** Take a reviewed submission out of its list and go back to the list. */
  const removeReviewed = (reviewedId: string) => {
    const without = (prev: PendingSubmission[]) => prev.filter((s) => s.submissionId !== reviewedId);
    if (activeSubTab === 'passed') {
      setPassedReviews(without);
    } else if (activeSubTab === 'ungraded') {
      setUngradedReviews(without);
    } else {
      setFailedReviews(without);
    }
    setSelectedSubmission(null);
  };

  const chooseTab = (tab: SubTab) => {
    setActiveSubTab(tab);
    setSelectedSubmission(null);
  };

  // Derive the displayed list from active sub-tab
  const displayedReviews =
    activeSubTab === 'passed' ? passedReviews : activeSubTab === 'ungraded' ? ungradedReviews : failedReviews;
  const activeTabLabel = activeSubTab === 'passed' ? 'Passed' : activeSubTab === 'ungraded' ? 'Ungraded' : 'Failed';

  if (loading) {
    return (
      <div className={styles.loading}>
        <Spinner decorative />
        <p role="status" className={styles.loadingText}>
          Loading pending reviews…
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="danger" title="Could not load the reviews">
        {error}
      </Alert>
    );
  }

  const tabs: Array<{ id: SubTab; label: string; count: number }> = [
    { id: 'passed', label: 'Passed', count: passedReviews.length },
    { id: 'failed', label: 'Failed', count: failedReviews.length },
    { id: 'ungraded', label: 'Ungraded', count: ungradedReviews.length },
  ];

  const adjustedNumber = adjustedScore.trim() !== '' ? parseInt(adjustedScore) : null;
  const effectiveScore = adjustedNumber !== null && !isNaN(adjustedNumber) ? adjustedNumber : (selectedSubmission?.score ?? 0);
  const willIssue = effectiveScore >= PASSING_THRESHOLD;

  return (
    <div className={styles.root}>
      {/* Sub-tab switcher */}
      <div className={styles.tabs} role="group" aria-label="Show submissions">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-pressed={activeSubTab === tab.id}
            className={classNames(styles.tab, activeSubTab === tab.id && styles[`tab_${tab.id}`])}
            onClick={() => chooseTab(tab.id)}
          >
            {tab.label}
            <span className={styles.tabCount}>{tab.count}</span>
          </button>
        ))}
      </div>

      {displayedReviews.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{`No ${activeTabLabel.toLowerCase()} submissions pending review.`}</p>
          <p className={styles.emptyText}>All {activeTabLabel.toLowerCase()} submissions have been reviewed.</p>
        </div>
      ) : (
        <div className={styles.panes}>
          {/* The list hides while a submission is open; it keeps its scroll position for Back to list. */}
          <section className={styles.pane} hidden={selectedSubmission !== null} aria-label={`${activeTabLabel} submissions`}>
            <h2 className={styles.paneTitle}>
              {activeTabLabel} ({displayedReviews.length})
            </h2>
            <ul className={styles.list}>
              {displayedReviews.map((submission) => {
                const passing = !isUngraded(submission) && submission.score >= PASSING_THRESHOLD;
                return (
                  <li key={submission.submissionId}>
                    <button
                      type="button"
                      className={classNames(
                        styles.item,
                        isUngraded(submission) ? styles.itemUngraded : passing ? styles.itemPassing : styles.itemFailing,
                      )}
                      onClick={() => void handleSelectSubmission(submission)}
                    >
                      <span className={styles.itemName}>{submission.studentName}</span>
                      <span className={styles.itemProblem}>{submission.problemTitle}</span>
                      <span className={styles.itemMeta}>
                        <span className={styles.itemScore}>{scoreText(submission)}</span>
                        {submission.endedBy === 'left_page' && <Badge variant="warning">Left mid-session</Badge>}
                      </span>
                      <span className={styles.itemDate}>{new Date(submission.submittedAt).toLocaleString()}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* Selected submission */}
          {selectedSubmission && (
            <section className={classNames(styles.pane, styles.detail)} aria-label="Review submission">
              <div className={styles.detailBar}>
                <Button variant="secondary" size="sm" onClick={() => setSelectedSubmission(null)}>
                  Back to list
                </Button>
                <h2 className={styles.detailTitle}>Review submission</h2>
              </div>

              <div className={styles.detailBody}>
                {/* Who and what */}
                <div className={styles.card}>
                  <div className={styles.cardHead}>
                    <h3 className={styles.cardTitle}>{selectedSubmission.studentName}</h3>
                    {selectedSubmission.endedBy === 'left_page' && <Badge variant="warning">Left mid-session (auto-submitted)</Badge>}
                  </div>
                  <dl className={styles.facts}>
                    <div>
                      <dt>Email</dt>
                      <dd>{selectedSubmission.studentEmail}</dd>
                    </div>
                    <div>
                      <dt>Problem</dt>
                      <dd>{selectedSubmission.problemTitle}</dd>
                    </div>
                    <div>
                      <dt>Submitted</dt>
                      <dd>{new Date(selectedSubmission.submittedAt).toLocaleString()}</dd>
                    </div>
                  </dl>
                </div>

                {/* Grade overview */}
                <div className={classNames(styles.card, styles.overview)}>
                  <h3 className={styles.cardTitle}>Grade overview</h3>

                  <div className={styles.overviewGrid}>
                    <div className={styles.overviewBlock}>
                      <h4 className={styles.blockTitle}>Score</h4>
                      <p
                        className={classNames(
                          styles.bigScore,
                          isUngraded(selectedSubmission)
                            ? styles.scoreNeutral
                            : selectedSubmission.score >= PASSING_THRESHOLD
                              ? styles.scorePass
                              : styles.scoreFail,
                        )}
                      >
                        {isUngraded(selectedSubmission) ? 'Not graded' : `${selectedSubmission.score}%`}
                      </p>
                      <p className={styles.blockText}>
                        {isUngraded(selectedSubmission)
                          ? 'Enter a score below to grade it.'
                          : scoreText(selectedSubmission)}
                      </p>
                      <p className={styles.blockText}>Passing threshold: {PASSING_THRESHOLD}%</p>
                    </div>

                    {selectedSubmission.milestoneType !== 'embedded' && (
                      <div className={styles.overviewBlock}>
                        <h4 className={styles.blockTitle}>Test cases</h4>
                        {selectedSubmission.testResults && selectedSubmission.testResults.length > 0 ? (
                          <ul className={styles.tests}>
                            {selectedSubmission.testResults.map((result, index) => (
                              <li
                                key={index}
                                className={classNames(styles.test, result.passed ? styles.testPass : styles.testFail)}
                              >
                                <span className={styles.testId}>{`T${index + 1}`}</span>
                                <span>{result.passed ? 'Passed' : 'Failed'}</span>
                                {result.isHidden && <span className={styles.testHidden}>Hidden</span>}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className={styles.blockText}>No test case details were stored for this submission.</p>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Interview */}
                  {hasInterview(selectedSubmission) && (
                    <div className={styles.overviewBlock}>
                      <div className={styles.blockHeadRow}>
                        <h4 className={styles.blockTitle}>Interview</h4>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            navigate(
                              reviewPath(
                                selectedSubmission.submissionId,
                                interviewState.kind === 'ready' ? interviewState.interview.interviewId : undefined,
                              ),
                            )
                          }
                        >
                          Open full interview review
                        </Button>
                      </div>
                      <InterviewSummary state={interviewState} />
                    </div>
                  )}

                  {/* Recordings */}
                  <div className={styles.overviewBlock}>
                    <h4 className={styles.blockTitle}>Recordings</h4>
                    {loadingVideos ? (
                      <p className={styles.blockText}>Loading recordings…</p>
                    ) : (
                      <div className={styles.videos}>
                        <div>
                          <p className={styles.videoLabel}>Webcam</p>
                          {webcamUrl ? (
                            <video src={webcamUrl} controls className={styles.video} />
                          ) : (
                            <p className={styles.blockText}>No webcam recording</p>
                          )}
                        </div>
                        <div>
                          <p className={styles.videoLabel}>Screen</p>
                          {screenUrl ? (
                            <video src={screenUrl} controls className={styles.video} />
                          ) : (
                            <p className={styles.blockText}>No screen recording</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Rubric breakdown, embedded submissions only */}
                {selectedSubmission.milestoneType === 'embedded' && selectedSubmission.rubricResults && (
                  <div className={styles.card}>
                    <h3 className={styles.cardTitle}>AI grading breakdown</h3>
                    <ul className={styles.rubric}>
                      {selectedSubmission.rubricResults.map((result, index) => (
                        <li key={index} className={classNames(styles.rubricItem, result.passed ? styles.rubricPass : styles.rubricFail)}>
                          <Badge variant={result.passed ? 'success' : 'danger'}>{result.passed ? 'Pass' : 'Fail'}</Badge>
                          <div>
                            <p className={styles.rubricCriterion}>{result.criterion}</p>
                            <p className={styles.rubricFeedback}>{result.feedback}</p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Criterion overrides, embedded submissions only */}
                {selectedSubmission.milestoneType === 'embedded' && selectedSubmission.rubricResults && (
                  <div className={styles.card}>
                    <h3 className={styles.cardTitle}>Criterion overrides (optional)</h3>
                    <p className={styles.blockText}>Override individual criteria independently of the overall score.</p>
                    <ul className={styles.rubric}>
                      {selectedSubmission.rubricResults.map((result, index) => {
                        const decision = criteriaModifications[index];
                        return (
                          <li key={index} className={styles.overrideRow}>
                            <div className={styles.overrideText}>
                              <strong>
                                {index + 1}. {result.criterion}
                              </strong>
                              <span className={styles.blockText}>AI result: {result.passed ? 'Pass' : 'Fail'}</span>
                            </div>
                            <div className={styles.overrideButtons}>
                              <Button
                                size="sm"
                                variant={decision === true ? 'primary' : 'secondary'}
                                aria-pressed={decision === true}
                                onClick={() => setCriteriaModifications({ ...criteriaModifications, [index]: true })}
                              >
                                Pass
                              </Button>
                              <Button
                                size="sm"
                                variant={decision === false ? 'danger' : 'secondary'}
                                aria-pressed={decision === false}
                                onClick={() => setCriteriaModifications({ ...criteriaModifications, [index]: false })}
                              >
                                Fail
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={!(index in criteriaModifications)}
                                onClick={() => {
                                  const next = { ...criteriaModifications };
                                  delete next[index];
                                  setCriteriaModifications(next);
                                }}
                              >
                                Use AI result
                              </Button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                    {Object.keys(criteriaModifications).length > 0 && (
                      <p className={styles.modified}>
                        <strong>Modified: </strong>
                        {Object.entries(criteriaModifications)
                          .map(([idx, val]) => `#${parseInt(idx) + 1} ${val ? 'pass' : 'fail'}`)
                          .join(', ')}
                      </p>
                    )}
                  </div>
                )}

                {/* Submitted code, embedded submissions only */}
                {selectedSubmission.milestoneType === 'embedded' && selectedSubmission.code && (
                  <div className={styles.card}>
                    <h3 className={styles.cardTitle}>Submitted code</h3>
                    <pre className={styles.code}>{selectedSubmission.code}</pre>
                  </div>
                )}

                {/* Decision */}
                <div className={classNames(styles.card, styles.decision)}>
                  <h3 className={styles.cardTitle}>Your decision</h3>

                  <div className={styles.field}>
                    <label htmlFor="override-score" className={styles.label}>
                      Override score (optional)
                    </label>
                    <div className={styles.scoreRow}>
                      <input
                        id="override-score"
                        type="number"
                        min="0"
                        max="100"
                        value={adjustedScore}
                        onChange={(e) => setAdjustedScore(e.target.value)}
                        placeholder={`Current: ${selectedSubmission.score}%`}
                        className={styles.numberInput}
                      />
                      <span className={styles.blockText}>AI score: {selectedSubmission.score}%. Leave blank to keep it.</span>
                    </div>
                    {adjustedNumber !== null && !isNaN(adjustedNumber) && (
                      <p className={classNames(styles.scoreNote, willIssue ? styles.scorePass : styles.scoreFail)}>
                        {willIssue
                          ? `Adjusted score (${adjustedScore}%) meets the passing threshold. A credential will be issued.`
                          : `Adjusted score (${adjustedScore}%) is below the passing threshold. No credential.`}
                      </p>
                    )}
                  </div>

                  <div className={styles.field}>
                    <label htmlFor="review-notes" className={styles.label}>
                      Review notes (optional, used for both approval and rejection)
                    </label>
                    <textarea
                      id="review-notes"
                      value={reviewNotes}
                      onChange={(e) => setReviewNotes(e.target.value)}
                      placeholder="Add any additional context about this review..."
                      className={styles.textarea}
                    />
                  </div>

                  <div className={styles.field}>
                    <label htmlFor="rejection-reason" className={styles.label}>
                      Rejection reason (if rejecting)
                    </label>
                    <textarea
                      id="rejection-reason"
                      value={rejectionReason}
                      onChange={(e) => setRejectionReason(e.target.value)}
                      placeholder="e.g., Detected cheating, Multiple people visible, Tab switching..."
                      className={styles.textarea}
                    />
                  </div>

                  <div className={styles.actions}>
                    <Button onClick={handleApprove} loading={processing} className={styles.action}>
                      {willIssue ? 'Approve and issue credential' : 'Approve (no credential)'}
                    </Button>
                    <Button variant="danger" onClick={handleReject} loading={processing} className={styles.action}>
                      Reject
                    </Button>
                  </div>
                </div>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/** The interview per main question, using the instructor's decisions when there are any, and the instructor's grade and note. */
function InterviewSummary({ state }: { state: InterviewState }) {
  if (state.kind === 'idle' || state.kind === 'loading') {
    return (
      <p className={styles.blockText} role="status">
        Loading the interview…
      </p>
    );
  }
  if (state.kind === 'none') return <p className={styles.blockText}>The student has not started the interview.</p>;
  if (state.kind === 'error') return <p className={styles.blockText}>{state.message}</p>;

  const { interview } = state;
  const review = interview.review;
  const decided = Boolean(review && (review.grade !== null || review.note || Object.keys(review.overrides).length > 0));

  return (
    <div className={styles.interview}>
      {interview.mainQuestions.length === 0 ? (
        <p className={styles.blockText}>Nothing was asked in this interview.</p>
      ) : (
        <ul className={styles.summaryList}>
          {interview.mainQuestions.map((question) => {
            const changed = question.rubricSummary.some((item) => item.changed);
            return (
              <li key={question.index} className={styles.summaryRow}>
                <span>{summarizeQuestion(question)}</span>
                {changed && <Badge variant="changed">Changed by instructor</Badge>}
              </li>
            );
          })}
        </ul>
      )}
      <p className={styles.blockText}>
        {decided && review
          ? `Instructor review: ${review.grade !== null ? `grade ${review.grade} of 100` : 'no grade'}${review.reviewedAt ? `, saved ${formatDateTime(review.reviewedAt)}` : ''}.`
          : 'The instructor has not reviewed this interview yet. The summary shows the agent’s checks.'}
      </p>
      {review?.note && <p className={styles.noteText}>{review.note}</p>}
    </div>
  );
}

async function getAuthToken(): Promise<string> {
  const { fetchAuthSession } = await import('aws-amplify/auth');
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) {
    throw new Error('No authentication token available');
  }
  return token;
}
