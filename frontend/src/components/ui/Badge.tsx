import type { ComponentPropsWithoutRef } from 'react';
import { classNames } from '../../utils/classNames';
import styles from './Badge.module.css';

export type BadgeVariant = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface BadgeProps extends ComponentPropsWithoutRef<'span'> {
  variant?: BadgeVariant;
}

export function Badge({ variant = 'neutral', className, children, ...rest }: BadgeProps) {
  return (
    <span {...rest} className={classNames(styles.badge, styles[variant], className)}>
      {children}
    </span>
  );
}
