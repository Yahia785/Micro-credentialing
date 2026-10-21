import { createContext } from 'react';

/** What the layout needs to end a live proctored session before it signs the user out. */
export interface ActiveAssessmentSession {
  /** Submits the current work as the final answer. Never rejects; failures are logged by the guard. */
  submitAndLeave: () => Promise<void>;
}

export interface AssessmentSessionValue {
  /** Called by the navigation guard: a session while one is live, null otherwise. */
  register: (session: ActiveAssessmentSession | null) => void;
}

/** Null outside AppLayout; consumers must tolerate that. */
export const AssessmentSessionContext = createContext<AssessmentSessionValue | null>(null);
