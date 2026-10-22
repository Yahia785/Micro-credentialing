const { getEmbeddedAssessment } = require('../db/embedded-assessments');
const { createEmbeddedSubmission } = require('../db/embedded-submission');
const { getUser, updateUser, addCompletedMilestone } = require('../db/users');
const anthropic = require('../utils/anthropic');
const log = require('../utils/logger');
const { AppError, ValidationError, NotFoundError } = require('../utils/errors');
const { END_REASONS, parseEndedBy } = require('../utils/submission-end-reason');

const GRADING_MODES = Object.freeze({ LLM: 'llm', MANUAL: 'manual' });

/**
 * Only the exact value "llm" turns on automatic grading. Anything else (including a missing or
 * misspelled setting) is manual, so a bad config can never silently send code to a third party.
 */
function resolveGradingMode(raw) {
  return raw === GRADING_MODES.LLM ? GRADING_MODES.LLM : GRADING_MODES.MANUAL;
}

/** One placeholder row per rubric criterion so the admin review screen can still mark each one. */
function ungradedRubricResults(rubric, feedback) {
  return rubric.map((criterion) => ({ criterion, passed: false, feedback }));
}

/**
 * Embedded assessment submission workflow.
 *
 * - "llm" mode: grade against the rubric with the LLM (original behaviour). If the LLM call fails the
 *   submission is still saved with status "grading_failed" and goes to instructor review.
 * - "manual" mode: the LLM is never called. The submission is saved as "manual_review".
 *
 * In every case the submission is saved with proctoringData.reviewStatus = 'pending' and the
 * milestone is recorded as completed (one attempt). Responses keep the original fields, so older
 * clients work unchanged; gradingMode / gradingFailed are additive.
 *
 * Throws AppError subclasses (ValidationError 400, NotFoundError 404, AppError 500).
 */
async function processEmbeddedSubmission({ userId, assessmentId, body, gradingMode: rawMode }) {
  if (!assessmentId) {
    throw new ValidationError('Assessment ID is required');
  }

  const gradingMode = resolveGradingMode(rawMode);

  const user = await getUser(userId);
  if (!user) {
    throw new NotFoundError('User');
  }

  const alreadySubmitted = (user.completedMilestones || []).some((m) => m.milestoneId === assessmentId);
  if (alreadySubmitted) {
    throw new ValidationError('You have already submitted this assessment. Only one submission is allowed.');
  }

  const assessment = await getEmbeddedAssessment(assessmentId);
  if (!assessment) {
    throw new NotFoundError('Embedded assessment');
  }

  if (!body || !body.code || !body.code.trim()) {
    throw new ValidationError('Code is required');
  }

  // A missing endedBy (older clients) is exactly 'submit_button'.
  const { value: endedBy, error: endedByError } = parseEndedBy(body.endedBy);
  if (endedByError) {
    throw new ValidationError(endedByError);
  }
  // Left mid-session: always instructor review and never auto-credentialed.
  const leftPage = endedBy === END_REASONS.LEFT_PAGE;

  if (!assessment.rubric || assessment.rubric.length === 0) {
    throw new AppError('Assessment has no rubric criteria configured', 500);
  }

  const totalCriteria = assessment.rubric.length;
  let grading = null; // set when the LLM graded successfully
  let saveFields; // grading-dependent fields of the saved submission
  let responseExtras; // additive response fields

  if (gradingMode === GRADING_MODES.LLM) {
    log.info('Grading embedded submission', { assessmentId, userId });
    try {
      grading = await anthropic.gradeEmbeddedCode(body.code, assessment.rubric);
      log.info('Grading result', {
        passedCriteria: grading.passedCriteria,
        totalCriteria: grading.totalCriteria,
        score: grading.score,
        passed: grading.passed
      });
    } catch (gradingError) {
      // Never lose the submission: keep it and send it to the instructor.
      log.error('Embedded grading failed, saving for manual review', { assessmentId, error: gradingError.message });
      saveFields = {
        status: 'grading_failed',
        gradingMode,
        errorMessage: gradingError.message,
        rubricResults: ungradedRubricResults(assessment.rubric, 'Automatic grading failed. Instructor review required.'),
        passedCriteria: 0,
        totalCriteria,
        score: 0,
        passed: false,
        llmModel: null
      };
      responseExtras = { gradingMode, gradingFailed: true };
    }
  } else {
    log.info('Embedded grading mode is manual, saving for instructor review', { assessmentId, userId });
    saveFields = {
      status: 'manual_review',
      gradingType: 'manual',
      gradingMode,
      rubricResults: ungradedRubricResults(assessment.rubric, 'Awaiting instructor review.'),
      passedCriteria: 0,
      totalCriteria,
      score: 0,
      passed: false,
      llmModel: null
    };
    responseExtras = { gradingMode };
  }

  if (grading) {
    saveFields = {
      gradingMode,
      rubricResults: grading.rubricResults,
      passedCriteria: grading.passedCriteria,
      totalCriteria: grading.totalCriteria,
      score: grading.score,
      passed: grading.passed,
      llmModel: grading.llmModel
    };
    responseExtras = { gradingMode };
  }

  const submission = await createEmbeddedSubmission({
    userId,
    studentEmail: user.email,
    studentName: user.name || '',
    milestoneId: assessmentId,
    code: body.code,
    endedBy,
    ...saveFields
  });

  log.info('Embedded submission created', { submissionId: submission.submissionId, gradingMode });

  // Add to completedMilestones so they cannot retake. Regardless of pass/fail/ungraded.
  try {
    await addCompletedMilestone(userId, {
      milestoneId: assessmentId,
      score: saveFields.score,
      passedTests: saveFields.passedCriteria,
      totalTests: saveFields.totalCriteria,
      submissionId: submission.submissionId,
      ...(responseExtras.gradingFailed && { gradingFailed: true })
    });

    log.info('Added to completedMilestones', { userId, assessmentId });

    // Only an automatically graded pass that did not end by leaving the page counts immediately.
    if (grading && grading.passed && !leftPage) {
      await updateUser(userId, {
        credentialsCount: (user.credentialsCount || 0) + 1,
        milestonesCompleted: (user.milestonesCompleted || 0) + 1
      });
    }
  } catch (userUpdateErr) {
    // Don't fail the submission if the user update fails: log and continue
    log.error('Failed to update user completedMilestones', { error: userUpdateErr.message });
  }

  let message;
  if (responseExtras.gradingFailed) {
    message = 'Submission received. Automatic grading was unavailable, so your instructor will review it.';
  } else if (gradingMode === GRADING_MODES.MANUAL) {
    message = 'Submission received. Your instructor will review it.';
  } else {
    message = saveFields.passed ? 'Assessment passed!' : 'Assessment did not pass.';
  }

  return {
    message,
    submissionId: submission.submissionId,
    passed: saveFields.passed,
    score: saveFields.score,
    passedCriteria: saveFields.passedCriteria,
    totalCriteria: saveFields.totalCriteria,
    // rubricResults are deliberately not returned: students see the criteria only once reviewed.
    ...responseExtras
  };
}

module.exports = { processEmbeddedSubmission, resolveGradingMode, GRADING_MODES };
