const { approveReview } = require('../db/proctoring-reviews');
const { getUser, updateUser } = require('../db/users');
const { getSubmission, updateSubmission } = require('../db/submissions');
const { getMilestone } = require('../db/milestones');
const { pushCertificate, pullCertificate } = require('../utils/bcdiploma');
const { createCredential } = require('../db/credentials');
const log = require('../utils/logger');
const { ValidationError, NotFoundError, ExternalServiceError } = require('../utils/errors');

// TODO: Make this per-assessment configurable (stored on milestone in DynamoDB)
const PASSING_THRESHOLD = 83;

/**
 * Utility function to wait/sleep
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Poll BCdiploma for certificate with retries
 */
async function pollForCertificate(campaignId, maxAttempts = 6, delayMs = 5000) {
  log.info('Starting to poll for certificate', { campaignId, maxAttempts });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log.info('Poll attempt', { attempt, maxAttempts, campaignId });

    try {
      const pullResponse = await pullCertificate(campaignId);

      if (pullResponse.data && pullResponse.data.length > 0) {
        log.info('Certificate ready', { attempts: attempt, campaignId });
        return pullResponse;
      }

      log.info('Certificate not ready yet, waiting', { delayMs, campaignId });

      // Don't wait after last attempt
      if (attempt < maxAttempts) {
        await sleep(delayMs);
      }

    } catch (error) {
      log.error('Error polling attempt', { attempt, error: error.message });

      // If 404, certificate might still be processing
      if (error.message.includes('404') || error.message.includes('not found')) {
        log.info('Certificate still processing, waiting', { delayMs, campaignId });
        if (attempt < maxAttempts) {
          await sleep(delayMs);
        }
        continue;
      }

      // For other errors, throw immediately
      throw error;
    }
  }

  throw new Error(`Certificate not ready after ${maxAttempts} attempts (${maxAttempts * delayMs / 1000} seconds)`);
}

/**
 * Process and save certificate data
 */
async function processCertificate(certificate, campaignId, submission, student, milestone, effectiveScore) {
  const submissionId = certificate.ID;

  log.info('Processing certificate', { submissionId });

  // Validate certificate has required fields
  if (!certificate.key || !certificate.url) {
    throw new Error('Certificate missing required fields (key or url)');
  }

  // Create credential record
  const credentialData = {
    userId: submission.userId,
    milestoneId: submission.milestoneId,
    submissionId: submissionId,
    bcdiplomaKey: certificate.key,
    bcdiplomaUrl: certificate.url,
    bcdiplomaBadgeUrl: certificate.badge || null,
    bcdiplomaTemplateId: milestone.bcdiplomaTemplateId,
    bcdiplomaCampaignId: campaignId,
    recipientName: student.name || `${certificate.firstName} ${certificate.lastName}`,
    recipientEmail: student.email,
    problemTitle: milestone.title,
    score: effectiveScore || submission.score || 0,
    status: 'issued'
  };

  const savedCredential = await createCredential(credentialData);

  log.info('Credential created', {
    credentialId: savedCredential.credentialId,
    certificateUrl: certificate.url,
    bcdiplomaKey: certificate.key
  });

  // Update submission
  await updateSubmission(submissionId, {
    credentialIssued: true,
    credentialId: savedCredential.credentialId
  });

  log.info('Credential issued', { submissionId });

  return savedCredential;
}

/**
 * Core proctoring-review approval workflow. Validates the submission, applies
 * any admin score/criteria overrides, records the review decision, and (when
 * the effective score clears the passing threshold) pushes a certificate to
 * BCdiploma and saves the resulting credential.
 *
 * Extracted from the credentials/approve-review handler.
 *
 * Supports both passed and failed submissions:
 * - Passed submissions: approve as-is (issues credential if score >= threshold),
 *   or override score downward (may prevent credential issuance)
 * - Failed submissions: approve as-is (confirms LLM grading, no credential),
 *   or override score upward (may trigger credential issuance if score >= threshold)
 *
 * Throws ValidationError for bad input / missing resources, and
 * ExternalServiceError when BCdiploma itself fails to accept the push.
 * Certificate-polling and certificate-processing failures that occur AFTER
 * BCdiploma accepted the push are not treated as errors — they return a
 * partial-success result object instead, matching the original handler.
 */
async function approveAndIssueCredential({ submissionId, reviewNotes, adjustedScore, criteriaModifications, adminUserId }) {
  log.info('Approving review', { submissionId });

  // Get submission details
  const submission = await getSubmission(submissionId);
  if (!submission) {
    throw new NotFoundError('Submission');
  }

  // Check if credential already issued
  if (submission.credentialIssued) {
    throw new ValidationError('Credential has already been issued for this submission');
  }

  // Determine effective score — use admin override if provided, otherwise original
  const effectiveScore = (adjustedScore !== undefined && adjustedScore !== null)
    ? Number(adjustedScore)
    : submission.score;

  // If admin provided an adjusted score, update the submission
  if (adjustedScore !== undefined && adjustedScore !== null) {
    log.info('Admin overriding score', { from: submission.score, to: effectiveScore });
    await updateSubmission(submissionId, {
      score: effectiveScore,
      status: effectiveScore >= PASSING_THRESHOLD ? 'passed' : 'failed',
      originalScore: submission.score
    });
  }

  // Validate and store criteria modifications if provided
  if (criteriaModifications && Object.keys(criteriaModifications).length > 0) {
    log.info('Admin modifying criteria', { criteriaModifications });

    // Validate that all indices are within bounds
    const totalCriteria = submission.totalCriteria || submission.rubricResults.length;
    for (const indexStr of Object.keys(criteriaModifications)) {
      const index = parseInt(indexStr);
      if (isNaN(index) || index < 0 || index >= totalCriteria) {
        throw new ValidationError(`Invalid criterion index: ${index}. Must be between 0 and ${totalCriteria - 1}`);
      }
    }

    // Store the modifications
    await updateSubmission(submissionId, {
      criteriaModifications: criteriaModifications
    });
  }

  // Approve the review in database (always runs regardless of credential issuance)
  const updatedSubmission = await approveReview(
    submissionId,
    adminUserId,
    reviewNotes || 'Approved by admin'
  );

  log.info('Review approved in database', { submissionId });

  // Update the user's completedMilestones with review status
  try {
    const user = await getUser(submission.userId);
    if (user && user.completedMilestones) {
      const completedMilestoneIndex = user.completedMilestones.findIndex(
        (m) => m.submissionId === submissionId
      );

      if (completedMilestoneIndex >= 0) {
        // Update this milestone with review status and final score
        user.completedMilestones[completedMilestoneIndex] = {
          ...user.completedMilestones[completedMilestoneIndex],
          proctoringData: {
            reviewStatus: 'approved',
            reviewedBy: adminUserId,
            reviewedAt: new Date().toISOString()
          },
          score: effectiveScore
        };

        await updateUser(submission.userId, {
          completedMilestones: user.completedMilestones
        });

        log.info('Updated completedMilestones with review status', { submissionId });
      }
    }
  } catch (userUpdateErr) {
    log.error('Failed to update completedMilestones with review status', { error: userUpdateErr.message });
    // Don't fail the whole operation if this fails
  }

  const feedback = {
    reviewNotes: reviewNotes || 'Approved by admin',
    adjustedScore: effectiveScore,
    criteriaModifications: criteriaModifications || null,
    reviewedBy: adminUserId,
    reviewedAt: new Date().toISOString()
  };

  const shouldIssueCredential = effectiveScore >= PASSING_THRESHOLD;

  if (!shouldIssueCredential) {
    log.info('Submission approved below threshold, no credential issued', { effectiveScore, threshold: PASSING_THRESHOLD });

    return {
      message: `Review approved. Score: ${effectiveScore}%. Feedback saved. No credential issued (below ${PASSING_THRESHOLD}% threshold).`,
      submission: updatedSubmission,
      status: 'approved_no_credential',
      feedback
    };
  }

  // Score meets threshold — issue credential AND provide feedback
  log.info('Score meets threshold, issuing credential', { effectiveScore, threshold: PASSING_THRESHOLD });

  // Get student details
  const student = await getUser(submission.userId);
  if (!student) {
    throw new NotFoundError('Student');
  }

  // Get milestone details (problem info and BCdiploma template)
  const milestone = await getMilestone(submission.milestoneId);
  if (!milestone) {
    throw new NotFoundError('Milestone');
  }

  // Check if milestone has a BCdiploma template configured
  if (!milestone.bcdiplomaTemplateId) {
    throw new ValidationError('This problem does not have a BCdiploma template configured');
  }

  log.info('Pushing to BCdiploma', { submissionId });

  // Prepare certificate data for BCdiploma
  const certificateData = [{
    ID: submissionId,
    Email: student.email,
    language: 'en',
    firstName: student.name ? student.name.split(' ')[0] : student.email.split('@')[0],
    lastName: student.name ? student.name.split(' ').slice(1).join(' ') : '',
    obtentionDate: new Date().toISOString().split('T')[0],
    expirationDate: '',
    assessment: '',
    linkLabel: '',
    linkURL: ''
  }];

  log.info('Certificate data prepared for BCdiploma', { submissionId, recipientCount: certificateData.length });

  // Store custom metadata
  const customCredentialMetadata = {
    problemTitle: milestone.title,
    score: effectiveScore,
    originalScore: submission.score,
    passedTests: submission.testResults?.passed || 0,
    totalTests: submission.testResults?.total || 0,
    completionDate: new Date().toISOString().split('T')[0]
  };

  // Push to BCdiploma
  let pushResult;
  try {
    pushResult = await pushCertificate(
      milestone.bcdiplomaTemplateId,
      certificateData
    );

    log.info('BCdiploma push successful', { campaignId: pushResult.campaignId });

  } catch (bcdiplomaError) {
    log.error('BCdiploma Push API error', { error: bcdiplomaError.message });
    throw new ExternalServiceError('bcdiploma', `Failed to initiate credential issuance: ${bcdiplomaError.message}`);
  }

  const campaignId = pushResult.campaignId;

  // Update submission with campaign ID
  await updateSubmission(submissionId, {
    credentialAwarded: true,
    bcdiplomaCampaignId: campaignId,
    credentialMetadata: customCredentialMetadata
  });

  log.info('Review approved, credential pushed to BCdiploma', { submissionId, campaignId });
  log.info('Polling for certificate to be ready', { campaignId });

  // POLLING APPROACH: Wait and poll for certificate
  let pullResponse;
  try {
    // Poll with 2 attempts, 30 seconds apart = max 60 seconds wait
    pullResponse = await pollForCertificate(campaignId, 2, 30000);
  } catch (pollError) {
    log.error('Error polling for certificate', { error: pollError.message });

    // Certificate push succeeded but polling failed
    // Return partial success - admin can manually pull later
    return {
      message: 'Review approved and pushed to BCdiploma, but certificate is taking longer than expected to generate',
      submission: updatedSubmission,
      campaignId: campaignId,
      status: 'processing',
      note: 'Certificate is still being generated. It will be available shortly. You may need to refresh or check back in a minute.',
      error: pollError.message
    };
  }

  // Process the certificate
  try {
    if (!pullResponse.data || pullResponse.data.length === 0) {
      throw new Error('No certificate data in response');
    }

    const certificate = pullResponse.data[0]; // Should only be one certificate
    const savedCredential = await processCertificate(
      certificate,
      campaignId,
      submission,
      student,
      milestone,
      effectiveScore
    );

    log.info('Credential issued successfully', { submissionId, credentialId: savedCredential.credentialId });

    return {
      message: `Review approved. Credential issued. Score: ${effectiveScore}%.`,
      submission: {
        ...updatedSubmission,
        credentialIssued: true,
        credentialId: savedCredential.credentialId
      },
      credential: {
        credentialId: savedCredential.credentialId,
        certificateUrl: certificate.url,
        badgeUrl: certificate.badge,
        bcdiplomaKey: certificate.key
      },
      campaignId: campaignId,
      status: 'approved_credential_issued',
      feedback
    };

  } catch (processError) {
    log.error('Error processing certificate', { error: processError.message });

    return {
      message: 'Review approved and certificate generated, but error saving to database',
      campaignId: campaignId,
      status: 'generated_but_not_saved',
      error: processError.message,
      note: 'Certificate exists in BCdiploma but could not be saved. Contact support with Campaign ID: ' + campaignId
    };
  }
}

module.exports = { approveAndIssueCredential, ValidationError, ExternalServiceError };
