import type { ReactNode } from 'react';
import type { AdminAnswer, AdminFollowUp, AdminMainQuestion, AgentCheck, RubricItem } from '../../types/interview';
import { formatTime, highlightQuotes } from '../../utils/interview';
import { Badge, Card } from '../ui';
import styles from './QuestionReviewCard.module.css';

/** Rubric items are written with Markdown ticks for the agent; the instructor sees plain text. */
const plain = (text: string) => text.replace(/`/g, '');

const NOT_SHOWN = 'not shown';

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className={styles.detailLabel}>{label}</dt>
      <dd className={styles.detailValue}>{children}</dd>
    </>
  );
}

/** Everything the agent recorded about one decision, collapsed by default. */
function TechnicalDetails({ answer }: { answer: AdminAnswer }) {
  const check = answer.check;
  const timing = answer.clientTiming;
  if (!check && !timing) return null;

  return (
    <details className={styles.details}>
      <summary className={styles.summary}>Technical details</summary>
      <dl className={styles.detailList}>
        {timing && (
          <Detail label="Typing">
            {timing.firstKeystrokeMs === null || timing.firstKeystrokeMs === undefined
              ? 'No keystroke recorded'
              : `First keystroke after ${(timing.firstKeystrokeMs / 1000).toFixed(1)} s`}
            {`; ${timing.pasteCount ?? 0} pastes; ${timing.focusLossCount ?? 0} times the window lost focus`}
          </Detail>
        )}
        {check && (
          <>
            {check.reason && <Detail label="Decision">{check.reason}</Detail>}
            {check.modelReason && <Detail label="Model said">{check.modelReason}</Detail>}
            {check.missing && <Detail label="Missing items">{check.missing.length ? check.missing.join(', ') : 'None'}</Detail>}
            {check.target && <Detail label="Target">{check.target}</Detail>}
            {check.fallback && <Detail label="Fallback">{check.fallback}</Detail>}
            {check.guard && (
              <Detail label="Two-question guard">
                Fired{check.guard.fixedByRetry ? ' and fixed by a rewrite' : '; kept the first question only'}
                {check.guard.original ? `. Original: ${check.guard.original}` : ''}
              </Detail>
            )}
            {check.repairs.length > 0 && (
              <Detail label="Repairs">
                <ul className={styles.plainList}>
                  {check.repairs.map((repair, index) => (
                    <li key={index}>
                      {repair.type}
                      {repair.fixed === undefined ? '' : repair.fixed ? ' (fixed)' : ' (not fixed)'}
                      {repair.original ? `. Original: ${repair.original}` : ''}
                    </li>
                  ))}
                </ul>
              </Detail>
            )}
            {check.rejected && (
              <Detail label="Rejected reply">
                {check.rejected.code}
                {check.rejected.reply ? `: ${check.rejected.reply}` : ''}
              </Detail>
            )}
            {check.models && <Detail label="Models">{`checker ${check.models.checker}; writer ${check.models.writer}`}</Detail>}
            {check.calls && check.calls.length > 0 && (
              <Detail label="Model calls">
                <table className={styles.calls}>
                  <thead>
                    <tr>
                      <th scope="col">Step</th>
                      <th scope="col">Model</th>
                      <th scope="col">Tokens in / out</th>
                      <th scope="col">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {check.calls.map((call, index) => (
                      <tr key={index}>
                        <td>{call.step}</td>
                        <td>{call.modelId}</td>
                        <td>
                          {call.inputTokens} / {call.outputTokens}
                        </td>
                        <td>{call.latencyMs} ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Detail>
            )}
          </>
        )}
      </dl>
    </details>
  );
}

function checkNote(check: AgentCheck): string {
  if (check.engineDecision) {
    return 'The agent did not check this answer. No follow-up was left for this question, so the interview moved on.';
  }
  if (check.fallback === 'model_unavailable') {
    return 'The agent could not check this answer because the model was unavailable. The interview moved on.';
  }
  if (check.fallback) {
    return 'The agent could not check this answer because its reply was not usable. The interview moved on.';
  }
  return 'This interview used a prompt version that does not record a rubric check for each answer.';
}

/** The agent's check of one answer: each rubric item marked Shown with the student's own words, or Not shown. */
function AgentCheckView({ check }: { check: AgentCheck | null }) {
  if (!check) {
    return <p className={styles.note}>No agent check was recorded for this answer.</p>;
  }
  const checked = check.items.some((item) => item.shown !== null);
  if (!checked) {
    return <p className={styles.note}>{checkNote(check)}</p>;
  }

  return (
    <div className={styles.check}>
      <h5 className={styles.checkTitle}>Agent&apos;s check</h5>
      <ul className={styles.items}>
        {check.items.map((item) => {
          const shown = item.shown === true;
          const quote = shown && item.evidence && item.evidence !== NOT_SHOWN ? item.evidence : null;
          return (
            <li key={item.id} className={styles.item}>
              <div className={styles.itemHead}>
                <Badge variant={shown ? 'success' : 'warning'}>{shown ? 'Shown' : 'Not shown'}</Badge>
                <span className={styles.itemText}>
                  <span className={styles.itemId}>{item.id}</span> {plain(item.text)}
                </span>
              </div>
              {quote && (
                <blockquote className={styles.quote}>
                  <mark className={styles.mark}>{quote}</mark>
                </blockquote>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AnswerReview({ answer, label }: { answer: AdminAnswer; label: string }) {
  const quotes = (answer.check?.items ?? [])
    .filter((item) => item.shown === true && item.evidence && item.evidence !== NOT_SHOWN)
    .map((item) => item.evidence as string);
  const segments = highlightQuotes(answer.text, quotes);
  const pastes = answer.clientTiming?.pasteCount ?? 0;
  const focusLosses = answer.clientTiming?.focusLossCount ?? 0;

  return (
    <div className={styles.answer}>
      <div className={styles.blockHeader}>
        <h4 className={styles.blockTitle}>{label}</h4>
        <time className={styles.time} dateTime={answer.answeredAt}>
          {formatTime(answer.answeredAt)}
        </time>
        {pastes > 0 && <Badge variant="neutral">{`Pasted ${plural(pastes, 'time', 'times')}`}</Badge>}
        {focusLosses > 0 && <Badge variant="neutral">{`Left the window ${plural(focusLosses, 'time', 'times')}`}</Badge>}
      </div>
      <p className={styles.answerText}>
        {segments.map((segment, index) =>
          segment.highlighted ? (
            <mark key={index} className={styles.mark}>
              {segment.text}
            </mark>
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
      </p>
      <AgentCheckView check={answer.check} />
      <TechnicalDetails answer={answer} />
    </div>
  );
}

function FollowUpReview({ followUp, rubric }: { followUp: AdminFollowUp; rubric: RubricItem[] }) {
  const target = followUp.target ? rubric.find((item) => item.id === followUp.target) : undefined;
  return (
    <div className={styles.followUp}>
      <div className={styles.blockHeader}>
        <h4 className={styles.blockTitle}>Follow-up question</h4>
        <time className={styles.time} dateTime={followUp.askedAt}>
          {formatTime(followUp.askedAt)}
        </time>
        {followUp.isHint && <Badge variant="info">Hint</Badge>}
      </div>
      <p className={styles.followUpText}>{followUp.question}</p>
      {followUp.target && (
        <p className={styles.target}>
          Asked about item {followUp.target}
          {target ? `: ${plain(target.text)}` : ''}
        </p>
      )}
    </div>
  );
}

/** One main question: the question, then each answer with the agent's check and the follow-up that came after it, in time order. */
export function QuestionReviewCard({ question }: { question: AdminMainQuestion }) {
  return (
    <Card
      headingLevel={3}
      title={`Question ${question.index}${question.themeTitle ? `: ${question.themeTitle}` : ''}`}
      actions={<span className={styles.time}>Asked {formatTime(question.askedAt)}</span>}
    >
      <div className={styles.timeline}>
        <p className={styles.question}>{question.question}</p>

        {question.answers.length === 0 && <p className={styles.note}>The student has not answered this question yet.</p>}

        {question.answers.map((answer, index) => (
          <div key={index} className={styles.step}>
            <AnswerReview answer={answer} label={index === 0 ? 'Answer' : 'Follow-up answer'} />
            {question.followUps
              .filter((followUp) => followUp.afterAnswer === index + 1)
              .map((followUp, followIndex) => (
                <FollowUpReview key={followIndex} followUp={followUp} rubric={question.rubric} />
              ))}
          </div>
        ))}
      </div>
    </Card>
  );
}
