import { getAuthToken, API_BASE } from './config';
import type {
  AdminInterview,
  AnswerResult,
  ClientTiming,
  InterviewReview,
  InterviewReviewInput,
  InterviewSummary,
  StartInterviewResult,
  StudentInterview,
} from '../types/interview';

/** A failed interview request. `message` is safe to show: it is the server's own plain-language message when there is one. */
export class InterviewApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'InterviewApiError';
    this.status = status;
  }
}

const NETWORK_MESSAGE = 'Could not reach the server. Check your connection and try again.';
const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

async function request<T>(path: string, init: { method: 'GET' | 'POST' | 'PUT'; body?: unknown } = { method: 'GET' }): Promise<T> {
  const token = await getAuthToken();

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body !== undefined && { 'Content-Type': 'application/json' }),
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    });
  } catch {
    throw new InterviewApiError(0, NETWORK_MESSAGE);
  }

  if (!response.ok) {
    let message = GENERIC_MESSAGE;
    try {
      const data = await response.json();
      if (typeof data?.error === 'string' && data.error) message = data.error;
    } catch {
      // Not JSON: keep the generic message.
    }
    throw new InterviewApiError(response.status, message);
  }

  return response.json() as Promise<T>;
}

/** The interview of a submission always has this id, so a reload can find it again. */
export const interviewIdForSubmission = (submissionId: string) => `int_${submissionId}`;

/** Start the student's interview for their own submission. 409 when it already exists. */
export function startInterview(submissionId: string) {
  return request<StartInterviewResult>('/interviews', { method: 'POST', body: { submissionId } });
}

/**
 * The student view of the caller's own interview. Opening a running interview starts its clock (once); `peek` only asks whether the
 * interview exists and leaves the clock alone (the waiting page uses it while the recording upload is still running).
 */
export async function getStudentInterview(interviewId: string, options: { peek?: boolean; sessionKey?: string } = {}) {
  // The session key proves this is the page that created the interview. Opening it without the key ends it ("abandoned").
  const query = options.peek ? '?peek=1' : options.sessionKey ? `?session=${encodeURIComponent(options.sessionKey)}` : '';
  const data = await request<{ interview: StudentInterview }>(`/interviews/${encodeURIComponent(interviewId)}${query}`);
  return data.interview;
}

/** The instructor view of any interview (admins only). */
export async function getAdminInterview(interviewId: string) {
  const data = await request<{ interview: AdminInterview }>(`/interviews/${encodeURIComponent(interviewId)}`);
  return data.interview;
}

export function answerInterview(interviewId: string, answer: string, clientTiming: ClientTiming, sessionKey?: string) {
  return request<AnswerResult>(`/interviews/${encodeURIComponent(interviewId)}/answers`, {
    method: 'POST',
    body: { answer, clientTiming, ...(sessionKey && { sessionKey }) },
  });
}

/** The student confirmed leaving: the interview ends now and cannot be retaken. */
export function abandonInterview(interviewId: string) {
  return request<{ status: string }>(`/interviews/${encodeURIComponent(interviewId)}/abandon`, { method: 'POST', body: {} });
}

/** Admins only: every interview of one submission, real and practice. */
export async function listSubmissionInterviews(submissionId: string) {
  const data = await request<{ submissionId: string; interviews: InterviewSummary[] }>(
    `/interviews?submissionId=${encodeURIComponent(submissionId)}`,
  );
  return data.interviews;
}

/** Admins only: start a practice interview on an existing submission's code. */
export function startPracticeInterview(submissionId: string) {
  return request<StartInterviewResult>('/interviews/practice', { method: 'POST', body: { submissionId } });
}

/** Admins only: save the instructor's overrides, grade and note. The agent's own checks are not changed. */
export async function saveInterviewReview(interviewId: string, review: InterviewReviewInput) {
  const data = await request<{ review: InterviewReview }>(`/interviews/${encodeURIComponent(interviewId)}/review`, {
    method: 'PUT',
    body: review,
  });
  return data.review;
}
