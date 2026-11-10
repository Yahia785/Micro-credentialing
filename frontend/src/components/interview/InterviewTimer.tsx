import { useCountdown } from '../../hooks/useCountdown';
import type { ChatInterview } from '../../types/interview';
import { classNames } from '../../utils/classNames';
import { formatClock } from '../../utils/interview';
import styles from './InterviewTimer.module.css';

const WARNING_SECONDS = 60;

interface InterviewTimerProps {
  chat: ChatInterview | null;
  /** The agent is working on an answer: the clock stands still. */
  frozen?: boolean;
}

/**
 * The countdown for the top bar. It follows the server's clock, stands still while the agent works, and turns red in the last
 * minute. It is the only part of the screen that updates every second. Renders nothing once the interview is over.
 */
export function InterviewTimer({ chat, frozen = false }: InterviewTimerProps) {
  const remaining = useCountdown(chat, frozen);
  if (!chat || chat.status !== 'in_progress') return null;

  const timeUp = !frozen && remaining !== null && remaining <= 0;
  const low = remaining !== null && remaining > 0 && remaining <= WARNING_SECONDS * 1000;

  return (
    <div className={classNames(styles.timer, (low || timeUp) && styles.low)}>
      {timeUp ? (
        <strong className={styles.timeUp}>Time&apos;s up.</strong>
      ) : (
        <>
          <span className={styles.label}>{frozen ? 'Paused' : 'Time left'}</span>
          <strong role="timer" aria-live="off" className={styles.clock}>
            {remaining === null ? '--:--' : formatClock(remaining)}
          </strong>
        </>
      )}
      {/* Spoken once, not every second. */}
      <span className={styles.srOnly} role="status">
        {timeUp ? "Time's up." : low ? 'One minute left.' : ''}
      </span>
    </div>
  );
}
