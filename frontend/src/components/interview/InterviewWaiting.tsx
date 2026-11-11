import { Alert, Button, Card } from '../ui';
import styles from './InterviewWaiting.module.css';

interface InterviewWaitingProps {
  /** From the interview setup of the problem. */
  minutes: number;
  /** From the interview setup of the problem; the line says "a few" when it is not known. */
  questionCount?: number;
  /** The recording upload has finished (or failed: a failed upload never keeps the interview waiting). */
  uploadDone: boolean;
  /** The interview has been created on the server (the code is classified and the code runs are done). */
  prepared: boolean;
  /** Creating the interview failed: a plain message, and Retry. The submission is saved either way. */
  error: string | null;
  retrying: boolean;
  onRetry: () => void;
}

/**
 * Where the student lands right after submitting a problem that has an interview. No buttons to press: the interview opens by itself
 * when the recordings are uploaded and the interview is ready. The progress bar counts the two steps (it never animates on its own).
 */
export function InterviewWaiting({ minutes, questionCount, uploadDone, prepared, error, retrying, onRetry }: InterviewWaitingProps) {
  const steps = [
    { label: 'Saving your recordings', done: uploadDone },
    { label: 'Preparing your questions', done: prepared },
  ];
  const doneCount = steps.filter((step) => step.done).length;
  const questions = questionCount && questionCount > 0 ? `${questionCount} ${questionCount === 1 ? 'question' : 'questions'}` : 'a few questions';

  return (
    <Card title="Preparing your interview" headingLevel={2} className={styles.card}>
      <Alert variant="info" title="Your submission is saved" className={styles.saved}>
        <p className={styles.text}>You cannot change your code now.</p>
      </Alert>

      <div className={styles.progressBlock}>
        <progress className={styles.progress} max={steps.length} value={doneCount} aria-label="Preparing your interview">
          {`${doneCount} of ${steps.length} steps done`}
        </progress>
        <ul className={styles.steps}>
          {steps.map((step) => (
            <li key={step.label} className={step.done ? styles.stepDone : styles.step}>
              {step.label}
              <span className={styles.stepState}>{step.done ? ' (done)' : ' (in progress)'}</span>
            </li>
          ))}
        </ul>
        <p className={styles.live} role="status">
          {error ? '' : doneCount === steps.length ? 'Opening your interview…' : 'Please wait. This usually takes a few seconds.'}
        </p>
      </div>

      {error && (
        <Alert variant="danger" title="Your interview could not be prepared" className={styles.error}>
          <p className={styles.text}>{error} Your submission is saved.</p>
          <Button size="sm" variant="secondary" onClick={onRetry} loading={retrying}>
            {retrying ? 'Trying again…' : 'Retry'}
          </Button>
        </Alert>
      )}

      <section aria-labelledby="interview-instructions" className={styles.instructions}>
        <h3 id="interview-instructions" className={styles.instructionsTitle}>
          Before the first question
        </h3>
        <ul className={styles.list}>
          <li>{`You will answer ${questions} about your code by typing.`}</li>
          <li>{`You have ${minutes} minutes. The timer pauses while the interviewer is preparing a question.`}</li>
          <li>Answer in your own words. You cannot change your code now.</li>
          <li>Do not leave or refresh this page. Leaving ends the interview.</li>
        </ul>
      </section>
    </Card>
  );
}
