import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { getAdminInterview } from '../api/interviews';
import { CodePanel } from '../components/interview/CodePanel';
import { Alert, Badge, Button, Card, PageHeader, Spinner } from '../components/ui';
import type { A2Check, A2FollowUp, A2Question, AdminInterview } from '../types/interview';
import { STATUS_LABELS, STATUS_VARIANTS, formatDateTime } from '../utils/interview';
import styles from './ImportedInterviewReviewPage.module.css';

const TYPE_LABELS: Record<A2Question['type'], string> = {
  predict: 'Predict the output',
  tracing: 'Tracing',
  compileError: 'Compile error',
  compileErrorOutside: 'Compile error',
  logic: 'Logic walk-through',
};

const VERDICT_VARIANTS = { correct: 'success', wrong: 'danger', unclear: 'warning' } as const;

const text = (value: string | number | boolean | null | undefined) => (value === null || value === undefined || value === '' ? '–' : String(value));

function CheckCell({ check }: { check: A2Check | null | undefined }) {
  if (!check) return <>–</>;
  return (
    <>
      <Badge variant={VERDICT_VARIANTS[check.verdict]}>{check.verdict}</Badge>{' '}
      <span className={styles.muted}>{check.method === 'model' ? 'checked by the model' : 'compared with the code’s answer'}</span>
      {check.quote && <div className={styles.quote}>“{check.quote}”</div>}
      {check.note && <div className={styles.muted}>{check.note}</div>}
    </>
  );
}

function followUpText(followUp: A2FollowUp | null): string {
  if (!followUp) return '–';
  if (followUp.source === null) return `None (${followUp.skipped ?? 'not asked'})`;
  const kind = followUp.source === 'fixed' ? 'Fixed follow-up' : 'Agent follow-up';
  return followUp.text ? `${kind}: ${followUp.text}` : `${kind} (${followUp.skipped ?? 'not asked'})`;
}

/** The logged fields of one main question as a plain table. */
function QuestionTable({ question }: { question: A2Question }) {
  const followUp = question.followUp;
  const rows: Array<[string, React.ReactNode]> = [
    ['Type', TYPE_LABELS[question.type] ?? question.type],
    ['Function', question.function],
    ['Input', text(question.input)],
    ['K (which stop)', text(question.k)],
    ['Breakpoint line', text(question.line)],
    ['Targeted input', question.targeted === null ? '–' : question.targeted ? 'yes' : 'no'],
    ['Trace differs from reference', question.traceDiffersFromReference === null ? '–' : question.traceDiffersFromReference ? 'yes' : 'no'],
    ['Answer from the code', `${text(question.answerFromCode)}${question.answerSource ? ` (${question.answerSource})` : ''}`],
    ['Spec answer', text(question.specAnswer)],
    ['Student answer', text(question.studentAnswer)],
    ['Check', <CheckCell key="check" check={question.check} />],
    ['Follow-up', followUpText(followUp)],
    ['Follow-up answer', text(followUp?.studentAnswer)],
    ['Follow-up check', <CheckCell key="fcheck" check={followUp?.check} />],
    [
      'Mismatch flag',
      question.mismatch
        ? `${question.mismatch.kind === 'runtime_differs_from_plan' ? 'Run differs from the plan' : 'Could not run'}: plan ${text(question.mismatch.planAnswer)}, run ${text(question.mismatch.runtimeAnswer)}${question.runtimeNote ? ` (${question.runtimeNote})` : ''}`
        : 'none',
    ],
  ];
  return (
    <table className={styles.table}>
      <caption className={styles.caption}>Question {question.index}</caption>
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The instructor's view of one interview-only interview: what was logged for each question. The full three-way view comes later. */
export function ImportedInterviewReviewPage() {
  const { interviewId = '' } = useParams();
  const navigate = useNavigate();
  const [interview, setInterview] = useState<AdminInterview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAdminInterview(interviewId)
      .then((data) => {
        if (!cancelled) setInterview(data);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error && failure.message ? failure.message : 'Could not load this interview.');
      });
    return () => {
      cancelled = true;
    };
  }, [interviewId]);

  return (
    <div className={styles.page}>
      <PageHeader
        title="Interview review"
        subtitle="Interview-only assessment"
        actions={
          <Button variant="secondary" onClick={() => navigate('/assessments')}>
            Back to assessments
          </Button>
        }
      />
      {error && <Alert variant="danger">{error}</Alert>}
      {!error && !interview && (
        <p className={styles.muted} role="status">
          <Spinner size="sm" decorative /> Loading…
        </p>
      )}
      {interview && (
        <>
          <Card headingLevel={2} title="Summary">
            <dl className={styles.facts}>
              <div>
                <dt>Status</dt>
                <dd>
                  <Badge variant={STATUS_VARIANTS[interview.status]}>{STATUS_LABELS[interview.status]}</Badge>
                  {interview.isPractice && <> <Badge variant="warning">Practice</Badge></>}
                </dd>
              </div>
              <div>
                <dt>Form</dt>
                <dd>{text(interview.a2?.form ?? interview.form)}</dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd>{formatDateTime(interview.startedAt)}</dd>
              </div>
              <div>
                <dt>Ended</dt>
                <dd>{formatDateTime(interview.endedAt)}</dd>
              </div>
            </dl>
          </Card>

          {(interview.a2?.questions ?? []).map((question) => (
            <Card key={question.index} headingLevel={2} title={`Question ${question.index}: ${question.function}`}>
              <QuestionTable question={question} />
            </Card>
          ))}
          {!interview.a2 && <Alert variant="info">This interview has no per-question log.</Alert>}

          <Card headingLevel={2} title="Conversation">
            <ul className={styles.turns}>
              {interview.turns.map((turn, index) => (
                <li key={index}>
                  <strong>{turn.role === 'host' ? 'Interviewer' : 'Student'}:</strong> {turn.text}
                </li>
              ))}
            </ul>
          </Card>

          <CodePanel title="functions.cpp" code={interview.code} collapsible={false} />
        </>
      )}
    </div>
  );
}
