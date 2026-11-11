import { createContext } from 'react';

/**
 * True for a workspace that is still mounted (the coding editor, finishing its recording upload) while another workspace (the interview)
 * is shown over it. The inactive one is made inert, so keyboard and screen reader users stay in the one on top.
 */
export const WorkspaceInactiveContext = createContext(false);
