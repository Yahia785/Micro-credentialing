import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { classNames } from '../../utils/classNames';
import styles from './Alert.module.css';

export type AlertVariant = 'info' | 'success' | 'warning' | 'danger';

export interface AlertProps extends Omit<ComponentPropsWithoutRef<'div'>, 'title'> {
  variant?: AlertVariant;
  title?: ReactNode;
  /** When provided, a dismiss button is shown and calls this on click. */
  onDismiss?: () => void;
  /** Accessible name for the dismiss button. */
  dismissLabel?: string;
}

export function Alert({
  variant = 'info',
  title,
  onDismiss,
  dismissLabel = 'Dismiss message',
  className,
  children,
  ...rest
}: AlertProps) {
  // Only errors interrupt; warning, info and success are announced politely.
  const role = variant === 'danger' ? 'alert' : 'status';

  return (
    <div role={role} {...rest} className={classNames(styles.alert, styles[variant], className)}>
      <div className={styles.content}>
        {title !== undefined && <p className={styles.title}>{title}</p>}
        <div className={styles.message}>{children}</div>
      </div>
      {onDismiss && (
        <button type="button" className={styles.dismiss} onClick={onDismiss} aria-label={dismissLabel}>
          <svg viewBox="0 0 16 16" className={styles.dismissIcon} aria-hidden="true" focusable="false">
            <path d="M3 3l10 10M13 3L3 13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
