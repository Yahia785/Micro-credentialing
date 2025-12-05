const { approveReview } = require('/opt/nodejs/db/proctoring-reviews');
const { getUser } = require('/opt/nodejs/db/users');
const { getSubmission, updateSubmission } = require('/opt/nodejs/db/submissions');
const { getMilestone } = require('/opt/nodejs/db/milestones');
const { pushCertificate, pullCertificate } = require('/opt/nodejs/utils/bcdiploma');
const { createCredential } = require('/opt/nodejs/db/credentials');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');

/**
 * Utility function to wait/sleep
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Poll BCdiploma for certificate with retries
 */
async function pollForCertificate(campaignId, maxAttempts = 6, delayMs = 5000) {
  console.log(`Starting to poll for campaign ${campaignId}, max attempts: ${maxAttempts}`);
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`Poll attempt ${attempt}/${maxAttempts} for campaign ${campaignId}`);
    
    try {
      const pullResponse = await pullCertificate(campaignId);
      
      if (pullResponse.data && pullResponse.data.length > 0) {
        console.log(`✓ Certificate ready after ${attempt} attempts`);
        return pullResponse;
      }
      
      console.log(`Certificate not ready yet, waiting ${delayMs}ms...`);
      
      // Don't wait after last attempt
      if (attempt < maxAttempts) {
        await sleep(delayMs);
      }
      
    } catch (error) {
      console.error(`Error polling attempt ${attempt}:`, error.message);
      
      // If 404, certificate might still be processing
      if (error.message.includes('404') || error.message.includes('not found')) {
        console.log(`Certificate still processing, waiting ${delayMs}ms...`);
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
async function processCertificate(certificate, campaignId, submission, student, milestone) {
  const submissionId = certificate.ID;
  
  console.log(`Processing certificate for submission: ${submissionId}`);
  
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
    score: submission.score || 0,
    status: 'issued'
  };
  
  const savedCredential = await createCredential(credentialData);
  
  console.log(`Credential created:`, {
    credentialId: savedCredential.credentialId,
    certificateUrl: certificate.url,
    bcdiplomaKey: certificate.key
  });
  
  // Update submission
  await updateSubmission(submissionId, {
    credentialIssued: true,
    credentialId: savedCredential.credentialId
  });
  
  console.log(`✓ Credential issued for submission ${submissionId}`);
  
  return savedCredential;
}

/**
 * Lambda Handler: Approve Proctoring Review and Issue Credential (WITH POLLING)
 * Endpoint: POST /credentials/approve-review
 * Authorization: Admin only
 * 
 * This marks the submission as approved, pushes to BCdiploma, 
 * then POLLS until certificate is ready and saves it immediately.
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  try {
    // Get userId from JWT token
    const authenticatedUserId = event.requestContext?.authorizer?.claims?.sub;
    
    if (!authenticatedUserId) {
      return errorResponse(401, 'Unauthorized');
    }
    
    // Check if user is admin
    const adminUser = await getUser(authenticatedUserId);
    if (!adminUser || adminUser.role !== 'admin') {
      return errorResponse(403, 'Forbidden: Admin access required');
    }
    
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { submissionId, reviewNotes } = body;
    
    if (!submissionId) {
      return errorResponse(400, 'submissionId is required');
    }
    
    console.log('Approving review for submission:', submissionId);
    
    // Get submission details
    const submission = await getSubmission(submissionId);
    if (!submission) {
      return errorResponse(404, 'Submission not found');
    }
    
    // Verify submission is eligible for approval (passed tests)
    if (submission.status !== 'passed') {
      return errorResponse(400, 'Can only approve submissions that passed all tests');
    }
    
    // Check if credential already issued
    if (submission.credentialIssued) {
      return errorResponse(400, 'Credential has already been issued for this submission');
    }
    
    // Get student details
    const student = await getUser(submission.userId);
    if (!student) {
      return errorResponse(404, 'Student not found');
    }
    
    // Get milestone details (problem info and BCdiploma template)
    const milestone = await getMilestone(submission.milestoneId);
    if (!milestone) {
      return errorResponse(404, 'Milestone not found');
    }
    
    // Check if milestone has a BCdiploma template configured
    if (!milestone.bcdiplomaTemplateId) {
      return errorResponse(400, 'This problem does not have a BCdiploma template configured');
    }
    
    // Approve the review in database
    const updatedSubmission = await approveReview(
      submissionId,
      authenticatedUserId,
      reviewNotes || 'Approved by admin'
    );
    
    console.log('Review approved in database. Now pushing to BCdiploma...');
    
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
    
    console.log('Certificate data (BCdiploma format):', JSON.stringify(certificateData, null, 2));
    
    // Store custom metadata
    const customCredentialMetadata = {
      problemTitle: milestone.title,
      score: submission.score || 0,
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
      
      console.log('✓ BCdiploma Push successful. Campaign ID:', pushResult.campaignId);
      
    } catch (bcdiplomaError) {
      console.error('BCdiploma Push API error:', bcdiplomaError);
      return errorResponse(500, 'Failed to initiate credential issuance', bcdiplomaError.message);
    }
    
    const campaignId = pushResult.campaignId;
    
    // Update submission with campaign ID
    await updateSubmission(submissionId, {
      credentialAwarded: true,
      bcdiplomaCampaignId: campaignId,
      credentialMetadata: customCredentialMetadata
    });
    
    console.log('✓ Review approved, credential pushed to BCdiploma');
    console.log('⏳ Now polling for certificate to be ready...');
    
    // POLLING APPROACH: Wait and poll for certificate
    let pullResponse;
    try {
      // Poll with 6 attempts, 5 seconds apart = max 30 seconds wait
      pullResponse = await pollForCertificate(campaignId, 2, 30000);
    } catch (pollError) {
      console.error('Error polling for certificate:', pollError);
      
      // Certificate push succeeded but polling failed
      // Return partial success - admin can manually pull later
      return successResponse(200, {
        message: 'Review approved and pushed to BCdiploma, but certificate is taking longer than expected to generate',
        submission: updatedSubmission,
        campaignId: campaignId,
        status: 'processing',
        note: 'Certificate is still being generated. It will be available shortly. You may need to refresh or check back in a minute.',
        error: pollError.message
      });
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
        milestone
      );
      
      console.log('✓✓✓ Complete! Credential issued successfully');
      
      return successResponse(200, {
        message: 'Review approved and credential issued successfully!',
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
        status: 'completed'
      });
      
    } catch (processError) {
      console.error('Error processing certificate:', processError);
      
      return successResponse(200, {
        message: 'Review approved and certificate generated, but error saving to database',
        campaignId: campaignId,
        status: 'generated_but_not_saved',
        error: processError.message,
        note: 'Certificate exists in BCdiploma but could not be saved. Contact support with Campaign ID: ' + campaignId
      });
    }
    
  } catch (error) {
    console.error('Error in approve-review handler:', error);
    return errorResponse(500, 'Failed to approve review', error.message);
  }
};