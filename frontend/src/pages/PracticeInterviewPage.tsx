import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { answerInterview, getAdminInterview } from '../api/interviews';
import { getMilestone } from '../api/milestones';
import { InterviewChat } from '../components/interview/InterviewChat';
import { InterviewTimer } from '../components/interview/InterviewTimer';
import { Alert, Badge, Button, Spinner } from '../components/ui';
import { WorkspaceShell } from '../components/workspace/WorkspaceShell';
import { useInterviewController } from '../hooks/useInterviewController';
import { useInterviewLeaveGuard } from '../hooks/useInterviewLeaveGuard';
import { chatFromAdminView, progressLabel, reviewPath } from '../utils/interview';
import styles from './PracticeInterviewPage.module.css';

interface MilestoneWithInterview {
  title?: string;
  interview?: { themes?: Array<{ mainQuestions?: string[] }> };
}

/**
 * An instructor's practice interview, taken through the same full-window workspace a student sees. It ends by returning to the
 * review page with this practice interview selected.
 */
export function PracticeInterviewPage() {
  const { submissionId = '', interviewId = '' } = useParams();
  const navigate = useNavigate();
  const [code, setCode] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [questionCount, setQuestionCount] = useState<number | null>(null);
  const [milestoneId, setMilestoneId] = useState<string | null>(null);
  const [firstLoadDone, setFirstLoadDone] = useState(false);
  const sawInProgress = useRef(false);

  const { chat, loading, loadError, sending, sendError, reload, sendAnswer } = useInterviewController({
    load: async () => {
      // The instructor view carries the code and the problem; the chat is worked out from its turns.
      const view = await getAdminInterview(interviewId);
      setCode(view.code);
      setMilestoneId(view.milestoneId);
      return chatFromAdminView(view, null);
    },
    send: (answer, timing) => answerInterview(interviewId, answer, timing),
  });

  useEffect(() => {
    void reload().then(() => setFirstLoadDone(true));
  }, [reload, interviewId]);

  // The problem's title and how many main questions it has, for the heading and "Question N of M".
  useEffect(() => {
    if (!milestoneId) return undefined;
    let cancelled = false;
    getMilestone(milestoneId)
      .then((data: { milestone?: MilestoneWithInterview }) => {
        if (cancelled) return;
        setTitle(data.milestone?.title ?? null);
        const themes = data.milestone?.interview?.themes;
        if (Array.isArray(themes)) {
          setQuestionCount(themes.reduce((total, theme) => total + (theme.mainQuestions?.length ?? 0), 0) || null);
        }
      })
      .catch(() => {
        // Only the heading and the total are lost; the interview itself still works.
      });
    return () => {
      cancelled = true;
    };
  }, [milestoneId]);

  const inProgress = chat?.status === 'in_progress';
  useInterviewLeaveGuard(inProgress);

  // When the practice interview ends in front of the instructor, go back to the review with it selected.
  useEffect(() => {
    if (inProgress) sawInProgress.current = true;
    else if (chat && sawInProgress.current) navigate(reviewPath(submissionId, interviewId), { replace: true });
  }, [chat, inProgress, navigate, submissionId, interviewId]);

  const back = () => navigate(reviewPath(submissionId, interviewId));
  const view = chat ? { ...chat, questionCount } : null;
  const progress = progressLabel(view);

  return (
    <WorkspaceShell
      label="Practice interview"
      exit={
        <Button size="sm" variant="secondary" onClick={back}>
          Back to review
        </Button>
      }
      title={title ? `Practice interview: ${title}` : 'Practice interview'}
      badges={
        <>
          <Badge variant="warning">Practice</Badge>
          {progress && <Badge variant="info">{progress}</Badge>}
        </>
      }
      status={<InterviewTimer chat={view} frozen={sending} />}
      notice={
        <Alert variant="info">
          This is a practice interview. It uses the same questions, timer and agent as a student&apos;s interview, and it is kept
          separate from the student&apos;s own interview.
        </Alert>
      }
    >
      {view ? (
        <InterviewChat
          chat={view}
          code={code}
          practice
          sending={sending}
          sendError={sendError}
          loadError={loadError}
          reloading={loading}
          onSend={sendAnswer}
          onReload={reload}
          endedPanel={
            <div className={styles.ended} role="status">
              <h2 className={styles.endedTitle}>Practice interview finished.</h2>
              <p className={styles.endedText}>The conversation and the agent&apos;s checks are on the review page.</p>
              <Button onClick={back}>Back to review</Button>
            </div>
          }
        />
      ) : (
        <div className={styles.scrollBody}>
          {!firstLoadDone && (
            <div className={styles.loading}>
              <Spinner decorative />
              <p className={styles.loadingText} role="status">
                Loading the interview…
              </p>
            </div>
          )}
          {firstLoadDone && (
            <Alert variant="danger" title="Could not load the interview">
              <p className={styles.alertText}>{loadError}</p>
              <Button size="sm" variant="secondary" loading={loading} onClick={() => void reload()}>
                {loading ? 'Retrying…' : 'Try again'}
              </Button>
            </Alert>
          )}
        </div>
      )}
    </WorkspaceShell>
  );
}
