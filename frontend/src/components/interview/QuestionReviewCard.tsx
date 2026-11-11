import type { ReactNode } from 'react';
import type { AdminAnswer, AdminFollowUp, AdminMainQuestion, AgentCheck, CodeFinding, RubricItem } from '../../types/interview';
import { classNames } from '../../utils/classNames';
import { formatTime, highlightQuotes, reviewedItems, shortText } from '../../utils/interview';
import type { ReviewedItem } from '../../utils/interview';
import { Badge } from '../ui';
import { Disclosure } from './Disclosure';
import { AnswerNotes, QuestionRuns, flagLabel } from './ObservedBehavior';
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

function AnswerReview({ answer, label }: { answer: AdminAnswer; label: string }) {
  const quotes = (answer.check?.items ?? [])
    .filter((item) => item.shown === true && item.evidence && item.evidence !== NOT_SHOWN)
    .map((item) => item.evidence as string);
  const segments = highlightQuotes(answer.text, quotes);
  const pastes = answer.clientTiming?.pasteCount ?? 0;
  const focusLosses = answer.clientTiming?.focusLossCount ?? 0;
  const unchecked = answer.check !== null && answer.check.items.every((item) => item.shown === null);

  return (
    <Disclosure
      defaultOpen
      headingLevel={5}
      className={styles.answer}
      title={
        <>
          <span className={styles.blockTitle}>{label}</span>
          <time className={styles.time} dateTime={answer.answeredAt}>
            {formatTime(answer.answeredAt)}
          </time>
          {pastes > 0 && <Badge variant="neutral">{`Pasted ${plural(pastes, 'time', 'times')}`}</Badge>}
          {focusLosses > 0 && <Badge variant="neutral">{`Left the window ${plural(focusLosses, 'time', 'times')}`}</Badge>}
          {answer.check?.manipulation && <Badge variant="warning">{`Flagged: ${flagLabel(answer.check.manipulation)}`}</Badge>}
        </>
      }
    >
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
      {answer.check === null && <p className={styles.note}>No agent check was recorded for this answer.</p>}
      {unchecked && answer.check && !answer.check.manipulation && <p className={styles.note}>{checkNote(answer.check)}</p>}
      <AnswerNotes check={answer.check} />
      <TechnicalDetails answer={answer} />
    </Disclosure>
  );
}

function FollowUpReview({ followUp, rubric, findings }: { followUp: AdminFollowUp; rubric: RubricItem[]; findings: CodeFinding[] }) {
  const isFinding = followUp.targetKind === 'finding';
  const target = followUp.target && !isFinding ? rubric.find((item) => item.id === followUp.target) : undefined;
  const finding = followUp.target && isFinding ? findings.find((item) => item.id === followUp.target) : undefined;
  return (
    <Disclosure
      defaultOpen
      headingLevel={5}
      className={styles.followUp}
      title={
        <>
          <span className={styles.blockTitle}>Follow-up question</span>
          <time className={styles.time} dateTime={followUp.askedAt}>
            {formatTime(followUp.askedAt)}
          </time>
          {followUp.isHint && <Badge variant="info">Hint</Badge>}
        </>
      }
    >
      <p className={styles.followUpText}>{followUp.question}</p>
      {followUp.target && (
        <p className={styles.target}>
          {isFinding ? `Asked about finding ${followUp.target}` : `Asked about item ${followUp.target}`}
          {target ? `: ${plain(target.text)}` : ''}
          {finding ? `: ${finding.concept}` : ''}
        </p>
      )}
    </Disclosure>
  );
}

function verdictLabel(value: boolean | null) {
  if (value === null) return 'Not checked';
  return value ? 'Shown' : 'Not shown';
}

function verdictVariant(value: boolean | null): 'success' | 'warning' | 'neutral' {
  if (value === null) return 'neutral';
  return value ? 'success' : 'warning';
}

/**
 * One rubric item: the agent's check, and the instructor's decision as a separate control. The quote is behind the row's own
 * disclosure. A decision that differs from the agent's is marked "Changed by instructor".
 */
function RubricItemRow({
  questionIndex,
  item,
  disabled,
  onDecide,
}: {
  questionIndex: number;
  item: ReviewedItem;
  disabled: boolean;
  onDecide: (value: boolean | null) => void;
}) {
  // Choosing the value the agent already found removes the decision, so nothing is stored that changes nothing.
  const choose = (value: boolean) => onDecide(value === item.agentShown ? null : value);
  const labelId = `decision-q${questionIndex}-${item.id}`;

  return (
    <Disclosure
      headingLevel={5}
      tone={item.isChanged ? 'changed' : 'default'}
      title={
        <>
          <span className={styles.itemId}>{item.id}</span>
          <span className={styles.itemText}>{plain(item.text)}</span>
        </>
      }
      aside={
        <>
          <span className={styles.verdict}>
            <span className={styles.verdictLabel}>Agent&apos;s check</span>
            <Badge variant={verdictVariant(item.agentShown)}>{verdictLabel(item.agentShown)}</Badge>
          </span>
          <span className={styles.verdict}>
            <span className={styles.verdictLabel} id={labelId}>
              Instructor&apos;s decision
            </span>
            <span className={styles.segmented} role="group" aria-labelledby={labelId}>
              <button
                type="button"
                disabled={disabled}
                aria-pressed={item.current === true}
                className={classNames(styles.segment, item.current === true && styles.segmentShown)}
                onClick={() => choose(true)}
              >
                Shown
              </button>
              <button
                type="button"
                disabled={disabled}
                aria-pressed={item.current === false}
                className={classNames(styles.segment, item.current === false && styles.segmentNotShown)}
                onClick={() => choose(false)}
              >
                Not shown
              </button>
            </span>
          </span>
          {item.isChanged && <Badge variant="changed">Changed by instructor</Badge>}
        </>
      }
    >
      {item.agentShown === true && item.evidence ? (
        <blockquote className={styles.quote}>
          <mark className={styles.mark}>{item.evidence}</mark>
        </blockquote>
      ) : (
        <p className={styles.note}>
          {item.agentShown === false
            ? 'The agent found no words in the student’s answers that show this item.'
            : item.agentShown === null
              ? 'The agent made no check of this item.'
              : 'The agent found this item shown, but kept no quote.'}
        </p>
      )}
    </Disclosure>
  );
}

interface QuestionReviewCardProps {
  question: AdminMainQuestion;
  /** The instructor's draft decisions for this question (item id -> shown). */
  draft: Record<string, boolean> | undefined;
  disabled?: boolean;
  onDecide: (questionIndex: number, itemId: string, value: boolean | null) => void;
  /** host.v7: the findings of the code analysis, so a follow-up aimed at one can say which. */
  findings?: CodeFinding[];
}

/** One main question as a collapsible section: a header for the overview, the question, its rubric, and the conversation. */
export function QuestionReviewCard({ question, draft, disabled = false, onDecide, findings = [] }: QuestionReviewCardProps) {
  const items = reviewedItems(question, draft);
  const total = items.length;
  const shownCount = items.filter((item) => item.current === true).length;
  const unchecked = items.length > 0 && items.every((item) => item.current === null);
  const changedCount = items.filter((item) => item.isChanged).length;
  const hinted = question.followUps.some((followUp) => followUp.isHint);
  const plainFollowUps = question.followUps.some((followUp) => !followUp.isHint);

  return (
    <Disclosure
      variant="section"
      headingLevel={3}
      tone={changedCount > 0 ? 'changed' : 'default'}
      title={
        <>
          <span className={styles.qNumber}>{`Q${question.index}`}</span>
          <span className={styles.qShort}>{shortText(question.question)}</span>
          {unchecked ? (
            <Badge variant="neutral">Not checked</Badge>
          ) : (
            total > 0 && <Badge variant={shownCount === total ? 'success' : 'warning'}>{`${shownCount} of ${total} shown`}</Badge>
          )}
          {plainFollowUps && <Badge variant="info">Follow-up</Badge>}
          {hinted && <Badge variant="info">Hint</Badge>}
          {changedCount > 0 && <Badge variant="changed">{`${changedCount} changed`}</Badge>}
        </>
      }
    >
      <div className={styles.timeline}>
        <Disclosure defaultOpen headingLevel={4} title={<span className={styles.sectionTitle}>Question</span>}>
          <p className={styles.question}>{question.question}</p>
          <p className={styles.time}>
            {question.themeTitle ? `${question.themeTitle}. ` : ''}Asked {formatTime(question.askedAt)}
          </p>
        </Disclosure>

        <QuestionRuns question={question} />

        {items.length > 0 && (
          <section className={styles.group} aria-label={`Rubric for question ${question.index}`}>
            <h4 className={styles.groupTitle}>Rubric: agent&apos;s check and instructor&apos;s decision</h4>
            <div className={styles.groupList}>
              {items.map((item) => (
                <RubricItemRow
                  key={item.id}
                  questionIndex={question.index}
                  item={item}
                  disabled={disabled}
                  onDecide={(value) => onDecide(question.index, item.id, value)}
                />
              ))}
            </div>
          </section>
        )}

        <section className={styles.group} aria-label={`Conversation for question ${question.index}`}>
          <h4 className={styles.groupTitle}>Conversation</h4>
          <div className={styles.groupList}>
            {question.answers.length === 0 && <p className={styles.note}>The student has not answered this question yet.</p>}
            {question.answers.map((answer, index) => (
              <div key={index} className={styles.step}>
                <AnswerReview answer={answer} label={index === 0 ? 'Answer' : 'Follow-up answer'} />
                {question.followUps
                  .filter((followUp) => followUp.afterAnswer === index + 1)
                  .map((followUp, followIndex) => (
                    <FollowUpReview key={followIndex} followUp={followUp} rubric={question.rubric} findings={findings} />
                  ))}
              </div>
            ))}
          </div>
        </section>
      </div>
    </Disclosure>
  );
}
