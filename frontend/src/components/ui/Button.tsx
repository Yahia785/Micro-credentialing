import type { ComponentPropsWithRef, ReactNode } from 'react';
import { classNames } from '../../utils/classNames';
import { Spinner } from './Spinner';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button. Change the label (e.g. "Submitting…") alongside it. */
  loading?: boolean;
  /** Optional leading icon. Decorative; the label carries the meaning. */
  icon?: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  disabled,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={classNames(styles.button, styles[variant], styles[size], className)}
    >
      {loading ? (
        <Spinner size="sm" decorative className={styles.spinner} />
      ) : (
        icon && (
          <span className={styles.icon} aria-hidden="true">
            {icon}
          </span>
        )
      )}
      {children}
    </button>
  );
}
