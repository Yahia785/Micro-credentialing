import { getAuthToken, API_BASE } from './config';

// ============================================
// TYPES
// ============================================

export interface RubricResult {
  criterion: string;
  passed: boolean;
  feedback: string;
}

export interface EmbeddedAssessment {
  milestoneId: string;
  type: 'embedded';
  title: string;
  description: string;
  difficulty: 'easy' | 'medium' | 'hard';
  rubric: string[];
  bcdiplomaTemplateId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EmbeddedSubmissionResult {
  submissionId: string;
  passed: boolean;
  score: number;
  passedCriteria: number;
  totalCriteria: number;
  rubricResults: RubricResult[];
  message: string;
}

// ============================================
// API FUNCTIONS
// ============================================

export async function getAllEmbeddedAssessments(): Promise<{ assessments: EmbeddedAssessment[] }> {
  const token = await getAuthToken();

  const response = await fetch(`${API_BASE}/embedded-assessments`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Get embedded assessments failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

export async function getEmbeddedAssessment(assessmentId: string): Promise<{ assessment: EmbeddedAssessment }> {
  const token = await getAuthToken();

  const response = await fetch(`${API_BASE}/embedded-assessments/${assessmentId}`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Get embedded assessment failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

export async function createEmbeddedAssessment(data: {
  title: string;
  description?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  rubric: string[];
  bcdiplomaTemplateId?: string;
}): Promise<{ assessment: EmbeddedAssessment }> {
  const token = await getAuthToken();

  const response = await fetch(`${API_BASE}/embedded-assessments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Create embedded assessment failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

export async function updateEmbeddedAssessment(
  assessmentId: string,
  updates: Partial<{
    title: string;
    description: string;
    difficulty: 'easy' | 'medium' | 'hard';
    rubric: string[];
    bcdiplomaTemplateId: string;
  }>
): Promise<{ assessment: EmbeddedAssessment }> {
  const token = await getAuthToken();

  const response = await fetch(`${API_BASE}/embedded-assessments/${assessmentId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Update embedded assessment failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

export async function deleteEmbeddedAssessment(assessmentId: string): Promise<void> {
  const token = await getAuthToken();

  const response = await fetch(`${API_BASE}/embedded-assessments/${assessmentId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Delete embedded assessment failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }
}

export async function submitEmbeddedAssessment(
  assessmentId: string,
  code: string
): Promise<EmbeddedSubmissionResult> {
  const token = await getAuthToken();

  const response = await fetch(`${API_BASE}/embedded-assessments/${assessmentId}/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ code }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Submit embedded assessment failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}