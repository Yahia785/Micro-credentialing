import type { ReactNode } from 'react';
import { classNames } from '../../utils/classNames';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  /** Optional simple icon. Decorative. */
  icon?: ReactNode;
  title: string;
  description?: string;
  /** Next step, usually a <Button>. */
  action?: ReactNode;
  /** Heading level for the title. */
  headingLevel?: 1 | 2 | 3 | 4;
  className?: string;
}

export function EmptyState({ icon, title, description, action, headingLevel = 3, className }: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;

  return (
    <div className={classNames(styles.emptyState, className)}>
      {icon && (
        <div className={styles.icon} aria-hidden="true">
          {icon}
        </div>
      )}
      <Heading className={styles.title}>{title}</Heading>
      {description && <p className={styles.description}>{description}</p>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
