import { useEffect, useRef } from 'react';
import { useBlocker } from 'react-router';

/** A practice interview (an instructor's): leaving only asks for confirmation, and they can come back. */
export const LEAVE_INTERVIEW_MESSAGE =
  'Leave the interview? The timer keeps running, and you can come back to continue until time runs out. Your answers so far are saved.';

/** A student's interview can be taken once, right after submitting. */
export const LEAVE_FINAL_MESSAGE = 'Leaving now ends your interview. You cannot retake it.';

interface Options {
  /** The confirm text for in-app navigation. */
  message?: string;
  /** Runs when the person confirms leaving, before the navigation goes on (the student's interview is abandoned here). */
  onConfirm?: () => Promise<unknown> | void;
  /** False: only the browser's own warning for refresh and tab close, no confirm for in-app navigation (another guard owns that). */
  blockNavigation?: boolean;
}

/**
 * While `active`, leaving the interview asks first: in-app navigation shows a confirm (with `message`), and a refresh or tab close
 * shows the browser's own warning. With `onConfirm` a confirmed leave runs it first (a student's interview ends there).
 */
export function useInterviewLeaveGuard(active: boolean, { message = LEAVE_INTERVIEW_MESSAGE, onConfirm, blockNavigation = true }: Options = {}) {
  const blocker = useBlocker(active && blockNavigation);
  const handlingRef = useRef(false);
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;

  useEffect(() => {
    if (blocker.state !== 'blocked' || handlingRef.current) return;
    handlingRef.current = true;
    // TODO(later phase): replace window.confirm with a proper dialog, like the editor's leave guard.
    if (window.confirm(message)) {
      void (async () => {
        try {
          await confirmRef.current?.();
        } catch {
          // Leaving is never blocked by a failed request: an interview left without its page is abandoned the next time it is opened.
        }
        blocker.proceed();
        handlingRef.current = false;
      })();
    } else {
      blocker.reset();
      handlingRef.current = false;
    }
  }, [blocker, message]);

  useEffect(() => {
    if (!active) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = ''; // Required by some browsers to show the native prompt.
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [active]);
}
