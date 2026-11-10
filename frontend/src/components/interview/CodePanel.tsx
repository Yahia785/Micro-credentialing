import { useId, useMemo, useState } from 'react';
import { Alert, Button, Spinner } from '../ui';
import { classNames } from '../../utils/classNames';
import { highlightCode } from '../../utils/highlightCode';
import styles from './CodePanel.module.css';

interface CodePanelProps {
  title?: string;
  /** The code to show. null while it is loading or when it could not be loaded. */
  code: string | null;
  loading?: boolean;
  /** Shown instead of the code when it could not be loaded. */
  error?: string | null;
  /** On narrow screens the panel can be collapsed above the chat. It starts collapsed there. */
  collapsible?: boolean;
  /** Fill the height of the pane it is in; the code scrolls inside. Otherwise it is at most 70% of the window tall. */
  fill?: boolean;
  className?: string;
}

/** Read-only code with line numbers, in a bordered monospace block that scrolls sideways instead of wrapping. */
export function CodePanel({ title = 'Your submitted code', code, loading = false, error = null, collapsible = true, fill = false, className }: CodePanelProps) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const lines = useMemo(() => (code === null ? [] : highlightCode(code)), [code]);

  return (
    <section className={classNames(styles.panel, fill && styles.fill, className)} aria-label={title}>
      <div className={styles.header}>
        <h2 className={styles.title}>{title}</h2>
        {collapsible && (
          <Button
            size="sm"
            variant="secondary"
            className={styles.toggle}
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? 'Hide code' : 'Show code'}
          </Button>
        )}
      </div>

      <div id={bodyId} className={classNames(styles.body, collapsible && !expanded && styles.collapsed)}>
        {loading && (
          <p className={styles.status} role="status">
            <Spinner size="sm" decorative /> Loading your code…
          </p>
        )}
        {!loading && error && <Alert variant="warning">{error}</Alert>}
        {!loading && !error && code !== null && (
          <div className={styles.scroller} tabIndex={0} role="region" aria-label={`${title}, read only`}>
            <pre className={styles.code}>
              <code>
                {lines.map((line, index) => (
                  <span key={index} className={styles.line}>
                    {line.length === 0 ? ' ' : line.map((token, tokenIndex) => (
                      <span key={tokenIndex} className={styles[token.type]}>
                        {token.text}
                      </span>
                    ))}
                  </span>
                ))}
              </code>
            </pre>
          </div>
        )}
      </div>
    </section>
  );
}
