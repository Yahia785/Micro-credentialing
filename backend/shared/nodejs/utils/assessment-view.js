/**
 * What each caller may see of an assessment or a submission.
 *
 * Students never receive the interview setup (questions, criteria) or the embedded rubric
 * criteria before their submission has been reviewed. They get counts and flags instead.
 */
const { getUser } = require('../db/users');

async function isAdminUser(userId) {
  if (!userId) return false;
  const user = await getUser(userId);
  return !!user && user.role === 'admin';
}

/**
 * Who is asking, for the hidden-problem rule. If the user record cannot be read the caller is treated as a normal
 * student (ok: false), even if their ID is on a preview list.
 * @returns {Promise<{ isAdmin: boolean, ok: boolean }>}
 */
async function viewerFor(userId) {
  try {
    return { isAdmin: await isAdminUser(userId), ok: true };
  } catch {
    return { isAdmin: false, ok: false };
  }
}

/**
 * A hidden problem (isHidden) is for admins and for the users on its previewUserIds list. Everyone else never sees it.
 * Problems that are not hidden are open to everyone.
 */
function canSeeProblem(assessment, userId, viewer) {
  if (!assessment || !assessment.isHidden) return true;
  if (!viewer || !viewer.ok) return false;
  if (viewer.isAdmin) return true;
  return Array.isArray(assessment.previewUserIds) && !!userId && assessment.previewUserIds.includes(userId);
}

/** Admin view: everything, plus criteriaCount and interviewEnabled so every client can rely on them. */
function toAdminAssessment(assessment) {
  if (!assessment) return assessment;
  const view = { ...assessment };
  if (Array.isArray(assessment.rubric)) view.criteriaCount = assessment.rubric.length;
  if (assessment.interview) view.interviewEnabled = assessment.interview.enabled === true;
  return view;
}

/** Non-admin view: no rubric text, no interview setup. */
function toStudentAssessment(assessment) {
  if (!assessment) return assessment;
  // The hidden flag and the preview list (other people's IDs) are admin data.
  const { rubric, interview, isHidden, previewUserIds, ...rest } = assessment;
  const view = { ...rest };
  if (Array.isArray(rubric)) view.criteriaCount = rubric.length;
  if (interview && interview.enabled) {
    view.interviewEnabled = true;
    view.interviewTimeLimitMinutes = interview.timeLimitMinutes;
    // How many questions the interview has (a number only: the questions themselves stay private), for the waiting page.
    view.interviewQuestionCount = (interview.themes || []).reduce((n, theme) => n + ((theme.mainQuestions || []).length), 0);
  }
  return view;
}

function forViewer(assessment, isAdmin) {
  return isAdmin ? toAdminAssessment(assessment) : toStudentAssessment(assessment);
}

const REVIEWED = ['approved', 'rejected'];

/**
 * A C++ coding problem with the interview enabled is held for the instructor: until the submission is approved or rejected the
 * student sees nothing about how they did (no score, no pass/fail, no tests, no output, no code), and no result is ever final
 * without the instructor.
 */
function isHeldForReview(milestone) {
  return !!milestone && milestone.type !== 'embedded' && milestone.language === 'cpp' && !!milestone.interview && milestone.interview.enabled === true;
}

const isReviewedStatus = (status) => REVIEWED.includes(status);

/** A submission (or a completedMilestones entry) that is held and still waiting for the instructor. */
function isUnderReview(record) {
  if (!record || record.heldForReview !== true) return false;
  return !isReviewedStatus(record.proctoringData && record.proctoringData.reviewStatus);
}

/** What a student sees of a held submission that is still under review: its status and when it was submitted, nothing else. */
function underReviewSubmission(submission) {
  return {
    submissionId: submission.submissionId,
    milestoneId: submission.milestoneId,
    status: 'under_review',
    underReview: true,
    submittedAt: submission.submittedAt || submission.createdAt || null,
    proctoringData: { reviewStatus: 'pending' },
  };
}

/**
 * The student's completedMilestones list. An entry that is under review keeps only the problem, the submission and the date:
 * no score, no test counts, no pass/fail. Admins get the stored list unchanged.
 */
function toStudentUser(user, { isAdmin = false } = {}) {
  if (!user || isAdmin || !Array.isArray(user.completedMilestones)) return user;
  return {
    ...user,
    completedMilestones: user.completedMilestones.map((entry) => {
      if (!isUnderReview(entry)) return entry;
      return {
        milestoneId: entry.milestoneId,
        submissionId: entry.submissionId,
        completedAt: entry.completedAt,
        heldForReview: true,
        underReview: true,
        proctoringData: { reviewStatus: 'pending' },
      };
    }),
  };
}

/**
 * Embedded submissions carry the rubric text in rubricResults (criterion + feedback). A student
 * sees it only once the instructor has reviewed the submission, which is when the UI shows it.
 * Before that, the placeholder rows would leak the rubric, so they are dropped.
 */
function toStudentSubmission(submission) {
  if (isUnderReview(submission)) return underReviewSubmission(submission);
  if (!submission || submission.type !== 'embedded') return submission;
  const reviewed = REVIEWED.includes(submission.proctoringData?.reviewStatus);
  if (reviewed) return submission;
  const { rubricResults, ...rest } = submission;
  return rest;
}

module.exports = {
  isAdminUser,
  isHeldForReview,
  isUnderReview,
  underReviewSubmission,
  toStudentUser,
  viewerFor,
  canSeeProblem,
  toAdminAssessment,
  toStudentAssessment,
  forViewer,
  toStudentSubmission,
};
