import { useEffect, useRef, useState } from 'react';
import type { ChatInterview } from '../types/interview';
import { remainingMs } from '../utils/interview';

/**
 * Milliseconds left in the interview, or null before it is loaded. It follows the server's clock (deadline minus serverNow,
 * counted down from when the interview was received), so a wrong laptop clock does not matter.
 *
 * While `frozen` (the agent is working on the student's answer) the value stays where it was: the server adds that waiting
 * time to the deadline, so the countdown continues from the new deadline when the next question arrives.
 */
export function useCountdown(chat: ChatInterview | null, frozen = false): number | null {
  const [, setTick] = useState(0);
  const frozenValue = useRef<number | null>(null);

  useEffect(() => {
    if (!chat || chat.status !== 'in_progress' || frozen) return undefined;
    const id = window.setInterval(() => setTick((tick) => tick + 1), 250);
    return () => window.clearInterval(id);
  }, [chat, frozen]);

  const live = chat ? remainingMs(chat, performance.now()) : null;
  if (frozen) {
    if (frozenValue.current === null) frozenValue.current = live;
    return frozenValue.current;
  }
  frozenValue.current = null;
  return live;
}
