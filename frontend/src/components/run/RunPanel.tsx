import { useId, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import { Alert, Badge } from '../ui';
import type { BadgeVariant } from '../ui';
import type { RunResponse, RunStatus } from '../../api/submissions';
import type { RunState } from '../../hooks/useRunCode';
import styles from './RunPanel.module.css';

interface RunPanelProps {
  state: RunState;
  input: string;
  onInputChange: (value: string) => void;
  /** Ctrl+Enter inside the input box. */
  onRun: () => void;
  disabled: boolean;
}

const MIN_HEIGHT = 96;
const MAX_HEIGHT = 640;
const DEFAULT_HEIGHT = 240;
const KEY_STEP = 24;
/** Runs left are only mentioned when the student is getting close to the limit. */
const RUNS_LEFT_WARNING = 20;

const STATUS: Record<RunStatus, { label: string; variant: BadgeVariant }> = {
  accepted: { label: 'Finished', variant: 'success' },
  failed: { label: 'Some tests failed', variant: 'danger' },
  compile_error: { label: 'Compile error', variant: 'danger' },
  runtime_error: { label: 'Runtime error', variant: 'danger' },
  time_limit: { label: 'Time limit exceeded', variant: 'warning' },
  memory_limit: { label: 'Memory limit exceeded', variant: 'warning' },
};

const formatTime = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

/**
 * The area under the editor: an Input box and an Output area. The header toggles it open and closed; the strip above it
 * resizes it (drag, or arrow keys while it has focus). Only the editor's own bottom panel, nothing else on the page.
 */
export function RunPanel({ state, input, onInputChange, onRun, disabled }: RunPanelProps) {
  const [open, setOpen] = useState(true);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);
  const bodyId = useId();
  const inputId = useId();

  const clamp = (value: number) => Math.min(Math.max(value, MIN_HEIGHT), MAX_HEIGHT);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startY: event.clientY, startHeight: height };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setHeight(clamp(drag.current.startHeight + (drag.current.startY - event.clientY)));
  };
  const onDividerKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowUp') setHeight((value) => clamp(value + KEY_STEP));
    else if (event.key === 'ArrowDown') setHeight((value) => clamp(value - KEY_STEP));
    else return;
    event.preventDefault();
  };
  const onInputKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!disabled && state.phase !== 'running') onRun();
    }
  };

  const response = state.phase === 'done' ? state.response : null;
  const badge = response ? STATUS[response.status] : null;
  const runsLeft = response?.runsLeft ?? null;

  return (
    <section className={styles.panel} aria-label="Run your code">
      {open && (
        <div
          className={styles.divider}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the run panel"
          aria-valuemin={MIN_HEIGHT}
          aria-valuemax={MAX_HEIGHT}
          aria-valuenow={height}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }}
          onKeyDown={onDividerKey}
        />
      )}

      <div className={styles.header}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
        >
          <span className={styles.chevron} aria-hidden="true">{open ? '▾' : '▸'}</span>
          Input and output
        </button>
        <div className={styles.summary}>
          {state.phase === 'running' && <span className={styles.meta}>Running…</span>}
          {badge && <Badge variant={badge.variant}>{badge.label}</Badge>}
          {response?.mode === 'sample' && response.status !== 'compile_error' && (
            <span className={styles.meta}>{response.passed} of {response.total} sample tests passed</span>
          )}
          {response && response.status !== 'compile_error' && <span className={styles.meta}>{formatTime(response.timeMs)}</span>}
          {runsLeft !== null && runsLeft <= RUNS_LEFT_WARNING && (
            <span className={runsLeft <= 5 ? styles.metaWarn : styles.meta}>
              {runsLeft === 0 ? 'No runs left for this problem' : `${runsLeft} ${runsLeft === 1 ? 'run' : 'runs'} left for this problem`}
            </span>
          )}
        </div>
      </div>

      {open && (
        <div id={bodyId} className={styles.body} style={{ '--run-panel-height': `${height}px` } as CSSProperties}>
          <div className={styles.inputColumn}>
            <label htmlFor={inputId} className={styles.label}>Input</label>
            <textarea
              id={inputId}
              className={styles.input}
              value={input}
              onChange={(event) => onInputChange(event.target.value)}
              onKeyDown={onInputKey}
              spellCheck={false}
              placeholder="Type the input your program reads. Press Ctrl+Enter to run."
              aria-describedby={`${inputId}-hint`}
            />
            <p id={`${inputId}-hint`} className={styles.hint}>Used by Run. Sample tests use their own input.</p>
          </div>

          <div className={styles.outputColumn}>
            <p className={styles.label} id={`${bodyId}-output-label`}>Output</p>
            <div className={styles.output} role="region" aria-labelledby={`${bodyId}-output-label`} aria-live="polite" tabIndex={0}>
              <Output state={state} />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Block({ label, text, tone }: { label: string; text: string; tone?: 'error' }) {
  return (
    <div className={styles.block}>
      <p className={styles.blockLabel}>{label}</p>
      <pre className={tone === 'error' ? `${styles.pre} ${styles.preError}` : styles.pre}>{text}</pre>
    </div>
  );
}

function Output({ state }: { state: RunState }) {
  if (state.phase === 'idle') {
    return <p className={styles.empty}>Run your code to see its output here. Nothing is submitted or graded.</p>;
  }
  if (state.phase === 'running') {
    return <p className={styles.empty}>{state.mode === 'sample' ? 'Running your code on the sample tests…' : 'Running your code…'}</p>;
  }
  if (state.phase === 'error') {
    return <Alert variant="danger" title="Could not run your code">{state.message}</Alert>;
  }
  return <Result response={state.response} />;
}

function Result({ response }: { response: RunResponse }) {
  if (response.status === 'compile_error') {
    return <Block label="Compiler output" text={response.compileOutput || 'The code did not compile.'} tone="error" />;
  }

  if (response.mode === 'sample') {
    return (
      <ol className={styles.tests}>
        {response.results.map((test) => (
          <li key={test.index} className={styles.test}>
            <div className={styles.testHead}>
              <span className={styles.testTitle}>Sample test {test.index}</span>
              <Badge variant={test.passed ? 'success' : 'danger'}>{test.passed ? 'Passed' : 'Failed'}</Badge>
              {!test.passed && test.status in STATUS && test.status !== 'accepted' && (
                <span className={styles.meta}>{STATUS[test.status as RunStatus].label}</span>
              )}
            </div>
            <Block label="Input" text={test.input} />
            <Block label="Expected output" text={test.expectedOutput} />
            <Block label="Your output" text={test.actualOutput || '(no output)'} />
            {test.stderr && <Block label="Error output" text={test.stderr} tone="error" />}
          </li>
        ))}
      </ol>
    );
  }

  return (
    <>
      <Block label="Output" text={response.stdout || '(no output)'} />
      {response.stderr && <Block label="Error output" text={response.stderr} tone="error" />}
    </>
  );
}
