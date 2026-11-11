import type { AgentCheck, AdminMainQuestion, CodeStatus, ManipulationFlag } from '../../types/interview';
import { Alert, Badge } from '../ui';
import type { BadgeVariant } from '../ui';
import styles from './ObservedBehavior.module.css';

/**
 * host.v6 parts of the instructor's review: the code status banner, what the student's code printed on the inputs of a question,
 * and the notes on one answer (a flag with the student's quote, a claim the output contradicted). Students never see any of this:
 * the server only sends it to admins.
 */

const FLAG_LABELS: Record<string, string> = {
  instruction: 'Tried to give the agent an instruction',
  answer_request: 'Asked for the answer',
  rubric_request: 'Asked for the rubric or how it is graded',
  authority: 'Claimed an instructor allowed something',
  long_paste: 'Very long text, like a paste',
  model: 'Flagged by the checker',
};

const RUN_STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  accepted: { label: 'Finished', variant: 'success' },
  compile_error: { label: 'Did not compile', variant: 'danger' },
  runtime_error: { label: 'Runtime error', variant: 'danger' },
  time_limit: { label: 'Timed out', variant: 'warning' },
  memory_limit: { label: 'Out of memory', variant: 'warning' },
};

const RUNS_NOTES: Record<string, string> = {
  limit_reached: 'Some runs were skipped because the run limit for this interview was reached. The agent worked without them.',
  runner_failed: 'The code could not be run (the runner was not available). The agent worked without run results.',
  compile_error: 'The code did not compile, so there is no output.',
};

export const flagLabel = (flag: Pick<ManipulationFlag, 'kind'>) => FLAG_LABELS[flag.kind] ?? 'Flagged';

/** A banner above the questions when the code was unfinished at the start of the interview. Nothing for finished code. */
export function CodeStatusBanner({ status }: { status: CodeStatus | null | undefined }) {
  if (!status || !status.unfinished) return null;
  const facts: string[] = [];
  if (status.compiles === false) facts.push('The code does not compile.');
  if (status.stubs.length > 0) {
    facts.push(`${status.stubs.length === 1 ? 'This function has' : 'These functions have'} an empty or placeholder body: ${status.stubs.join(', ')}.`);
  }
  if (typeof status.passed === 'number' && typeof status.total === 'number') {
    facts.push(`${status.passed} of ${status.total} tests passed.`);
  }
  return (
    <Alert variant="warning" title="Unfinished code" className={styles.banner}>
      <ul className={styles.facts}>
        {facts.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
      <p className={styles.explain}>
        The student was told their code is not finished and to answer based on how they intended it to work. Answers that describe the
        intended design count as evidence.
      </p>
    </Alert>
  );
}

/** What the student's code printed on the inputs set for one main question. Nothing is shown for a question without runs. */
export function QuestionRuns({ question }: { question: AdminMainQuestion }) {
  const runs = question.runs ?? [];
  const note = question.runsNote ? RUNS_NOTES[question.runsNote] : null;
  if (runs.length === 0 && !note) return null;

  return (
    <section className={styles.group} aria-label={`Code runs for question ${question.index}`}>
      <h4 className={styles.title}>Code runs: what the student&apos;s code printed</h4>
      <p className={styles.help}>The agent used these outputs when it checked the answers and wrote the follow-up. The student does not see them.</p>
      {runs.map((run, index) => {
        const status = RUN_STATUS[run.status] ?? { label: run.status, variant: 'neutral' as BadgeVariant };
        return (
          <div key={index} className={styles.run}>
            <div className={styles.runHead}>
              <span className={styles.runLabel}>{run.label}</span>
              <Badge variant={status.variant}>{status.label}</Badge>
              <span className={styles.meta}>{`${run.timeMs} ms`}</span>
            </div>
            <div className={styles.io}>
              <div>
                <p className={styles.ioLabel}>Input</p>
                <pre className={styles.pre}>{run.stdin || '(empty)'}</pre>
              </div>
              <div>
                <p className={styles.ioLabel}>Output</p>
                <pre className={styles.pre}>{run.status === 'compile_error' ? '(did not compile)' : run.stdout || '(nothing printed)'}</pre>
              </div>
            </div>
          </div>
        );
      })}
      {note && <p className={styles.note}>{note}</p>}
    </section>
  );
}

/** Notes under one answer: a manipulation flag with the student's quote, and claims the observed output contradicted. */
export function AnswerNotes({ check }: { check: AgentCheck | null }) {
  if (!check) return null;
  const contradictions = check.items.filter((item) => item.contradiction);
  const partials = check.items.filter((item) => item.shown === false && item.partialQuote && !item.contradiction);
  const viaFollowUp = check.items.filter((item) => item.viaFollowUp);
  const contradicted = check.contradicted ?? [];
  if (!check.manipulation && contradictions.length === 0 && partials.length === 0 && viaFollowUp.length === 0 && contradicted.length === 0) return null;

  return (
    <div className={styles.notes}>
      {check.manipulation && (
        <Alert variant="warning" title={`Flagged answer: ${flagLabel(check.manipulation)}`}>
          <p className={styles.explain}>
            The answer counted as no evidence and the agent answered with one fixed sentence. Quote from the student:
          </p>
          <blockquote className={styles.quote}>{check.manipulation.quote}</blockquote>
        </Alert>
      )}
      {viaFollowUp.map((item) => (
        <p key={`via-${item.id}`} className={styles.note}>
          <strong>{`Item ${item.id} shown in follow-up${item.afterHint ? ' (after a hint)' : ''}.`}</strong>
        </p>
      ))}
      {partials.map((item) => (
        <p key={`partial-${item.id}`} className={styles.note}>
          <strong>{`Item ${item.id} not shown: `}</strong>
          {`the student said only part of it ("${item.partialQuote}").`}
        </p>
      ))}
      {contradicted.map((entry) => (
        <p key={`finding-${entry.id}`} className={styles.contradiction}>
          <strong>{`Contradicts finding ${entry.id}: `}</strong>
          {`the student said "${entry.quote}", and the program printed something else.`}
        </p>
      ))}
      {contradictions.map((item) => (
        <p key={item.id} className={styles.contradiction}>
          <strong>{`Item ${item.id} not shown: `}</strong>
          {item.contradiction?.note}
          {item.contradiction?.claim ? ` (student said: "${item.contradiction.claim}")` : ''}
        </p>
      ))}
    </div>
  );
}
