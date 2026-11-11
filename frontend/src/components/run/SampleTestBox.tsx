import type { ReactNode } from 'react';
import { Badge } from '../ui';
import type { SampleTestStatus } from './sampleStatus';
import styles from './SampleTestBox.module.css';

const LABEL: Record<SampleTestStatus, string> = { idle: 'Not run yet', passed: 'Passed', failed: 'Failed' };

interface SampleTestBoxProps {
  title: ReactNode;
  status: SampleTestStatus;
  /** Extra text next to the label, e.g. "Time limit exceeded". */
  note?: ReactNode;
  children: ReactNode;
}

/** A sample test with a coloured left edge and a text label: green passed, red failed, neutral not run yet. */
export function SampleTestBox({ title, status, note, children }: SampleTestBoxProps) {
  return (
    <div className={`${styles.box} ${styles[status]}`}>
      <div className={styles.head}>
        <span className={styles.title}>{title}</span>
        <Badge variant={status === 'passed' ? 'success' : status === 'failed' ? 'danger' : 'neutral'}>{LABEL[status]}</Badge>
        {note}
      </div>
      {children}
    </div>
  );
}
