import { getAuthToken, API_BASE } from './config';

// ============================================
// TYPES
// ============================================

/**
 * MCQ option with per-option scoring
 */
export interface MCQOption {
  id: string;
  text: string;
  points: number;
}

/**
 * MCQ question
 */
export interface MCQQuestion {
  questionId: string;
  type: 'mcq';
  title: string;
  question: string;
  options: MCQOption[];
  selectionType: 'single' | 'multiple';
  maxPoints: number;
  explanation?: string;
}

/**
 * Short response question
 */
export interface ShortResponseQuestion {
  questionId: string;
  type: 'short_response';
  title: string;
  question: string;
  acceptedAnswers: string[];
  caseSensitive: boolean;
  points: number;
  explanation?: string;
}

/**
 * Union type for knowledge questions
 */
export type KnowledgeQuestion = MCQQuestion | ShortResponseQuestion;

/**
 * Knowledge assessment
 */
export interface KnowledgeAssessment {
  milestoneId: string;
  type: 'knowledge';
  title: string;
  description: string;
  timeLimit: number;
  passingScore: number;
  questions: KnowledgeQuestion[];
  bcdiplomaTemplateId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Student's answer to a question
 */
export interface QuestionAnswer {
  questionId: string;
  type: 'mcq' | 'short_response';
  answer: string[] | string;
}

/**
 * Graded result for a question
 */
export interface QuestionResult {
  questionId: string;
  type: 'mcq' | 'short_response';
  answer: string[] | string;
  earnedPoints: number;
  maxPoints: number;
  isCorrect: boolean;
  explanation?: string;
}

/**
 * Submission result
 */
export interface KnowledgeSubmissionResult {
  submissionId: string;
  totalScore: number;
  maxScore: number;
  percentage: number;
  passed: boolean;
  results: QuestionResult[];
}

// ============================================
// API FUNCTIONS
// ============================================

/**
 * Get all knowledge assessments
 */
export async function getAllKnowledgeAssessments(): Promise<KnowledgeAssessment[]> {
  const token = await getAuthToken();

  const response = await fetch(`${API_BASE}/knowledge-assessments`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Get knowledge assessments failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

/**
 * Get a specific knowledge assessment by ID
 */
export async function getKnowledgeAssessment(assessmentId: string): Promise<KnowledgeAssessment> {
  const token = await getAuthToken();

  const response = await fetch(`${API_BASE}/knowledge-assessments/${assessmentId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Get knowledge assessment failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

/**
 * Create a new knowledge assessment (admin only)
 */
export async function createKnowledgeAssessment(data: {
  title: string;
  description?: string;
  timeLimit: number;
  passingScore: number;
  questions: KnowledgeQuestion[];
  bcdiplomaTemplateId?: string;
}): Promise<KnowledgeAssessment> {
  const token = await getAuthToken();

  const response = await fetch(`${API_BASE}/knowledge-assessments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Create knowledge assessment failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

/**
 * Update a knowledge assessment (admin only)
 */
export async function updateKnowledgeAssessment(
  assessmentId: string,
  updates: Partial<{
    title: string;
    description: string;
    timeLimit: number;
    passingScore: number;
    questions: KnowledgeQuestion[];
    bcdiplomaTemplateId: string;
  }>
): Promise<KnowledgeAssessment> {
  const token = await getAuthToken();

  const response = await fetch(`${API_BASE}/knowledge-assessments/${assessmentId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Update knowledge assessment failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

/**
 * Delete a knowledge assessment (admin only)
 */
export async function deleteKnowledgeAssessment(assessmentId: string): Promise<void> {
  const token = await getAuthToken();

  const response = await fetch(`${API_BASE}/knowledge-assessments/${assessmentId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Delete knowledge assessment failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }
}

/**
 * Submit answers for a knowledge assessment
 */
export async function submitKnowledgeAssessment(
  assessmentId: string,
  answers: QuestionAnswer[]
): Promise<KnowledgeSubmissionResult> {
  const token = await getAuthToken();

  const response = await fetch(`${API_BASE}/knowledge-assessments/${assessmentId}/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ answers }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Submit knowledge assessment failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

/**
 * Get submission history for a knowledge assessment
 */
export async function getKnowledgeSubmissions(assessmentId: string) {
  const token = await getAuthToken();

  const response = await fetch(`${API_BASE}/knowledge-assessments/${assessmentId}/submissions`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Get knowledge submissions failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}