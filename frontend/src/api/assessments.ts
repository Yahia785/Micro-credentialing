import type { Assessment } from '../types/assessment';
import type { Difficulty } from '../utils/difficulty';
import { deleteEmbeddedAssessment, getAllEmbeddedAssessments, updateEmbeddedAssessment } from './embedded-assessments';
import type { EmbeddedAssessment } from './embedded-assessments';
import { deleteMilestone, getAllMilestones, updateMilestone } from './milestones';

/** A row from GET /milestones. That endpoint returns every item in the table, embedded ones included. */
interface MilestoneRow {
  milestoneId: string;
  type?: string;
  title: string;
  description: string;
  difficulty: Difficulty;
  course?: string | null;
  concept?: string;
  language?: string;
  starterCode?: string;
  timeLimit?: number;
  memoryLimit?: number;
  testCaseCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface LoadedAssessments {
  assessments: Assessment[];
  /** One message per kind that failed to load. The other kind is still returned. */
  errors: string[];
}

function normalizeCourse(course: string | null | undefined): string | null {
  return typeof course === 'string' && course.trim() !== '' ? course.trim() : null;
}

/** Loads coding problems and embedded assessments through their existing endpoints, as one list. */
export async function getAllAssessments(): Promise<LoadedAssessments> {
  const [codingResult, embeddedResult] = await Promise.allSettled([getAllMilestones(), getAllEmbeddedAssessments()]);

  const assessments: Assessment[] = [];
  const errors: string[] = [];

  if (codingResult.status === 'fulfilled') {
    const rows: MilestoneRow[] = codingResult.value.milestones || [];
    for (const row of rows) {
      if (row.type === 'embedded') continue; // listed by the embedded endpoint below
      assessments.push({
        kind: 'coding',
        milestoneId: row.milestoneId,
        title: row.title,
        description: row.description,
        difficulty: row.difficulty,
        course: normalizeCourse(row.course),
        concept: row.concept,
        language: row.language,
        starterCode: row.starterCode,
        timeLimit: row.timeLimit,
        memoryLimit: row.memoryLimit,
        testCaseCount: row.testCaseCount,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }
  } else {
    console.error('Failed to load problems:', codingResult.reason);
    errors.push('Failed to load coding problems');
  }

  if (embeddedResult.status === 'fulfilled') {
    const rows: EmbeddedAssessment[] = embeddedResult.value.assessments || [];
    for (const row of rows) {
      assessments.push({
        kind: 'embedded',
        milestoneId: row.milestoneId,
        title: row.title,
        description: row.description,
        difficulty: row.difficulty,
        course: normalizeCourse(row.course),
        criteriaCount: row.criteriaCount ?? row.rubric?.length ?? 0,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }
  } else {
    console.error('Failed to load embedded assessments:', embeddedResult.reason);
    errors.push('Failed to load embedded assessments');
  }

  return { assessments, errors };
}

export async function deleteAssessment(assessment: Assessment): Promise<void> {
  if (assessment.kind === 'embedded') {
    await deleteEmbeddedAssessment(assessment.milestoneId);
  } else {
    await deleteMilestone(assessment.milestoneId);
  }
}

/** Thrown when the server accepted a request but did not store the course (e.g. an out-of-date backend). */
export class CourseNotSavedError extends Error {
  constructor() {
    super('The server did not store the course');
    this.name = 'CourseNotSavedError';
  }
}

/** The course a create/update response says was stored (null when none). */
export function storedCourse(item: { course?: string | null } | undefined): string | null {
  return normalizeCourse(item?.course);
}

/**
 * Sets an assessment's course. An empty string clears it ("No course").
 * Resolves to the course the server stored, and throws CourseNotSavedError if it differs from what was
 * asked for, so an out-of-date backend can't silently drop it.
 */
export async function setAssessmentCourse(assessment: Assessment, course: string): Promise<string | null> {
  const expected = normalizeCourse(course);
  const response =
    assessment.kind === 'embedded'
      ? await updateEmbeddedAssessment(assessment.milestoneId, { course })
      : await updateMilestone(assessment.milestoneId, { course });
  const stored = storedCourse(assessment.kind === 'embedded' ? response.assessment : response.milestone);
  if (stored !== expected) throw new CourseNotSavedError();
  return stored;
}
