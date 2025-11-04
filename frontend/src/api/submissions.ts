import { getAuthToken, API_BASE } from './config';

/**
 * Run code with sample test cases (visible ones only)
 */
export async function runCode(data: {
  milestoneId: string;
  code: string;
  language: string;
}) {
  const token = await getAuthToken();

  console.log('Running code for milestone:', data.milestoneId);

  const response = await fetch(`${API_BASE}/submissions/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Run code failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
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