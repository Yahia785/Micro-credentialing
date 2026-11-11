import { useCallback, useEffect, useRef, useState } from 'react';
import {
  InterviewApiError,
  abandonInterview,
  answerInterview,
  getStudentInterview,
  interviewIdForSubmission,
  startInterview,
} from '../../api/interviews';
import { LEAVE_FINAL_MESSAGE, useInterviewLeaveGuard } from '../../hooks/useInterviewLeaveGuard';
import { useInterviewController } from '../../hooks/useInterviewController';
import { chatFromStudentView, progressLabel } from '../../utils/interview';
import { Alert, Badge, Button, Spinner } from '../ui';
import { WorkspaceShell } from '../workspace/WorkspaceShell';
import { InterviewChat } from './InterviewChat';
import { InterviewTimer } from './InterviewTimer';
import { InterviewWaiting } from './InterviewWaiting';
import styles from './StudentInterviewScreen.module.css';

const DEFAULT_MINUTES = 10;
const CODE_HIDDEN_NOTE = 'Your code will be visible again after your instructor reviews your submission.';
export const LEFT_PAGE_MESSAGE = 'This interview has ended because you left the page.';
/** How often the waiting page asks whether the interview is ready, and how long it waits before it opens the interview without what is not ready. */
const POLL_MS = 2000;
const PREPARE_WAIT_MS = 90000;

interface StudentInterviewScreenProps {
  /** The problem the code was submitted for. */
  title: string;
  submissionId: string;
  /** True right after submitting, in the page session that submitted: the only time an interview can be taken. */
  fresh?: boolean;
  /** From the problem's interview setup: the waiting page says how long the interview is. */
  timeLimitMinutes?: number;
  /** From the problem's interview setup: the waiting page says how many questions there are. */
  questionCount?: number;
  /** True while the recording upload of the submission is still running. The interview opens when it is over (done or failed). */
  uploading?: boolean;
  /** The code just submitted, shown until the interview itself provides it. */
  initialCode?: string;
  /** Called when the student closes the screen after the interview ended. */
  onClose: () => void;
}

type Phase = 'loading' | 'preparing' | 'active' | 'failed';
type CreateState = 'idle' | 'creating' | 'done' | 'error';

/**
 * The student's interview as a full-window workspace after submitting. It can be taken ONCE, right after submitting, in this page
 * session: create gives a session key that this screen keeps in memory only (never in storage), and opening the interview and every
 * answer carry it. Closing the tab, refreshing or leaving the page ends the interview as abandoned; any later open (without the key)
 * shows that it ended, and there is no retake.
 *
 * There is no Start button: the student lands on a waiting page, the interview is created automatically (the server then prepares it
 * in the background: runs the code, and for host.v7 analyzes it) while the recording upload finishes, the page polls until it is ready,
 * and the interview opens by itself. After 90 seconds it opens without what is not ready. Its clock starts when the first question is shown.
 */
export function StudentInterviewScreen({ title, submissionId, fresh = false, timeLimitMinutes, questionCount, uploading = false, initialCode, onClose }: StudentInterviewScreenProps) {
  const interviewId = interviewIdForSubmission(submissionId);
  const [phase, setPhase] = useState<Phase>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [createState, setCreateState] = useState<CreateState>('idle');
  const [createError, setCreateError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState(false);
  const uploadingRef = useRef(uploading);
  uploadingRef.current = uploading;
  // The session key lives in memory only: a refresh or a new tab loses it, which is the point.
  const keyRef = useRef<string | undefined>(undefined);
  const startedRef = useRef(false);

  const { chat, loading, loadError, sending, sendError, reload, sendAnswer } = useInterviewController({
    load: async () => chatFromStudentView(await getStudentInterview(interviewId, { sessionKey: keyRef.current })),
    send: (answer, timing) => answerInterview(interviewId, answer, timing, keyRef.current),
  });

  const inProgress = phase === 'active' && chat?.status === 'in_progress';
  // While the recordings are uploading, the proctoring guard of the page still owns in-app navigation; this guard takes over when the
  // upload is over. The browser's own warning for refresh and tab close is on the whole time.
  useInterviewLeaveGuard(inProgress || (fresh && phase === 'preparing'), {
    message: LEAVE_FINAL_MESSAGE,
    onConfirm: () => abandonInterview(interviewId),
    blockNavigation: !uploading,
  });

  /** Creates the interview and keeps its session key. 409 means it exists already (another tab, an earlier try): there is no key then. */
  const create = useCallback(async () => {
    setCreateState('creating');
    setCreateError(null);
    try {
      const result = await startInterview(submissionId);
      keyRef.current = result.sessionKey;
    } catch (error) {
      if (!(error instanceof InterviewApiError && error.status === 409)) {
        setCreateError(error instanceof InterviewApiError ? error.message : 'Something went wrong. Please try again.');
        setCreateState('error');
        return;
      }
    }
    setCreateState('done');
  }, [submissionId]);

  const openInterview = useCallback(async () => {
    setPhase('loading');
    setMessage(null);
    const result = await reload();
    if ('chat' in result) {
      setPhase('active');
    } else {
      setMessage(result.error.status === 404 ? 'This interview is not available: it can only be taken right after submitting.' : result.error.message);
      setPhase('failed');
    }
  }, [reload]);

  // Right after submitting: create the interview, once. Later (no key): only look at what became of it.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (fresh) {
      setPhase('preparing');
      void create();
    } else {
      void openInterview();
    }
  }, [fresh, create, openInterview]);

  // Poll until the server says the interview is ready (or failed), or until the wait is over: then it opens without the rest.
  useEffect(() => {
    if (phase !== 'preparing' || createState !== 'done' || prepared) return undefined;
    const startedAt = Date.now();
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      if (cancelled) return;
      try {
        const view = await getStudentInterview(interviewId, { peek: true });
        if (!cancelled && view.prepareStatus && view.prepareStatus !== 'preparing') {
          setPrepared(true);
          return;
        }
      } catch {
        // A failed poll is tried again until the wait is over.
      }
      if (Date.now() - startedAt >= PREPARE_WAIT_MS) {
        if (!cancelled) setPrepared(true);
        return;
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    timer = window.setTimeout(() => void tick(), 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [phase, createState, prepared, interviewId]);

  // The interview opens by itself when it is ready and the upload is over. Opening it is what starts its clock.
  useEffect(() => {
    if (phase !== 'preparing' || !prepared || uploading) return;
    void openInterview();
  }, [phase, prepared, uploading, openInterview]);

  const minutes = timeLimitMinutes ?? DEFAULT_MINUTES;
  const ended = chat?.status === 'abandoned' ? 'abandoned' : chat?.status === 'timed_out' ? 'timed_out' : 'completed';
  // The code is held for the instructor: the server gives it only while the interview runs, and it is not shown afterwards.
  const shownCode = chat?.status === 'in_progress' ? (chat.code ?? initialCode ?? null) : null;
  const codeNote = chat && chat.status !== 'in_progress' ? CODE_HIDDEN_NOTE : null;
  const progress = progressLabel(chat);

  const endedTitle = ended === 'abandoned' ? 'This interview has ended.' : ended === 'timed_out' ? "Time's up." : 'Interview complete.';
  const endedText =
    ended === 'abandoned'
      ? `${LEFT_PAGE_MESSAGE} It cannot be retaken. Your instructor will see the answers you gave.`
      : ended === 'timed_out'
        ? 'Your answers so far have been saved. Your instructor will review your answers.'
        : 'Your instructor will review your answers.';

  return (
    <WorkspaceShell
      label={`Interview: ${title}`}
      // No exit button before the end: leaving goes through the guards (the browser's warning and the navigation confirm).
      exit={undefined}
      title={`Interview: ${title}`}
      badges={progress ? <Badge variant="info">{progress}</Badge> : undefined}
      status={phase === 'active' ? <InterviewTimer chat={chat} frozen={sending} /> : undefined}
    >
      {phase === 'active' && chat ? (
        <InterviewChat
          chat={chat}
          code={shownCode}
          codeLoading={false}
          codeError={codeNote}
          sending={sending}
          sendError={sendError}
          loadError={loadError}
          reloading={loading}
          onSend={sendAnswer}
          onReload={reload}
          endedPanel={
            <div className={styles.ended} role="status">
              <h2 className={styles.endedTitle}>{endedTitle}</h2>
              <p className={styles.endedText}>{endedText}</p>
              <Button onClick={onClose}>Close</Button>
            </div>
          }
        />
      ) : (
        <div className={styles.scrollBody}>
          {phase === 'loading' && (
            <div className={styles.loading}>
              <Spinner decorative />
              <p className={styles.loadingText} role="status">
                Loading your interview…
              </p>
            </div>
          )}

          {phase === 'failed' && (
            <Alert variant="danger" title="Could not open your interview">
              <p className={styles.alertText}>{message}</p>
              <div className={styles.endedActions}>
                {fresh && (
                  <Button size="sm" variant="secondary" onClick={() => void openInterview()}>
                    Try again
                  </Button>
                )}
                <Button size="sm" variant="secondary" onClick={onClose}>
                  Close
                </Button>
              </div>
            </Alert>
          )}

          {phase === 'preparing' && (
            <InterviewWaiting
              minutes={minutes}
              questionCount={questionCount}
              uploadDone={!uploading}
              prepared={createState === 'done' && prepared}
              error={createState === 'error' ? createError : null}
              retrying={createState === 'creating' && createError !== null}
              onRetry={() => void create()}
            />
          )}
        </div>
      )}
    </WorkspaceShell>
  );
}
