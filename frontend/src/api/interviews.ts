import { getAuthToken, API_BASE } from './config';
import type {
  AdminInterview,
  AnswerResult,
  ClientTiming,
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

async function request<T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown } = { method: 'GET' }): Promise<T> {
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

/** The student view of the caller's own interview. */
export async function getStudentInterview(interviewId: string) {
  const data = await request<{ interview: StudentInterview }>(`/interviews/${encodeURIComponent(interviewId)}`);
  return data.interview;
}

/** The instructor view of any interview (admins only). */
export async function getAdminInterview(interviewId: string) {
  const data = await request<{ interview: AdminInterview }>(`/interviews/${encodeURIComponent(interviewId)}`);
  return data.interview;
}

export function answerInterview(interviewId: string, answer: string, clientTiming: ClientTiming) {
  return request<AnswerResult>(`/interviews/${encodeURIComponent(interviewId)}/answers`, {
    method: 'POST',
    body: { answer, clientTiming },
  });
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
