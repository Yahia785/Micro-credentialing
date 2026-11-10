import type { AdminInterview, ChatInterview, InterviewStatus, StudentInterview } from '../types/interview';

/** Student view -> what the chat shows. */
export function chatFromStudentView(view: StudentInterview): ChatInterview {
  return {
    interviewId: view.interviewId,
    status: view.status,
    deadline: view.deadline,
    serverNow: view.serverNow,
    receivedAt: performance.now(),
    code: view.code ?? null,
    turns: view.turns,
    currentQuestion: view.currentQuestion,
    questionNumber: view.progress.questionNumber,
    questionCount: view.progress.questionCount,
  };
}

/**
 * Instructor view -> what the chat shows. Used for a practice interview, which the admin takes through the same screen as a
 * student. The admin view has no "current question" or progress, so they are worked out from the turns.
 */
export function chatFromAdminView(view: AdminInterview, questionCount: number | null): ChatInterview {
  const turns = view.turns.map(({ role, text, createdAt }) => ({ role, text, createdAt }));
  const last = turns[turns.length - 1];
  return {
    interviewId: view.interviewId,
    status: view.status,
    deadline: view.deadline,
    serverNow: view.serverNow,
    receivedAt: performance.now(),
    code: view.code,
    turns,
    currentQuestion: view.status === 'in_progress' && last?.role === 'host' ? last.text : null,
    questionNumber: view.turns.filter((turn) => turn.role === 'host' && turn.kind === 'main').length,
    questionCount,
  };
}

/** "Question 2 of 5" for the top bar, or null before the first question (or when it is over). */
export function progressLabel(chat: Pick<ChatInterview, 'status' | 'questionNumber' | 'questionCount'> | null): string | null {
  if (!chat || chat.status !== 'in_progress' || chat.questionNumber < 1) return null;
  return `Question ${chat.questionNumber}${chat.questionCount ? ` of ${chat.questionCount}` : ''}`;
}

/** Milliseconds left, following the server's clock: the gap between deadline and serverNow, minus the time since it was received. */
export function remainingMs(chat: Pick<ChatInterview, 'deadline' | 'serverNow' | 'receivedAt'>, now = performance.now()): number {
  const gap = Date.parse(chat.deadline) - Date.parse(chat.serverNow);
  if (Number.isNaN(gap)) return 0;
  return Math.max(0, gap - (now - chat.receivedAt));
}

/** 9:05 style countdown text. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** "12 min 5 s" style duration between two ISO times, or null when either is missing. */
export function formatDuration(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  if (Number.isNaN(ms) || ms < 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} min ${seconds} s` : `${seconds} s`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return 'Not yet';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export const STATUS_LABELS: Record<InterviewStatus, string> = {
  in_progress: 'In progress',
  completed: 'Completed',
  timed_out: 'Time ran out',
  abandoned: 'Abandoned',
};

export const STATUS_VARIANTS: Record<InterviewStatus, 'info' | 'success' | 'warning' | 'neutral'> = {
  in_progress: 'info',
  completed: 'success',
  timed_out: 'warning',
  abandoned: 'neutral',
};

export interface TextSegment {
  text: string;
  highlighted: boolean;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Splits an answer into plain and highlighted parts, highlighting the first place each quote appears (ignoring case and the
 * amount of white space, as the server does when it checks a quote). Quotes that are not found are simply not highlighted.
 */
export function highlightQuotes(text: string, quotes: string[]): TextSegment[] {
  const ranges: Array<[number, number]> = [];
  for (const quote of quotes) {
    const words = quote.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const match = new RegExp(words.map(escapeRegExp).join('\\s+'), 'i').exec(text);
    if (match) ranges.push([match.index, match.index + match[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);

  // Merge overlaps so nothing is highlighted twice.
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([range[0], range[1]]);
  }

  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), highlighted: false });
    segments.push({ text: text.slice(start, end), highlighted: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), highlighted: false });
  return segments.length > 0 ? segments : [{ text, highlighted: false }];
}

/** The review page of a submission's interviews, optionally with one interview selected. */
export function reviewPath(submissionId: string, interviewId?: string) {
  const base = `/admin/reviews/${encodeURIComponent(submissionId)}/interview`;
  return interviewId ? `${base}?interview=${encodeURIComponent(interviewId)}` : base;
}

/** The practice interview screen. */
export function practicePath(submissionId: string, interviewId: string) {
  return `${reviewPath(submissionId)}/practice/${encodeURIComponent(interviewId)}`;
}
