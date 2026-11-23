import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { getAdminInterview } from '../api/interviews';
import { CodePanel } from '../components/interview/CodePanel';
import { Alert, Badge, Button, Card, PageHeader, Spinner } from '../components/ui';
import type { BadgeVariant } from '../components/ui';
import type { A2Question, A2Result, A2Step, AdminInterview } from '../types/interview';
import { STATUS_LABELS, STATUS_VARIANTS, formatDateTime } from '../utils/interview';
import styles from './ImportedInterviewReviewPage.module.css';

/** What each case means, in words (the server sends the same text as caseMeaning). */
const CASE_MEANING: Record<number, string> = {
  1: 'right idea, right code',
  2: 'right idea, buggy code',
  3: 'wrong idea, right code',
  4: 'wrong idea, buggy code',
};

const RESULT_VARIANT: Record<A2Result, BadgeVariant> = { right: 'success', partly: 'warning', wrong: 'danger', unclear: 'neutral' };

const STEP_NAMES: Record<string, string> = {
  logic: 'Main question (logic)',
  compileError: 'Compile error',
  compileErrorOutside: 'Compile error',
  predict: 'Predict their code',
  tracing: 'Trace their code',
  whatIf: 'What-if on their code',
  debug: 'Why does it give that?',
  change: 'Which line would you change?',
  smallLogic: 'Smaller logic question',
  smallStep: 'Smaller code step',
};

const KIND_TEXT: Record<A2Step['kind'], string> = { logic: 'logic answer', code: 'code answer', compile: 'compile answer' };
const SOURCE_TEXT: Record<string, string> = {
  spec: 'the spec',
  code: 'what their code does',
  'code (plan)': 'what their code does (from the plan: the run could not be made)',
  model: 'judged by the checker model',
  compiler: 'the compiler message',
};

const text = (value: string | number | boolean | null | undefined) => (value === null || value === undefined || value === '' ? '–' : String(value));

/** "Case 2: right idea, buggy code", or what a function without follow-ups is. */
function caseTitle(question: A2Question): string {
  if (question.case !== null) return `Case ${question.case}: ${question.caseMeaning ?? CASE_MEANING[question.case]}`;
  if (question.kind === 'compileError' || question.kind === 'compileErrorOutside') return 'Compile error: their code does not compile';
  if (!question.hasFollowUps) return 'No code to ask about: logic question only';
  return 'Not decided yet';
}

function stepTitle(step: A2Step, question: A2Question): string {
  if (step.step === 'clarify') return 'Clarify (not a follow-up)';
  if (step.step === 'main') return STEP_NAMES[question.kind] ?? 'Main question';
  return `Follow-up ${step.step === 'followUp1' ? 1 : 2}: ${STEP_NAMES[step.type] ?? step.type}`;
}

function ResultCell({ step }: { step: A2Step }) {
  if (step.skipped) return <span className={styles.muted}>Skipped: {step.skipped}</span>;
  if (step.result === null) return <>–</>;
  return (
    <>
      <Badge variant={RESULT_VARIANT[step.result]}>{step.result}</Badge>{' '}
      <span className={styles.muted}>{step.method === 'model' ? 'judged by the model' : 'compared'}</span>
      {step.quote && <div className={styles.quote}>“{step.quote}”</div>}
      {step.note && <div className={styles.muted}>{step.note}</div>}
    </>
  );
}

/** The path of one function: every question that was asked, in order. */
function PathTable({ question }: { question: A2Question }) {
  return (
    <table className={styles.table}>
      <caption className={styles.caption}>Path of {question.function}</caption>
      <thead>
        <tr>
          <th scope="col">Question</th>
          <th scope="col">Kind</th>
          <th scope="col">Expected answer</th>
          <th scope="col">Student answer</th>
          <th scope="col">Result</th>
        </tr>
      </thead>
      <tbody>
        {question.path.map((step, index) => (
          <tr key={index}>
            <th scope="row">
              {stepTitle(step, question)}
              {step.text && <div className={styles.asked}>{step.skipped ? '' : step.text}</div>}
              {step.variable && (
                <div className={styles.muted}>
                  Asked about {step.variable} ({step.expression}) at stop {step.stop}
                  {step.writtenByAgent ? ', written by the agent' : ''}
                </div>
              )}
            </th>
            <td>{KIND_TEXT[step.kind]}</td>
            <td>
              {text(step.expected)}
              {step.expectedSource && <div className={styles.muted}>{SOURCE_TEXT[step.expectedSource] ?? step.expectedSource}</div>}
              {step.mismatch && (
                <div className={styles.flag}>
                  {step.mismatch.kind === 'runtime_unavailable' ? 'The run could not be made: the plan’s answer was used.' : 'The run differs from the plan’s answer.'}
                </div>
              )}
            </td>
            <td>{text(step.studentAnswer)}</td>
            <td>
              <ResultCell step={step} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One row per function: the case and the final label. */
function SummaryTable({ questions }: { questions: A2Question[] }) {
  return (
    <table className={styles.table}>
      <caption className={styles.caption}>Summary: one row per function</caption>
      <thead>
        <tr>
          <th scope="col">Function</th>
          <th scope="col">Their code</th>
          <th scope="col">Case</th>
          <th scope="col">Label</th>
        </tr>
      </thead>
      <tbody>
        {questions.map((question) => (
          <tr key={question.index}>
            <th scope="row">
              {question.function}
              {question.replaces ? <span className={styles.muted}> (replaces {question.replaces})</span> : null}
            </th>
            <td>{question.codeRight === true ? 'right' : question.codeRight === false ? 'wrong' : question.hasFollowUps ? 'unknown' : '–'}</td>
            <td>{caseTitle(question)}</td>
            <td>
              <strong>{question.label ?? 'not finished'}</strong>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The instructor's view of one interview-only interview: the case and the path of each function, and its final label. */
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

  const questions = interview?.a2?.questions ?? [];

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
                  {interview.isPractice && (
                    <>
                      {' '}
                      <Badge variant="warning">Practice</Badge>
                    </>
                  )}
                </dd>
              </div>
              <div>
                <dt>Rotation</dt>
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
            {questions.length > 0 && <SummaryTable questions={questions} />}
          </Card>

          {questions.map((question) => (
            <Card key={question.index} headingLevel={2} title={`${question.function}: ${caseTitle(question)}`}>
              {question.caseNote && <p className={styles.muted}>{question.caseNote}</p>}
              {question.path.length > 0 ? <PathTable question={question} /> : <p className={styles.muted}>Not reached.</p>}
              <p className={styles.label}>
                Final label: <strong>{question.label ?? 'not finished'}</strong>
              </p>
            </Card>
          ))}
          {!interview.a2 && <Alert variant="info">This interview has no per-function log.</Alert>}

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
