import { useCallback, useEffect, useState } from 'react';
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
import { Alert, Badge, Button, Card, Spinner } from '../ui';
import { WorkspaceShell } from '../workspace/WorkspaceShell';
import { InterviewChat } from './InterviewChat';
import { InterviewTimer } from './InterviewTimer';
import styles from './StudentInterviewScreen.module.css';

const DEFAULT_MINUTES = 10;
const UNDER_REVIEW_MESSAGE =
  'Your submission is under review. Your results, the test cases and your code will be visible after your instructor reviews it.';
const CODE_HIDDEN_NOTE = 'Your code will be visible again after your instructor reviews your submission.';

interface StudentInterviewScreenProps {
  /** The problem the code was submitted for. */
  title: string;
  submissionId: string;
  /** From the problem's setup; the intro says how long the interview is. */
  timeLimitMinutes?: number;
  /** The code just submitted, shown until the interview itself provides it. */
  initialCode?: string;
  /** Called when the student closes the screen, finished or not. */
  onClose: () => void;
}

type Phase = 'loading' | 'intro' | 'starting' | 'active' | 'failed';

/**
 * The student's interview as a full-window workspace after submitting: intro and Start, then the code next to the conversation
 * (countdown in the top bar), then the end screen. It finds an interview that already exists (reload, coming back later) and
 * continues where it was.
 */
export function StudentInterviewScreen({ title, submissionId, timeLimitMinutes, initialCode, onClose }: StudentInterviewScreenProps) {
  const interviewId = interviewIdForSubmission(submissionId);
  const [phase, setPhase] = useState<Phase>('loading');
  const [message, setMessage] = useState<string | null>(null);

  const { chat, loading, loadError, sending, sendError, reload, sendAnswer } = useInterviewController({
    load: async () => chatFromStudentView(await getStudentInterview(interviewId)),
    send: (answer, timing) => answerInterview(interviewId, answer, timing),
  });

  const inProgress = phase === 'active' && chat?.status === 'in_progress';
  useInterviewLeaveGuard(inProgress);

  const findExisting = useCallback(async () => {
    setPhase('loading');
    setMessage(null);
    const result = await reload();
    if ('chat' in result) {
      setPhase('active');
    } else if (result.error.status === 404) {
      setPhase('intro');
    } else {
      setMessage(result.error.message);
      setPhase('failed');
    }
  }, [reload]);

  useEffect(() => {
    void findExisting();
  }, [findExisting]);

  const start = async () => {
    setPhase('starting');
    setMessage(null);
    try {
      await startInterview(submissionId);
    } catch (error) {
      // 409: it was already started (for example in another tab). Carry on with that one.
      if (!(error instanceof InterviewApiError && error.status === 409)) {
        setMessage(error instanceof InterviewApiError ? error.message : 'Could not start the interview. Please try again.');
        setPhase('intro');
        return;
      }
    }
    const result = await reload();
    if ('chat' in result) {
      setPhase('active');
    } else {
      setMessage(`The interview was started, but it could not be loaded. ${result.error.message}`);
      setPhase('intro');
    }
  };

  const minutes = timeLimitMinutes ?? DEFAULT_MINUTES;
  const ended = chat?.status === 'timed_out' ? 'timed_out' : 'completed';
  const finished = phase === 'active' && chat !== null && chat.status !== 'in_progress';
  // The code is held for the instructor: the server gives it only while the interview runs, and it is not shown afterwards.
  const shownCode = chat?.status === 'in_progress' ? (chat.code ?? initialCode ?? null) : null;
  const codeNote = chat && chat.status !== 'in_progress' ? CODE_HIDDEN_NOTE : null;
  const progress = progressLabel(chat);

  return (
    <WorkspaceShell
      label={`Interview: ${title}`}
      // While the interview is running there is no exit button: leaving goes through the leave guard (the browser's warning and
      // the navigation confirm), which never ends or submits anything.
      exit={
        finished || inProgress ? undefined : (
          <Button size="sm" variant="secondary" onClick={onClose} disabled={phase === 'starting'}>
            Not now
          </Button>
        )
      }
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

          {(phase === 'intro' || phase === 'starting') && (
            <Card title="Before you start" headingLevel={2} className={styles.intro}>
              <Alert variant="info" title="Your submission is saved" className={styles.introAlert}>
                <p className={styles.alertText}>{UNDER_REVIEW_MESSAGE}</p>
              </Alert>
              <p>
                This is a short interview about the code you just submitted. An interviewer asks you questions one at a time,
                and you answer by typing.
              </p>
              <ul className={styles.facts}>
                <li>It takes up to {minutes} minutes. The timer starts when you press Start interview.</li>
                <li>You see your submitted code next to the conversation.</li>
                <li>Press Enter to send an answer, or Shift+Enter for a new line.</li>
                <li>Your instructor reviews your answers afterwards. You do not get a score here.</li>
              </ul>
              {message && (
                <Alert variant="danger">
                  <p className={styles.alertText}>{message}</p>
                </Alert>
              )}
              <div>
                <Button onClick={() => void start()} loading={phase === 'starting'}>
                  {phase === 'starting' ? 'Starting…' : message ? 'Try again' : 'Start interview'}
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}
    </WorkspaceShell>
  );
}
