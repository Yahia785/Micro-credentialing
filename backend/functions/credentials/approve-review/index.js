const { approveReview } = require('/opt/nodejs/db/proctoring-reviews');
const { getUser } = require('/opt/nodejs/db/users');
const { getSubmission, updateSubmission } = require('/opt/nodejs/db/submissions');
const { getMilestone } = require('/opt/nodejs/db/milestones');
const { pushCertificate } = require('/opt/nodejs/utils/bcdiploma');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Approve Proctoring Review and Initiate BCdiploma Credential
 * Endpoint: POST /credentials/approve-review
 * Authorization: Admin only
 * 
 * This marks the submission as approved and initiates BCdiploma credential issuance.
 * The webhook will complete the process when BCdiploma finishes processing.
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
    
    // Prepare certificate data for BCdiploma - MUST match BCdiploma template exactly
    const certificateData = [{
      // Required fields - must match BCdiploma documentation example
      ID: submissionId, // Unique identifier - CRITICAL for webhook to find this submission
      Email: student.email,
      language: 'en',
      firstName: student.name ? student.name.split(' ')[0] : student.email.split('@')[0],
      lastName: student.name ? student.name.split(' ').slice(1).join(' ') : '',
      obtentionDate: new Date().toISOString().split('T')[0], // YYYY-MM-DD format
      expirationDate: '', // Empty string for lifelong credential (not null)
      
      // Optional fields - can be empty strings
      assessment: '', // You can populate this with milestone.title if needed
      linkLabel: '', // e.g., "View Solution" 
      linkURL: '' // e.g., link to student's solution
    }];
    
    console.log('Certificate data (BCdiploma format):', JSON.stringify(certificateData, null, 2));
    
    // Store custom fields in your database (NOT sent to BCdiploma)
    const customCredentialMetadata = {
      problemTitle: milestone.title,
      score: submission.score || 0,
      passedTests: submission.testResults?.passed || 0,
      totalTests: submission.testResults?.total || 0,
      completionDate: new Date().toISOString().split('T')[0]
    };
    
    console.log('Custom metadata (will be stored in DB):', JSON.stringify(customCredentialMetadata, null, 2));
    
    // Push to BCdiploma (webhook will complete the process)
    let pushResult;
    try {
      pushResult = await pushCertificate(
        milestone.bcdiplomaTemplateId,
        certificateData
        // No options needed - notes and notification added automatically as empty strings
      );
      
      console.log('✓ BCdiploma Push successful. Campaign ID:', pushResult.campaignId);
      
    } catch (bcdiplomaError) {
      console.error('BCdiploma Push API error:', bcdiplomaError);
      
      // Return error - don't mark as approved if BCdiploma failed
      return errorResponse(500, 'Failed to initiate credential issuance', bcdiplomaError.message);
    }
    
    // Mark submission as credential awarded (pending webhook completion)
    // Store custom metadata here for later retrieval
    await updateSubmission(submissionId, {
      credentialAwarded: true,
      bcdiplomaCampaignId: pushResult.campaignId,
      // Store custom metadata in submission record
      credentialMetadata: customCredentialMetadata
    });
    
    console.log('✓ Review approved, credential pushed to BCdiploma');
    console.log('⏳ Waiting for webhook to complete credential issuance...');
    
    // Return success immediately - webhook will save the credential
    return successResponse(200, {
      message: 'Review approved successfully. Certificate is being generated and will be available shortly.',
      submission: updatedSubmission,
      campaignId: pushResult.campaignId,
      status: 'processing',
      note: 'The webhook will save the credential when BCdiploma finishes processing (typically 5-10 seconds)'
    });
    
  } catch (error) {
    console.error('Error in approve-review handler:', error);
    return errorResponse(500, 'Failed to approve review', error.message);
  }
};