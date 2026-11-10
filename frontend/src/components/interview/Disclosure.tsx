import { useContext, useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { classNames } from '../../utils/classNames';
import { DisclosureSignalContext } from './disclosureSignal';
import styles from './Disclosure.module.css';

interface DisclosureProps {
  /** Always visible; it is the button that opens and closes the section. */
  title: ReactNode;
  /** Visible next to the title, outside the button (for controls of their own). */
  aside?: ReactNode;
  headingLevel?: 3 | 4 | 5;
  defaultOpen?: boolean;
  /** `section` is a main block with its own background; `row` is a lighter line inside one. */
  variant?: 'section' | 'row';
  /** Extra emphasis for the whole block, e.g. the instructor changed something in it. */
  tone?: 'default' | 'changed';
  className?: string;
  children: ReactNode;
}

/** A collapsible block: a heading with a button, and content that is hidden (not removed) while closed. */
export function Disclosure({
  title,
  aside,
  headingLevel = 4,
  defaultOpen = false,
  variant = 'row',
  tone = 'default',
  className,
  children,
}: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const signal = useContext(DisclosureSignalContext);
  const Heading = `h${headingLevel}` as const;

  // Expand all / Collapse all.
  useEffect(() => {
    if (signal.tick > 0) setOpen(signal.open);
  }, [signal]);

  return (
    <div className={classNames(styles.block, styles[variant], tone === 'changed' && styles.changed, open && styles.open, className)}>
      <div className={styles.head}>
        <Heading className={styles.heading}>
          <button type="button" className={styles.toggle} aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((value) => !value)}>
            <span className={styles.chevron} aria-hidden="true" />
            <span className={styles.title}>{title}</span>
          </button>
        </Heading>
        {aside !== undefined && <div className={styles.aside}>{aside}</div>}
      </div>
      <div id={bodyId} className={styles.body} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
