import { useCallback, useEffect, useRef, useState } from 'react';
import {
  InterviewApiError,
  answerInterview,
  getStudentInterview,
  interviewIdForSubmission,
  startInterview,
} from '../../api/interviews';
import { useInterviewLeaveGuard } from '../../hooks/useInterviewLeaveGuard';
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

interface StudentInterviewScreenProps {
  /** The problem the code was submitted for. */
  title: string;
  submissionId: string;
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
 * The student's interview as a full-window workspace after submitting. There is no Start button: the student lands on a waiting page,
 * the interview is created automatically (the code is classified and the code runs are done on the server) while the recording upload
 * finishes, and the interview opens by itself when both are done. Its clock starts when the first question is shown. It also finds an
 * interview that already exists (a reload, coming back later) and continues where it was, with the time that is left.
 */
export function StudentInterviewScreen({ title, submissionId, timeLimitMinutes, questionCount, uploading = false, initialCode, onClose }: StudentInterviewScreenProps) {
  const interviewId = interviewIdForSubmission(submissionId);
  const [phase, setPhase] = useState<Phase>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [createState, setCreateState] = useState<CreateState>('idle');
  const [createError, setCreateError] = useState<string | null>(null);
  const uploadingRef = useRef(uploading);
  uploadingRef.current = uploading;

  const { chat, loading, loadError, sending, sendError, reload, sendAnswer } = useInterviewController({
    load: async () => chatFromStudentView(await getStudentInterview(interviewId)),
    send: (answer, timing) => answerInterview(interviewId, answer, timing),
  });

  const inProgress = phase === 'active' && chat?.status === 'in_progress';
  // While the recordings are uploading, the proctoring guard of the page is still the one that watches navigation (leaving waits for the
  // upload); this guard takes over when it is done. In the running interview leaving only asks for confirmation and ends nothing.
  useInterviewLeaveGuard(inProgress || (phase === 'preparing' && !uploading));

  /** Creates the interview. 409 means it exists already (another tab, an earlier try): that is fine. */
  const create = useCallback(async () => {
    setCreateState('creating');
    setCreateError(null);
    try {
      await startInterview(submissionId);
    } catch (error) {
      if (!(error instanceof InterviewApiError && error.status === 409)) {
        setCreateError(error instanceof InterviewApiError ? error.message : 'Something went wrong. Please try again.');
        setCreateState('error');
        return;
      }
    }
    setCreateState('done');
  }, [submissionId]);

  const findExisting = useCallback(async () => {
    setPhase('loading');
    setMessage(null);
    if (uploadingRef.current) {
      // Only ask whether it exists: opening it would start its clock while the upload is still running.
      try {
        await getStudentInterview(interviewId, { peek: true });
        setCreateState('done');
        setPhase('preparing');
      } catch (error) {
        if (error instanceof InterviewApiError && error.status === 404) {
          setPhase('preparing');
          void create();
        } else {
          setMessage(error instanceof InterviewApiError ? error.message : 'Something went wrong. Please try again.');
          setPhase('failed');
        }
      }
      return;
    }
    const result = await reload();
    if ('chat' in result) {
      setPhase('active');
    } else if (result.error.status === 404) {
      setPhase('preparing');
      void create();
    } else {
      setMessage(result.error.message);
      setPhase('failed');
    }
  }, [create, interviewId, reload]);

  useEffect(() => {
    void findExisting();
  }, [findExisting]);

  // The interview opens by itself when it is ready and the upload is over. Opening it is what starts its clock.
  useEffect(() => {
    if (phase !== 'preparing' || createState !== 'done' || uploading) return undefined;
    let cancelled = false;
    void (async () => {
      const result = await reload();
      if (cancelled) return;
      if ('chat' in result) {
        setPhase('active');
      } else {
        setMessage(result.error.message);
        setPhase('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, createState, uploading, reload]);

  const minutes = timeLimitMinutes ?? DEFAULT_MINUTES;
  const ended = chat?.status === 'timed_out' ? 'timed_out' : 'completed';
  // The code is held for the instructor: the server gives it only while the interview runs, and it is not shown afterwards.
  const shownCode = chat?.status === 'in_progress' ? (chat.code ?? initialCode ?? null) : null;
  const codeNote = chat && chat.status !== 'in_progress' ? CODE_HIDDEN_NOTE : null;
  const progress = progressLabel(chat);

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
              <h2 className={styles.endedTitle}>{ended === 'timed_out' ? "Time's up." : 'Interview complete.'}</h2>
              <p className={styles.endedText}>
                {ended === 'timed_out'
                  ? 'Your answers so far have been saved. Your instructor will review your answers.'
                  : 'Your instructor will review your answers.'}
              </p>
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
            <Alert variant="danger" title="Could not load your interview">
              <p className={styles.alertText}>{message}</p>
              <Button size="sm" variant="secondary" onClick={() => void findExisting()}>
                Try again
              </Button>
            </Alert>
          )}

          {phase === 'preparing' && (
            <InterviewWaiting
              minutes={minutes}
              questionCount={questionCount}
              uploadDone={!uploading}
              prepared={createState === 'done'}
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
