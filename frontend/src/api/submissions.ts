import { getAuthToken, API_BASE } from './config';
import type { SubmissionEndedBy } from '../types/submission';

export type RunStatus = 'accepted' | 'compile_error' | 'runtime_error' | 'time_limit' | 'memory_limit' | 'failed';

export interface SampleRunResult {
  index: number;
  passed: boolean;
  status: string;
  input: string;
  expectedOutput: string;
  actualOutput: string;
  stderr: string;
  timeMs: number;
}

/** What POST /submissions/run returns: custom input, or the visible sample tests. */
export type RunResponse =
  | { mode: 'custom'; status: RunStatus; stdout: string; stderr: string; compileOutput: string; timeMs: number; runsLeft: number | null }
  | {
      mode: 'sample';
      status: RunStatus;
      compileOutput: string;
      results: SampleRunResult[];
      passed: number;
      total: number;
      timeMs: number;
      runsLeft: number | null;
    };

/**
 * Run the current code before submitting (C++ only): on the given input, or on the visible sample tests.
 * Throws an Error with the server's plain-language message (for example when a run limit is reached).
 */
export async function runCode(data: { milestoneId: string; code: string; input?: string; sample?: boolean }): Promise<RunResponse> {
  const token = await getAuthToken();

  const response = await fetch(`${API_BASE}/submissions/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    let message = '';
    try {
      message = (await response.json()).error || '';
    } catch {
      // not JSON: use the generic message below
    }
    throw new Error(message || `The run failed (status ${response.status}). Please try again.`);
  }

  return response.json();
}

/**
 * Submit code for grading (all test cases including hidden ones)
 */
export async function submitCode(data: {
  milestoneId: string;
  code: string;
  language: string;
  endedBy?: SubmissionEndedBy;
}) {
  const token = await getAuthToken();

  console.log('Submitting code for milestone:', data.milestoneId);

  const response = await fetch(`${API_BASE}/submissions/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Submit code failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

/**
 * Get submission history for a milestone
 */
export async function getSubmissions(milestoneId: string) {
  const token = await getAuthToken();

  console.log('Fetching submissions for milestone:', milestoneId);

  const response = await fetch(`${API_BASE}/submissions/milestone/${milestoneId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Get submissions failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

/**
 * Get a specific submission by ID
 */
export async function getSubmission(submissionId: string) {
  const token = await getAuthToken();

  console.log('Fetching submission:', submissionId);

  const response = await fetch(`${API_BASE}/submissions/${submissionId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Get submission failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}