import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { useAnswerTiming } from '../../hooks/useAnswerTiming';
import type { ReloadResult } from '../../hooks/useInterviewController';
import { useTimeUp } from '../../hooks/useTimeUp';
import type { ChatInterview, ClientTiming, StudentTurn } from '../../types/interview';
import { classNames } from '../../utils/classNames';
import { SplitPane } from '../workspace/SplitPane';
import { Alert, Badge, Button, FormField, Spinner, Textarea } from '../ui';
import { CodePanel } from './CodePanel';
import styles from './InterviewChat.module.css';

export const MAX_ANSWER_LENGTH = 2000;
/** The answer box grows with the text up to this share of the chat pane's height, then scrolls inside itself. */
const ANSWER_MAX_SHARE = 0.4;
const NARROW_QUERY = '(max-width: 960px)';

interface InterviewChatProps {
  chat: ChatInterview;
  /** The submitted code, shown read-only next to the chat. */
  code: string | null;
  codeLoading?: boolean;
  codeError?: string | null;
  /** Marks a practice interview taken by an instructor. */
  practice?: boolean;
  sending: boolean;
  sendError: string | null;
  /** A failed refresh of the interview, shown with a retry. */
  loadError: string | null;
  reloading: boolean;
  /** Sends the answer. Resolves true when it was stored (the answer box is then cleared). */
  onSend: (answer: string, timing: ClientTiming) => Promise<boolean>;
  onReload: () => Promise<ReloadResult>;
  /** Shown in place of the answer box once the interview is over. */
  endedPanel: ReactNode;
}

interface TranscriptProps {
  turns: StudentTurn[];
  inProgress: boolean;
  sending: boolean;
  listRef: RefObject<HTMLUListElement | null>;
}

/** The messages. Memoised, so typing in the answer box or the countdown never re-renders them. */
const Transcript = memo(function Transcript({ turns, inProgress, sending, listRef }: TranscriptProps) {
  const lastIndex = turns.length - 1;
  return (
    <ul className={styles.transcript} ref={listRef} role="log" aria-label="Conversation" aria-live="polite">
      {turns.map((turn, index) => {
        const isStudent = turn.role === 'student';
        const isCurrent = inProgress && index === lastIndex && !isStudent;
        return (
          <li
            key={`${turn.createdAt}-${index}`}
            className={classNames(styles.message, isStudent ? styles.student : styles.host, isCurrent && styles.current)}
          >
            <p className={styles.author}>
              {isStudent ? 'You' : 'Interviewer'}
              {isCurrent && <Badge variant="info">Current question</Badge>}
            </p>
            <p className={styles.text}>{turn.text}</p>
          </li>
        );
      })}
      {sending && (
        <li className={styles.thinking}>
          <Spinner size="sm" decorative />
          <span role="status">Thinking…</span>
        </li>
      )}
    </ul>
  );
});

/**
 * The interview itself, filling the workspace: the submitted code on the left (it can be hidden) and the conversation on the
 * right. The messages scroll; the answer box and Send stay pinned at the bottom. The title, "Question N of M" and the countdown
 * live in the workspace's top bar. Only the timer there updates every second.
 */
export function InterviewChat({
  chat,
  code,
  codeLoading,
  codeError,
  practice = false,
  sending,
  sendError,
  loadError,
  reloading,
  onSend,
  onReload,
  endedPanel,
}: InterviewChatProps) {
  const inProgress = chat.status === 'in_progress';
  const timeUp = useTimeUp(chat, sending);

  const [answer, setAnswer] = useState('');
  // On a narrow screen the code would sit above the chat and push it down, so it starts hidden there.
  const [codeVisible, setCodeVisible] = useState(() => !window.matchMedia(NARROW_QUERY).matches);
  const paneRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef<HTMLUListElement>(null);
  const timing = useAnswerTiming(`${chat.interviewId}:${chat.turns.length}`, inProgress && !timeUp);

  const canAnswer = inProgress && !timeUp && !sending && chat.currentQuestion !== null;
  const trimmed = answer.trim();
  const canSend = canAnswer && trimmed.length > 0;

  // At 0:00 the answer box is disabled and the interview is read again until the server reports it has ended.
  const reloadRef = useRef(onReload);
  reloadRef.current = onReload;
  useEffect(() => {
    if (!timeUp) return undefined;
    let cancelled = false;
    let attempts = 0;
    let timer: number | undefined;
    const check = async () => {
      attempts += 1;
      const result = await reloadRef.current();
      if (cancelled || ('chat' in result && result.chat.status !== 'in_progress')) return;
      if (attempts < 6) timer = window.setTimeout(check, 1500);
    };
    timer = window.setTimeout(check, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [timeUp]);

  // Keep the newest message in view, and put the cursor back in the answer box when a new question arrives.
  useEffect(() => {
    const list = transcriptRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [chat.turns.length, sending]);
  useEffect(() => {
    if (canAnswer) textareaRef.current?.focus();
  }, [chat.currentQuestion, canAnswer]);

  /** Grows the answer box with its text: from about 4 lines up to 40% of the chat pane, then it scrolls inside itself. */
  const fitAnswerBox = useCallback(() => {
    const box = textareaRef.current;
    const pane = paneRef.current;
    if (!box || !pane) return;
    box.style.height = 'auto';
    const borders = box.offsetHeight - box.clientHeight;
    const wanted = box.scrollHeight + borders;
    const limit = Math.floor(pane.clientHeight * ANSWER_MAX_SHARE);
    const height = Math.max(Math.min(wanted, limit), Math.min(wanted, box.offsetHeight));
    box.style.height = `${height}px`;
    box.style.overflowY = wanted > height ? 'auto' : 'hidden';
  }, []);

  useLayoutEffect(() => {
    fitAnswerBox();
  }, [answer, inProgress, fitAnswerBox]);

  // The limit is a share of the pane, so it is worked out again when the pane changes size (window, divider, code hidden).
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => fitAnswerBox());
    observer.observe(pane);
    return () => observer.disconnect();
  }, [fitAnswerBox]);

  const submit = async () => {
    if (!canSend) return;
    const stored = await onSend(trimmed, timing.read());
    if (stored) setAnswer('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const codePane = useMemo(
    () => <CodePanel code={code} loading={codeLoading} error={codeError} fill collapsible={false} />,
    [code, codeLoading, codeError],
  );

  const chatPane = (
    <section ref={paneRef} className={styles.chat} aria-label="Interview" aria-busy={sending || undefined}>
      <div className={styles.chatHeader}>
        <h2 className={styles.chatTitle}>Conversation</h2>
        <div className={styles.headerRight}>
          {practice && <Badge variant="warning">Practice</Badge>}
          <Button
            size="sm"
            variant="secondary"
            aria-pressed={codeVisible}
            onClick={() => setCodeVisible((visible) => !visible)}
          >
            {codeVisible ? 'Hide code' : 'Show code'}
          </Button>
        </div>
      </div>

      <Transcript turns={chat.turns} inProgress={inProgress} sending={sending} listRef={transcriptRef} />

      {loadError && (
        <Alert variant="danger" title="Could not load the interview" className={styles.fixed}>
          <p className={styles.alertText}>{loadError}</p>
          <Button size="sm" variant="secondary" loading={reloading} onClick={() => void onReload()}>
            {reloading ? 'Retrying…' : 'Try again'}
          </Button>
        </Alert>
      )}

      {/* Pinned to the bottom: only the messages above scroll. */}
      <div className={styles.footer}>
        {inProgress ? (
          <form
            className={styles.composer}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <FormField
              label="Your answer"
              hint={timeUp ? "Time's up, so answers are closed." : 'Press Enter to send. Press Shift+Enter for a new line.'}
              error={sendError ? `${sendError} Your answer is still in the box. Press Send answer to try again.` : undefined}
            >
              <Textarea
                ref={textareaRef}
                className={styles.answerBox}
                value={answer}
                rows={4}
                maxLength={MAX_ANSWER_LENGTH}
                disabled={!canAnswer}
                onChange={(event) => {
                  timing.noteInput();
                  setAnswer(event.target.value);
                }}
                onPaste={timing.notePaste}
                onKeyDown={onKeyDown}
              />
            </FormField>
            <div className={styles.composerFooter}>
              <span className={styles.count}>
                {answer.length} / {MAX_ANSWER_LENGTH}
              </span>
              <Button type="submit" disabled={!canSend} loading={sending}>
                {sending ? 'Sending…' : 'Send answer'}
              </Button>
            </div>
          </form>
        ) : (
          endedPanel
        )}
      </div>
    </section>
  );

  return (
    <SplitPane
      dividerLabel="Resize the code and interview panels"
      left={codePane}
      right={chatPane}
      hideLeft={!codeVisible}
      minLeft={280}
      minRight={380}
    />
  );
}
