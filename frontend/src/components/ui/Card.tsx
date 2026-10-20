import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { classNames } from '../../utils/classNames';
import styles from './Card.module.css';

export interface CardProps extends Omit<ComponentPropsWithoutRef<'div'>, 'title'> {
  /** Header title. The header renders when `title` or `actions` is provided. */
  title?: ReactNode;
  /** Heading level for the title, so the page's heading order stays correct. */
  headingLevel?: 2 | 3 | 4;
  /** Slot on the right of the header (buttons, badges). */
  actions?: ReactNode;
  footer?: ReactNode;
  /** Subtle border/shadow change on hover and keyboard focus within. No movement. */
  interactive?: boolean;
}

export function Card({
  title,
  headingLevel = 3,
  actions,
  footer,
  interactive = false,
  className,
  children,
  ...rest
}: CardProps) {
  const Heading = `h${headingLevel}` as const;
  const hasHeader = title !== undefined || actions !== undefined;

  return (
    <div
      {...rest}
      className={classNames(styles.card, interactive && styles.interactive, className)}
    >
      {hasHeader && (
        <div className={styles.header}>
          {title !== undefined && <Heading className={styles.title}>{title}</Heading>}
          {actions !== undefined && <div className={styles.actions}>{actions}</div>}
        </div>
      )}
      <div className={styles.body}>{children}</div>
      {footer !== undefined && <div className={styles.footer}>{footer}</div>}
    </div>
  );
}
