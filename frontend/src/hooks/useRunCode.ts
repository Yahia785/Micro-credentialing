import { useCallback, useEffect, useRef, useState } from 'react';
import { runCode } from '../api/submissions';
import type { RunResponse } from '../api/submissions';

export type RunState =
  | { phase: 'idle' }
  | { phase: 'running'; mode: 'custom' | 'sample' }
  | { phase: 'done'; response: RunResponse }
  | { phase: 'error'; message: string };

interface Options {
  milestoneId: string;
  /** Returns the editor's current code at the moment of the run. */
  getCode: () => string;
  /** False after the submission, in view mode, or for problems that cannot be run. */
  enabled: boolean;
}

/**
 * State and actions of the Run button. Kept out of the editor component so that running code never touches the editor's own
 * state (recording, submitting, leave guard). Runs are one at a time; a result that arrives after the editor was left is dropped.
 */
export function useRunCode({ milestoneId, getCode, enabled }: Options) {
  const [state, setState] = useState<RunState>({ phase: 'idle' });
  const [input, setInput] = useState('');
  const latest = useRef({ milestoneId, getCode, enabled, input });
  latest.current = { milestoneId, getCode, enabled, input };
  const busy = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A different problem starts with a clean panel.
  useEffect(() => {
    setState({ phase: 'idle' });
    setInput('');
  }, [milestoneId]);

  const start = useCallback(async (sample: boolean) => {
    const current = latest.current;
    if (!current.enabled || busy.current) return;
    busy.current = true;
    setState({ phase: 'running', mode: sample ? 'sample' : 'custom' });
    try {
      const response = await runCode({
        milestoneId: current.milestoneId,
        code: current.getCode(),
        ...(sample ? { sample: true } : { input: current.input }),
      });
      if (mounted.current) setState({ phase: 'done', response });
    } catch (error) {
      if (mounted.current) {
        setState({ phase: 'error', message: error instanceof Error ? error.message : 'The run failed. Please try again.' });
      }
    } finally {
      busy.current = false;
    }
  }, []);

  const run = useCallback(() => start(false), [start]);
  const runSamples = useCallback(() => start(true), [start]);

  return { state, input, setInput, run, runSamples, running: state.phase === 'running' };
}
