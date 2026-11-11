const RUNS_NOTES: Record<string, string> = {
  limit_reached: 'Some runs were skipped because the run limit for this interview was reached. The agent worked without them.',
  runner_failed: 'The code could not be run (the runner was not available). The agent worked without run results.',
  compile_error: 'The code did not compile, so there is no output.',
};

/** A runs note is a code (limit_reached, runner_failed, compile_error), and for a failure also why: "runner_failed: Error name: message". */
export function describeRunsNote(note: string | null | undefined): string | null {
  if (!note) return null;
  const [code, ...rest] = note.split(': ');
  const text = RUNS_NOTES[code];
  if (!text) return note;
  return rest.length ? `${text} Reason: ${rest.join(': ')}` : text;
}

