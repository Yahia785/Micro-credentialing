import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './WorkspaceShell.module.css';

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
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    return () => {
      document.body.style.overflow = original;
      root?.removeAttribute('inert');
    };
  }, []);

  return createPortal(
    <div className={styles.shell} role="dialog" aria-modal="true" aria-label={label}>
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
