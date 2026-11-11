import type { AdminInterview, CodeAnalysis, CodeFinding } from '../../types/interview';
import { formatDateTime } from '../../utils/interview';
import { Alert, Badge } from '../ui';
import type { BadgeVariant } from '../ui';
import { describeRunsNote } from '../../utils/runsNote';
import styles from './CodeAnalysisPanel.module.css';

/**
 * Instructor-only parts of host.v7 and of an interview the student left: the Code analysis panel (what the analysis found in the code,
 * the runs the agent chose with its reasons) and the "Abandoned" banner. Students never see any of this: the server only sends it to admins.
 */

const KIND: Record<CodeFinding['kind'], { label: string; variant: BadgeVariant }> = {
  bug: { label: 'Bug', variant: 'danger' },
  risk: { label: 'Risk', variant: 'warning' },
  strength: { label: 'Strength', variant: 'success' },
  unfinished: { label: 'Unfinished', variant: 'warning' },
};

const STATUS_NOTES: Record<string, string> = {
  partial: 'The analysis could only be done in part (a model call failed or its reply was not usable). The interview went on with what was found.',
  failed: 'The analysis could not be done. The interview went on without it.',
  skipped: 'The student opened the interview before the analysis was ready, so it was not used.',
};

/** A banner when the student left the page: when, and that their answers until then are kept. */
export function AbandonedBanner({ interview }: { interview: Pick<AdminInterview, 'status' | 'abandoned'> }) {
  if (interview.status !== 'abandoned') return null;
  return (
    <Alert variant="warning" title="Abandoned (left the page)">
      <p className={styles.concept}>
        {`The student left the page${interview.abandoned?.at ? ` at ${formatDateTime(interview.abandoned.at)}` : ''}, so the interview ended there and cannot be retaken. The answers they gave before leaving are below.`}
      </p>
    </Alert>
  );
}

function Io({ stdin, output }: { stdin: string; output: string }) {
  return (
    <div className={styles.io}>
      <div>
        <p className={styles.ioLabel}>Input</p>
        <pre className={styles.pre}>{stdin || '(empty)'}</pre>
      </div>
      <div>
        <p className={styles.ioLabel}>Output</p>
        <pre className={styles.pre}>{output || '(nothing printed)'}</pre>
      </div>
    </div>
  );
}

/** The findings of the code analysis, the runs the agent chose (marked as such, with its reason) and what the step cost. */
export function CodeAnalysisPanel({ analysis }: { analysis: CodeAnalysis | null | undefined }) {
  if (!analysis) return null;
  const note = STATUS_NOTES[analysis.status];
  const calls = analysis.calls ?? [];
  const tokens = calls.reduce((total, call) => total + call.inputTokens + call.outputTokens, 0);
  return (
    <section className={styles.panel} aria-labelledby="code-analysis-title">
      <h2 id="code-analysis-title" className={styles.concept}>
        Code analysis
      </h2>
      <p className={styles.help}>
        Before the interview the agent read the student’s code, chose inputs to run it on, and listed what it found. It used the findings
        to choose follow-up questions. The student does not see any of this.
      </p>
      {note && <Alert variant="info">{note}</Alert>}

      <h3 className={styles.help}>Findings</h3>
      {analysis.findings.length === 0 ? (
        <p className={styles.note}>The analysis found nothing to report.</p>
      ) : (
        <ul className={styles.list}>
          {analysis.findings.map((finding) => (
            <li key={finding.id} className={styles.finding}>
              <div className={styles.head}>
                <span className={styles.id}>{finding.id}</span>
                <Badge variant={KIND[finding.kind].variant}>{KIND[finding.kind].label}</Badge>
                {finding.lines && <span className={styles.meta}>{`Lines ${finding.lines}`}</span>}
                {finding.relatedQuestion && <span className={styles.meta}>{`About question ${finding.relatedQuestion}`}</span>}
              </div>
              <p className={styles.concept}>{finding.concept}</p>
              {finding.evidence && <Io stdin={finding.evidence.stdin} output={finding.evidence.output} />}
            </li>
          ))}
        </ul>
      )}

      <h3 className={styles.help}>Runs chosen by the agent</h3>
      {analysis.runs.length === 0 ? (
        <p className={styles.note}>{describeRunsNote(analysis.runsNote) ?? 'The agent chose no extra runs.'}</p>
      ) : (
        <ul className={styles.list}>
          {analysis.runs.map((run) => (
            <li key={run.label} className={styles.run}>
              <div className={styles.head}>
                <Badge variant="info">Chosen by the agent</Badge>
                <span className={styles.meta}>{run.reason || 'No reason given'}</span>
              </div>
              <Io stdin={run.stdin} output={run.status === 'compile_error' ? '(did not compile)' : run.stdout} />
            </li>
          ))}
        </ul>
      )}
      {analysis.runs.length > 0 && analysis.runsNote && <p className={styles.note}>{describeRunsNote(analysis.runsNote)}</p>}

      {calls.length > 0 && (
        <p className={styles.note}>{`The analysis used ${calls.length} model calls, ${tokens.toLocaleString()} tokens and ${((analysis.latencyMs ?? 0) / 1000).toFixed(1)} s of model time.`}</p>
      )}
    </section>
  );
}
