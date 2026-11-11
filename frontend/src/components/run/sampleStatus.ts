import type { RunState } from '../../hooks/useRunCode';

export type SampleTestStatus = 'idle' | 'passed' | 'failed';

/**
 * The result of one sample test (1-based `index`, as the Run response numbers them) from the last Run. A run on custom
 * input, a compile error or no run at all leaves every box at "not run yet".
 */
export function sampleStatusFor(state: RunState, index: number): SampleTestStatus {
  if (state.phase !== 'done' || state.response.mode !== 'sample') return 'idle';
  const result = state.response.results.find((test) => test.index === index);
  if (!result) return 'idle';
  return result.passed ? 'passed' : 'failed';
}
