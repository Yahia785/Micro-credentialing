import { useEffect, useRef } from 'react';
import { useBlocker } from 'react-router';

export const LEAVE_INTERVIEW_MESSAGE =
  'Leave the interview? The timer keeps running, and you can come back to continue until time runs out. Your answers so far are saved.';

/**
 * While `active`, leaving the interview only asks for confirmation. Unlike the proctored editor it never submits or ends
 * anything: in-app navigation shows the same kind of confirm, and a refresh or tab close shows the browser's own warning.
 */
export function useInterviewLeaveGuard(active: boolean) {
  const blocker = useBlocker(active);
  const handlingRef = useRef(false);

  useEffect(() => {
    if (blocker.state !== 'blocked' || handlingRef.current) return;
    handlingRef.current = true;
    // TODO(later phase): replace window.confirm with a proper dialog, like the editor's leave guard.
    if (window.confirm(LEAVE_INTERVIEW_MESSAGE)) blocker.proceed();
    else blocker.reset();
    handlingRef.current = false;
  }, [blocker]);

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
