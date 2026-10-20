import { createContext } from 'react';

export interface AssessmentSessionValue {
  /** Called by the navigation guard so the layout knows a proctored session is in progress. */
  setActive: (active: boolean) => void;
}

/** Null outside AppLayout; consumers must tolerate that. */
export const AssessmentSessionContext = createContext<AssessmentSessionValue | null>(null);
