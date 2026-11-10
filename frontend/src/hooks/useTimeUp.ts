import { useEffect, useState } from 'react';
import type { ChatInterview } from '../types/interview';
import { remainingMs } from '../utils/interview';

/**
 * True once the countdown has reached 0:00. It sets one timeout for that moment instead of ticking, so the component using it
 * does not re-render every second (only the timer in the top bar does). While `frozen` (the agent is working on an answer) the
 * clock is stopped, so nothing changes.
 */
export function useTimeUp(chat: ChatInterview | null, frozen: boolean): boolean {
  const [timeUp, setTimeUp] = useState(false);

  useEffect(() => {
    if (!chat || chat.status !== 'in_progress') {
      setTimeUp(false);
      return undefined;
    }
    if (frozen) return undefined;
    const left = remainingMs(chat);
    if (left <= 0) {
      setTimeUp(true);
      return undefined;
    }
    setTimeUp(false);
    const id = window.setTimeout(() => setTimeUp(true), left + 50);
    return () => window.clearTimeout(id);
  }, [chat, frozen]);

  return timeUp;
}
