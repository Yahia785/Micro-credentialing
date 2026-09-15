const { getSubmission, updateSubmission } = require('/opt/nodejs/db/submissions');
const { getUser } = require('/opt/nodejs/db/users');
const { getMilestone } = require('/opt/nodejs/db/milestones');
const { createCredential } = require('/opt/nodejs/db/credentials');
const { pullCertificate } = require('/opt/nodejs/utils/bcdiploma');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: BCdiploma Webhook Receiver
 * Endpoint: POST /webhooks/bcdiploma-notification
 *
 * BCdiploma calls this endpoint when certificate processing is complete
 *
 * Request formats:
 * - GET: ?campaignId=XXX
 * - POST: { "id": "XXX", "from": "BCdiploma", "operation": "CAMPAIGN-NOTIFICATION" }
 */
exports.handler = withHandler(async (ctx) => {
  const event = ctx.event;

  try {
    // Extract campaignId from either GET or POST request
    let campaignId;

    if (event.httpMethod === 'GET') {
      // GET request: ?campaignId=XXX
      campaignId = ctx.queryParams?.campaignId;
    } else if (event.httpMethod === 'POST') {
      // POST request: body contains { "id": "XXX", ... }
      const body = ctx.body;
      campaignId = body.id || body.campaignId;
    }

    if (!campaignId) {
      return successResponse(200, {
        message: 'Webhook received but no campaignId provided',
        error: 'Missing campaignId parameter'
      });
    }

    log.info('Processing webhook', { campaignId });

    // Pull certificate data from BCdiploma
    const pullResponse = await pullCertificate(campaignId);

    if (!pullResponse.data || pullResponse.data.length === 0) {
      log.error('No certificate data returned for campaign', { campaignId });
      return errorResponse(404, 'No certificates found for this campaign');
    }

    // Process each certificate in the campaign
    const results = [];

    for (const certificate of pullResponse.data) {
      try {
        // The ID field contains our submissionId
        const submissionId = certificate.ID;

        log.info('Processing certificate', { submissionId });

        // Get submission details
        const submission = await getSubmission(submissionId);
        if (!submission) {
          log.error('Submission not found', { submissionId });
          results.push({ submissionId, status: 'error', message: 'Submission not found' });
          continue;
        }

        // Check if credential already exists
        if (submission.credentialIssued) {
          log.info('Credential already issued, skipping', { submissionId });
          results.push({ submissionId, status: 'skipped', message: 'Credential already issued' });
          continue;
        }

        // Get student and milestone details
        const student = await getUser(submission.userId);
        const milestone = await getMilestone(submission.milestoneId);

        if (!student || !milestone) {
          log.error('Student or milestone not found', { submissionId });
          results.push({ submissionId, status: 'error', message: 'Student or milestone not found' });
          continue;
        }

        // Save credential to database
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
          score: submission.score || 0,
          status: 'issued'
        };

        const savedCredential = await createCredential(credentialData);

        // Mark submission as having credential issued
        await updateSubmission(submissionId, {
          credentialIssued: true,
          credentialId: savedCredential.credentialId
        });

        log.info('Credential issued', { submissionId });
        results.push({
          submissionId,
          status: 'success',
          credentialId: savedCredential.credentialId,
          certificateUrl: certificate.url
        });

      } catch (error) {
        log.error('Error processing certificate', { submissionId: certificate.ID, error: error.message });
        results.push({
          submissionId: certificate.ID,
          status: 'error',
          message: error.message
        });
      }
    }

    log.info('Webhook processing complete', { results });

    // Return 200 OK to BCdiploma
    return successResponse(200, {
      message: 'Webhook processed successfully',
      campaignId: campaignId,
      processedCount: results.length,
      results: results
    });

  } catch (error) {
    log.error('Error processing BCdiploma webhook', { error: error.message });

    // Still return 200 to prevent BCdiploma from retrying
    // Log the error for investigation
    return successResponse(200, {
      message: 'Webhook received but processing failed',
      error: error.message
    });
  }
}, { public: true });
