import { useCallback, useRef, useState } from 'react';
import { InterviewApiError } from '../api/interviews';
import type { ChatInterview, ClientTiming } from '../types/interview';

export type ReloadResult = { chat: ChatInterview } | { error: InterviewApiError };

function toApiError(error: unknown): InterviewApiError {
  return error instanceof InterviewApiError
    ? error
    : new InterviewApiError(0, 'Something went wrong. Please try again.');
}

interface Options {
  /** Loads the interview from the server, in the shape the chat shows. */
  load: () => Promise<ChatInterview>;
  /** Sends one answer. The new state is always read back with `load`. */
  send: (answer: string, timing: ClientTiming) => Promise<unknown>;
}

/**
 * The state behind an interview chat, shared by the student screen and the practice screen: the interview, a load error with a
 * retry, and answer sending with its own error. After every answer the interview is read again from the server, so what is on
 * screen is always what is stored.
 */
export function useInterviewController({ load, send }: Options) {
  const [chat, setChat] = useState<ChatInterview | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const loadRef = useRef(load);
  loadRef.current = load;
  const sendRef = useRef(send);
  sendRef.current = send;
  const chatRef = useRef<ChatInterview | null>(null);
  chatRef.current = chat;

  const reload = useCallback(async (): Promise<ReloadResult> => {
    setLoading(true);
    try {
      const next = await loadRef.current();
      setChat(next);
      setLoadError(null);
      return { chat: next };
    } catch (error) {
      const apiError = toApiError(error);
      setLoadError(apiError.message);
      return { error: apiError };
    } finally {
      setLoading(false);
    }
  }, []);

  /** Returns true when the answer was stored, so the caller can clear the answer box. */
  const sendAnswer = useCallback(
    async (answer: string, timing: ClientTiming): Promise<boolean> => {
      const turnsBefore = chatRef.current?.turns.length ?? 0;
      setSending(true);
      setSendError(null);
      try {
        try {
          await sendRef.current(answer, timing);
        } catch (error) {
          // The answer may have been saved even though the reply was lost: look before asking for a retry.
          const result = await reload();
          if ('chat' in result && result.chat.turns.length > turnsBefore) return true;
          if ('chat' in result && result.chat.status !== 'in_progress') return false;
          setSendError(toApiError(error).message);
          return false;
        }
        await reload();
        return true;
      } finally {
        setSending(false);
      }
    },
    [reload],
  );

  return { chat, setChat, loading, loadError, sending, sendError, reload, sendAnswer };
}
