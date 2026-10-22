import type { Difficulty } from '../utils/difficulty';

export type AssessmentKind = 'coding' | 'embedded';

interface AssessmentBase {
  milestoneId: string;
  title: string;
  description: string;
  difficulty: Difficulty;
  /** Optional grouping label. Null means "No course". */
  course: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A coding problem graded with test cases (Judge0). */
export interface CodingAssessment extends AssessmentBase {
  kind: 'coding';
  concept?: string;
  language?: string;
  starterCode?: string;
  timeLimit?: number;
  memoryLimit?: number;
  testCaseCount?: number;
}

/** An embedded systems assessment graded against a rubric. */
export interface EmbeddedRubricAssessment extends AssessmentBase {
  kind: 'embedded';
  rubric: string[];
}

export type Assessment = CodingAssessment | EmbeddedRubricAssessment;
