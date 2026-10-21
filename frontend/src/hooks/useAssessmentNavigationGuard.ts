import { useContext, useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router';
import { AssessmentSessionContext } from '../context/AssessmentSessionContext';
import type { SubmitOutcome } from '../types/submission';
import { proctoringLogger } from '../utils/proctoringLogger';

export const SUBMIT_AND_LEAVE_MESSAGE =
  'Leaving will submit your current code as your final answer and end the proctored session. Submit and leave?';

/**
 * While `active`, leaving a proctored assessment counts as submitting it.
 *
 * - In-app navigation (Back/Forward, links) is blocked and the student is asked to confirm. On OK the
 *   blocker stays blocked while `submitAndLeave` runs (the caller shows a blocking state using the
 *   returned `isSubmitting`), and only then does the navigation proceed. Cancel changes nothing.
 * - The same `submitAndLeave` is registered with the layout so Sign out can do the same.
 * - Refresh / tab close only trigger the browser's native warning. We deliberately do NOT submit from
 *   `beforeunload`: async work (grading, uploading recordings) can't finish reliably once the page
 *   is going away, and a half-finished submit would be worse than none. The server-side "attempt
 *   started" record planned for the editor rebuild phase will close this gap.
 */
export function useAssessmentNavigationGuard(
  active: boolean,
  submitAndEnd: () => Promise<SubmitOutcome>,
  /** Runs after the leave-submit settles and before the navigation proceeds (e.g. refresh the profile). Not used by Sign out. */
  beforeProceed?: () => Promise<void>,
) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Stay blocking for the whole submit, even if the profile refresh makes `active` false midway.
  const blocker = useBlocker(active || isSubmitting);
  const session = useContext(AssessmentSessionContext);
  const register = session?.register;

  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  const submitRef = useRef(submitAndEnd);
  submitRef.current = submitAndEnd;
  const beforeProceedRef = useRef(beforeProceed);
  beforeProceedRef.current = beforeProceed;
  const handlingRef = useRef(false);

  /** Runs the submit; failures are logged but never stop the student from leaving. */
  const submitAndLeave = useRef(async () => {
    try {
      const outcome = await submitRef.current();
      if (!outcome.ok) {
        proctoringLogger.log('submit_on_leave_failed', 'error', { error: outcome.error });
      }
    } catch (err) {
      proctoringLogger.log('submit_on_leave_failed', 'error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }).current;

  useEffect(() => {
    if (blocker.state !== 'blocked' || handlingRef.current) return;
    handlingRef.current = true;

    // TODO(later phase): replace window.confirm with a proper dialog.
    if (!window.confirm(SUBMIT_AND_LEAVE_MESSAGE)) {
      blocker.reset();
      handlingRef.current = false;
      return;
    }

    setIsSubmitting(true);
    void submitAndLeave().then(async () => {
      try {
        await beforeProceedRef.current?.();
      } catch (err) {
        // Never keep the student from leaving because of a refresh problem.
        console.error('[proctoring] beforeProceed failed:', err);
      }
    }).finally(() => {
      const current = blockerRef.current;
      if (current.state === 'blocked') current.proceed();
      setIsSubmitting(false);
      handlingRef.current = false;
    });
  }, [blocker, submitAndLeave]);

  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = ''; // Required by some browsers to show the native prompt.
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [active]);

  useEffect(() => {
    if (!active || !register) return;
    register({ submitAndLeave });
    return () => register(null);
  }, [active, register, submitAndLeave]);

  return { isSubmitting };
}
