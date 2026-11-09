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

/** Admin view: everything, plus criteriaCount so every client can rely on it. */
function toAdminAssessment(assessment) {
  if (!assessment || !Array.isArray(assessment.rubric)) return assessment;
  return { ...assessment, criteriaCount: assessment.rubric.length };
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
  }
  return view;
}

function forViewer(assessment, isAdmin) {
  return isAdmin ? toAdminAssessment(assessment) : toStudentAssessment(assessment);
}

const REVIEWED = ['approved', 'rejected'];

/**
 * Embedded submissions carry the rubric text in rubricResults (criterion + feedback). A student
 * sees it only once the instructor has reviewed the submission, which is when the UI shows it.
 * Before that, the placeholder rows would leak the rubric, so they are dropped.
 */
function toStudentSubmission(submission) {
  if (!submission || submission.type !== 'embedded') return submission;
  const reviewed = REVIEWED.includes(submission.proctoringData?.reviewStatus);
  if (reviewed) return submission;
  const { rubricResults, ...rest } = submission;
  return rest;
}

module.exports = {
  isAdminUser,
  viewerFor,
  canSeeProblem,
  toAdminAssessment,
  toStudentAssessment,
  forViewer,
  toStudentSubmission,
};
