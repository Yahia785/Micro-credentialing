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

/** Admin view: everything, plus criteriaCount so every client can rely on it. */
function toAdminAssessment(assessment) {
  if (!assessment || !Array.isArray(assessment.rubric)) return assessment;
  return { ...assessment, criteriaCount: assessment.rubric.length };
}

/** Non-admin view: no rubric text, no interview setup. */
function toStudentAssessment(assessment) {
  if (!assessment) return assessment;
  const { rubric, interview, ...rest } = assessment;
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
  toAdminAssessment,
  toStudentAssessment,
  forViewer,
  toStudentSubmission,
};
