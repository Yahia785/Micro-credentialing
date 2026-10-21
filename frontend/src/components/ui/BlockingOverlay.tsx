import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Spinner } from './Spinner';
import styles from './BlockingOverlay.module.css';

export interface BlockingOverlayProps {
  message: string;
  /** Optional second line (e.g. "Please keep this tab open."). */
  detail?: string;
}

/**
 * Full-screen state that blocks all interaction while work is in progress.
 * Rendered into document.body, and the app root is made inert so keyboard focus can't reach it.
 */
export function BlockingOverlay({ message, detail }: BlockingOverlayProps) {
  useEffect(() => {
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    return () => root?.removeAttribute('inert');
  }, []);

  return createPortal(
    <div className={styles.overlay}>
      <div className={styles.panel} role="alert" aria-live="assertive">
        <Spinner size="lg" decorative />
        <p className={styles.message}>{message}</p>
        {detail && <p className={styles.detail}>{detail}</p>}
      </div>
    </div>,
    document.body,
  );
}
