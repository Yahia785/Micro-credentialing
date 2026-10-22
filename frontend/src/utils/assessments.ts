import type { Assessment } from '../types/assessment';

export const NO_COURSE_LABEL = 'No course';

const LANGUAGE_LABELS: Record<string, string> = {
  cpp: 'C++',
  c: 'C',
  python: 'Python',
  javascript: 'JavaScript',
  java: 'Java',
};

export const EMBEDDED_TYPE_LABEL = 'Embedded C / MSP432';

/** The type badge text: the coding language for coding problems, a fixed label for embedded ones. */
export function getTypeLabel(assessment: Assessment): string {
  if (assessment.kind === 'embedded') return EMBEDDED_TYPE_LABEL;
  const language = assessment.language;
  if (!language) return 'Coding';
  return LANGUAGE_LABELS[language] ?? language.toUpperCase();
}

/** Same trimming the server applies, so local state matches what was saved. */
export function normalizeCourseName(course: string): string | null {
  const value = course.replace(/\s+/g, ' ').trim();
  return value === '' ? null : value;
}

/** Distinct, sorted course names (without "No course"). */
export function getCourseNames(assessments: Assessment[]): string[] {
  const names = new Set<string>();
  for (const assessment of assessments) {
    if (assessment.course) names.add(assessment.course);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Filter values for the course select. */
export const ALL_COURSES = '__all__';
export const NO_COURSE = '__none__';

export interface CourseGroup {
  course: string | null;
  label: string;
  items: Assessment[];
}

function newestFirst(a: Assessment, b: Assessment): number {
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

/** Groups by course (alphabetical, "No course" last); each group is sorted newest first. */
export function groupByCourse(assessments: Assessment[]): CourseGroup[] {
  const groups = getCourseNames(assessments).map<CourseGroup>((course) => ({
    course,
    label: course,
    items: assessments.filter((a) => a.course === course).sort(newestFirst),
  }));

  const uncategorized = assessments.filter((a) => !a.course).sort(newestFirst);
  if (uncategorized.length > 0) {
    groups.push({ course: null, label: NO_COURSE_LABEL, items: uncategorized });
  }
  return groups;
}

/** Keeps the groups matching the course filter ALL_COURSES, NO_COURSE, or a course name. */
export function filterGroups(groups: CourseGroup[], filter: string): CourseGroup[] {
  if (filter === ALL_COURSES) return groups;
  if (filter === NO_COURSE) return groups.filter((group) => group.course === null);
  return groups.filter((group) => group.course === filter);
}

/**
 * The milestone object CodeEditor expects. Coding problems pass the same fields as before; embedded
 * assessments keep their fixed C language and type.
 */
export function toEditorMilestone(assessment: Assessment) {
  if (assessment.kind === 'embedded') {
    return {
      milestoneId: assessment.milestoneId,
      title: assessment.title,
      description: assessment.description,
      difficulty: assessment.difficulty,
      language: 'c',
      starterCode: '',
      type: 'embedded',
    };
  }
  return {
    milestoneId: assessment.milestoneId,
    title: assessment.title,
    description: assessment.description,
    concept: assessment.concept,
    difficulty: assessment.difficulty,
    language: assessment.language,
    starterCode: assessment.starterCode,
    timeLimit: assessment.timeLimit,
    memoryLimit: assessment.memoryLimit,
  };
}
