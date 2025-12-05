const { getSubmission, updateSubmission } = require('/opt/nodejs/db/submissions');
const { getUser } = require('/opt/nodejs/db/users');
const { getMilestone } = require('/opt/nodejs/db/milestones');
const { createCredential } = require('/opt/nodejs/db/credentials');
const { pullCertificate } = require('/opt/nodejs/utils/bcdiploma');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');

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
exports.handler = async (event) => {
  console.log('BCdiploma Webhook Event:', JSON.stringify(event, null, 2));
  
  try {
    // Extract campaignId from either GET or POST request
    let campaignId;
    
    if (event.httpMethod === 'GET') {
      // GET request: ?campaignId=XXX
      campaignId = event.queryStringParameters?.campaignId;
    } else if (event.httpMethod === 'POST') {
      // POST request: body contains { "id": "XXX", ... }
      const body = JSON.parse(event.body || '{}');
      campaignId = body.id || body.campaignId;
    }
    
    if (!campaignId) {
      console.error('No campaignId found in webhook request');
      return errorResponse(400, 'Missing campaignId');
    }
    
    console.log('Processing webhook for campaign:', campaignId);
    
    // Pull certificate data from BCdiploma
    const pullResponse = await pullCertificate(campaignId);
    
    if (!pullResponse.data || pullResponse.data.length === 0) {
      console.error('No certificate data returned for campaign:', campaignId);
      return errorResponse(404, 'No certificates found for this campaign');
    }
    
    // Process each certificate in the campaign
    const results = [];
    
    for (const certificate of pullResponse.data) {
      try {
        // The ID field contains our submissionId
        const submissionId = certificate.ID;
        
        console.log(`Processing certificate for submission: ${submissionId}`);
        
        // Get submission details
        const submission = await getSubmission(submissionId);
        if (!submission) {
          console.error(`Submission ${submissionId} not found`);
          results.push({ submissionId, status: 'error', message: 'Submission not found' });
          continue;
        }
        
        // Check if credential already exists
        if (submission.credentialIssued) {
          console.log(`Credential already issued for submission ${submissionId}, skipping`);
          results.push({ submissionId, status: 'skipped', message: 'Credential already issued' });
          continue;
        }
        
        // Get student and milestone details
        const student = await getUser(submission.userId);
        const milestone = await getMilestone(submission.milestoneId);
        
        if (!student || !milestone) {
          console.error(`Student or milestone not found for submission ${submissionId}`);
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
        
        console.log(`✓ Credential issued for submission ${submissionId}`);
        results.push({ 
          submissionId, 
          status: 'success', 
          credentialId: savedCredential.credentialId,
          certificateUrl: certificate.url
        });
        
      } catch (error) {
        console.error(`Error processing certificate for submission ${certificate.ID}:`, error);
        results.push({ 
          submissionId: certificate.ID, 
          status: 'error', 
          message: error.message 
        });
      }
    }
    
    console.log('Webhook processing complete:', results);
    
    // Return 200 OK to BCdiploma
    return successResponse(200, {
      message: 'Webhook processed successfully',
      campaignId: campaignId,
      processedCount: results.length,
      results: results
    });
    
  } catch (error) {
    console.error('Error processing BCdiploma webhook:', error);
    
    // Still return 200 to prevent BCdiploma from retrying
    // Log the error for investigation
    return successResponse(200, {
      message: 'Webhook received but processing failed',
      error: error.message
    });
  }
};