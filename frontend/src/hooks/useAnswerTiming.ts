import { useCallback, useEffect, useRef } from 'react';
import type { ClientTiming } from '../types/interview';

/**
 * Collects the client-side timing the instructor sees next to an answer: how long until the first keystroke, how many times
 * text was pasted, and how many times the window lost focus. It starts over whenever `questionKey` changes (a new question)
 * and only counts while `active`.
 */
export function useAnswerTiming(questionKey: string, active: boolean) {
  const shownAt = useRef(performance.now());
  const firstKeystroke = useRef<number | null>(null);
  const pasteCount = useRef(0);
  const focusLossCount = useRef(0);

  useEffect(() => {
    shownAt.current = performance.now();
    firstKeystroke.current = null;
    pasteCount.current = 0;
    focusLossCount.current = 0;
  }, [questionKey]);

  useEffect(() => {
    if (!active) return undefined;
    const onBlur = () => {
      focusLossCount.current += 1;
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [active]);

  /** Call on every change of the answer box. */
  const noteInput = useCallback(() => {
    if (firstKeystroke.current === null) firstKeystroke.current = performance.now() - shownAt.current;
  }, []);

  const notePaste = useCallback(() => {
    pasteCount.current += 1;
  }, []);

  const read = useCallback(
    (): ClientTiming => ({
      firstKeystrokeMs: firstKeystroke.current === null ? null : Math.round(firstKeystroke.current),
      pasteCount: pasteCount.current,
      focusLossCount: focusLossCount.current,
    }),
    [],
  );

  return { noteInput, notePaste, read };
}
