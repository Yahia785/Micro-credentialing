import { classNames } from '../../utils/classNames';
import styles from './Spinner.module.css';

export type SpinnerSize = 'sm' | 'md' | 'lg';

export interface SpinnerProps {
  size?: SpinnerSize;
  /** Accessible label announced to screen readers. */
  label?: string;
  /** Hide from assistive tech when a parent already conveys the loading state. */
  decorative?: boolean;
  className?: string;
}

export function Spinner({ size = 'md', label = 'Loading', decorative = false, className }: SpinnerProps) {
  const ring = <span className={styles.ring} aria-hidden="true" />;

  if (decorative) {
    return <span className={classNames(styles.spinner, styles[size], className)}>{ring}</span>;
  }

  return (
    <span className={classNames(styles.spinner, styles[size], className)} role="status">
      {ring}
      <span className={styles.srOnly}>{label}</span>
    </span>
  );
}
