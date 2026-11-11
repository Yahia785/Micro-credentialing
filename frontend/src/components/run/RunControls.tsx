import { Button } from '../ui';
import styles from './RunPanel.module.css';

interface RunControlsProps {
  onRun: () => void;
  onRunSamples: () => void;
  running: boolean;
  disabled: boolean;
  /** Why the buttons are disabled, shown as the tooltip; empty when they are enabled. */
  disabledReason?: string;
}

/** "Run" and "Run sample tests" for the editor's top bar. */
export function RunControls({ onRun, onRunSamples, running, disabled, disabledReason }: RunControlsProps) {
  const off = disabled || running;
  return (
    <div className={styles.controls}>
      <Button
        size="sm"
        variant="secondary"
        onClick={onRun}
        disabled={off}
        loading={running}
        aria-keyshortcuts="Control+Enter Meta+Enter"
        title={disabled ? disabledReason : 'Run your code on the input below (Ctrl+Enter)'}
      >
        {running ? 'Running…' : 'Run'}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onClick={onRunSamples}
        disabled={off}
        title={disabled ? disabledReason : 'Run your code on the sample test cases from the description'}
      >
        Run sample tests
      </Button>
    </div>
  );
}
