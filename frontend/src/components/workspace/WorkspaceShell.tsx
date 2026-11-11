import { useContext, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './WorkspaceShell.module.css';
import { WorkspaceInactiveContext } from './WorkspaceInactiveContext';

// More than one workspace can be open at once (the interview over the editor that is still uploading): the page behind stays locked until
// the last one closes, and the scroll lock is put back to what it was before the first one opened.
let openShells = 0;
let savedOverflow = '';

export interface WorkspaceShellProps {
  /** Accessible name of the workspace. */
  label: string;
  /** Left of the title: the exit or back button, when there is one. */
  exit?: ReactNode;
  title: string;
  /** Next to the title: difficulty, status badges. */
  badges?: ReactNode;
  /** Right side, before the actions: timer, recording indicator. */
  status?: ReactNode;
  /** Far right: the one primary action (for example Submit). */
  actions?: ReactNode;
  /** A full-width message under the top bar (for example the status of a finished submission). */
  notice?: ReactNode;
  children: ReactNode;
}

/**
 * The full-window workspace used by the coding session and the interview: a top bar and a body that fills the rest of the
 * window. It covers the whole viewport (the app header and sidebar do not show behind it), the browser page never scrolls, and
 * each pane inside scrolls on its own.
 */
export function WorkspaceShell({ label, exit, title, badges, status, actions, notice, children }: WorkspaceShellProps) {
  // The page behind is locked and out of reach of keyboard focus while the workspace is open.
  useEffect(() => {
    if (openShells === 0) savedOverflow = document.body.style.overflow;
    openShells += 1;
    document.body.style.overflow = 'hidden';
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    return () => {
      openShells -= 1;
      if (openShells > 0) return;
      document.body.style.overflow = savedOverflow;
      root?.removeAttribute('inert');
    };
  }, []);

  // Under another workspace: out of reach of the keyboard and of screen readers (it stays mounted, for example to finish an upload).
  const inactive = useContext(WorkspaceInactiveContext);
  const shellRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    shellRef.current?.toggleAttribute('inert', inactive);
  }, [inactive]);

  return createPortal(
    <div ref={shellRef} className={styles.shell} role="dialog" aria-modal="true" aria-label={label} aria-hidden={inactive || undefined}>
      <header className={styles.topBar}>
        {exit && <div className={styles.exit}>{exit}</div>}
        <div className={styles.titleGroup}>
          <h1 className={styles.title}>{title}</h1>
          {badges && <div className={styles.badges}>{badges}</div>}
        </div>
        <div className={styles.right}>
          {status && <div className={styles.status}>{status}</div>}
          {actions && <div className={styles.actions}>{actions}</div>}
        </div>
      </header>
      {notice && <div className={styles.notice}>{notice}</div>}
      <div className={styles.body}>{children}</div>
    </div>,
    document.body,
  );
}
