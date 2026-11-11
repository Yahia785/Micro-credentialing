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
  /** Hidden from students; the API only returns such problems to admins. */
  isHidden?: boolean;
  /** True when finishing this problem is followed by the interview. The questions are never sent to students. */
  interviewEnabled?: boolean;
  /** Length of the interview in minutes, when enabled. */
  interviewTimeLimitMinutes?: number;
  /** How many questions the interview has, when enabled (the questions themselves are never sent to students). */
  interviewQuestionCount?: number;
}

/** An embedded systems assessment graded against a rubric. */
export interface EmbeddedRubricAssessment extends AssessmentBase {
  kind: 'embedded';
  /** Number of rubric criteria. The criteria text is not sent to students. */
  criteriaCount: number;
}

export type Assessment = CodingAssessment | EmbeddedRubricAssessment;
