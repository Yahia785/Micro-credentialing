import { useContext, useEffect } from 'react';
import { useBlocker } from 'react-router';
import { AssessmentSessionContext } from '../context/AssessmentSessionContext';

export const LEAVE_ASSESSMENT_MESSAGE =
  'Leaving will end your proctored session and your work will not be submitted. Leave anyway?';

/**
 * While `active`, asks for confirmation before in-app navigation (Back/Forward, links) and
 * triggers the browser's native warning on refresh or tab close. Also tells AppLayout a session
 * is in progress so Sign out can confirm too.
 */
export function useAssessmentNavigationGuard(active: boolean) {
  const blocker = useBlocker(active);
  const session = useContext(AssessmentSessionContext);
  const setSessionActive = session?.setActive;

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    // TODO(later phase): replace window.confirm with a proper dialog.
    if (window.confirm(LEAVE_ASSESSMENT_MESSAGE)) {
      blocker.proceed();
    } else {
      blocker.reset();
    }
  }, [blocker]);

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
    if (!active || !setSessionActive) return;
    setSessionActive(true);
    return () => setSessionActive(false);
  }, [active, setSessionActive]);
}
