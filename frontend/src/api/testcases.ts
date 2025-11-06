import { getAuthToken, API_BASE } from './config';

/**
 * TestCase interface
 */
export interface TestCase {
  testCaseId?: string;
  milestoneId: string;
  input: string;
  expectedOutput: string;
  isHidden: boolean;
  includeInJudge0?: boolean;
  weight?: number;
  order?: number;
  testTier?: string;
  createdAt?: string;
}

/**
 * Create multiple test cases for a milestone in batch
 */
export async function createTestCasesBatch(
  milestoneId: string,
  testCases: Omit<TestCase, 'milestoneId' | 'testCaseId'>[]
) {
  const token = await getAuthToken();

  console.log('Creating test cases batch for milestone:', milestoneId);

  const response = await fetch(`${API_BASE}/milestones/${milestoneId}/testcases/batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ testCases }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Create test cases batch failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

/**
 * Get test cases for a milestone
 * Regular users will only see non-hidden test cases
 * Admins will see all test cases
 */
export async function getTestCases(milestoneId: string) {
  const token = await getAuthToken();

  console.log('Fetching test cases for milestone:', milestoneId);

  const response = await fetch(`${API_BASE}/milestones/${milestoneId}/testcases`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Get test cases failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}