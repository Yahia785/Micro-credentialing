import { getAuthToken, API_BASE } from './config';

/**
 * Get all milestones (problems)
 */
export async function getAllMilestones() {
  const token = await getAuthToken();

  console.log('Fetching all milestones from:', `${API_BASE}/milestones`);

  const response = await fetch(`${API_BASE}/milestones`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Get milestones failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

/**
 * Get a specific milestone by ID
 */
export async function getMilestone(milestoneId: string) {
  const token = await getAuthToken();

  console.log('Fetching milestone:', milestoneId);

  const response = await fetch(`${API_BASE}/milestones/${milestoneId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Get milestone failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

/**
 * Create a new milestone (problem)
 */
export async function createMilestone(data: {
  title: string;
  description: string;
  difficulty: 'easy' | 'medium' | 'hard';
}) {
  const token = await getAuthToken();

  console.log('Creating milestone with data:', data);

  const response = await fetch(`${API_BASE}/milestones`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Create milestone failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

/**
 * Update an existing milestone
 */
export async function updateMilestone(
  milestoneId: string,
  updates: {
    title?: string;
    description?: string;
    difficulty?: 'easy' | 'medium' | 'hard';
  }
) {
  const token = await getAuthToken();

  console.log('Updating milestone:', milestoneId, 'with data:', updates);

  const response = await fetch(`${API_BASE}/milestones/${milestoneId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Update milestone failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

/**
 * Delete a milestone
 */
export async function deleteMilestone(milestoneId: string) {
  const token = await getAuthToken();

  console.log('Deleting milestone:', milestoneId);

  const response = await fetch(`${API_BASE}/milestones/${milestoneId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Delete milestone failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}