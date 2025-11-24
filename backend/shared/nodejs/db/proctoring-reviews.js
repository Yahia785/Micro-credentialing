const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

/**
 * Get submissions pending review (passed tests but not yet reviewed)
 * @param {number} limit - Maximum number of results
 * @returns {Array} Array of submissions pending review
 */
async function getPendingReviews(limit = 50) {
  const params = {
    TableName: process.env.SUBMISSIONS_TABLE,
    FilterExpression: '#status = :passed AND (attribute_not_exists(proctoringData.reviewStatus) OR proctoringData.reviewStatus = :pending)',
    ExpressionAttributeNames: {
      '#status': 'status'
    },
    ExpressionAttributeValues: {
      ':passed': 'passed',
      ':pending': 'pending'
    },
    Limit: limit
  };
  
  const result = await dynamodb.send(new ScanCommand(params));
  return result.Items || [];
}

/**
 * Get reviewed submissions (approved or rejected)
 * @param {number} limit - Maximum number of results
 * @returns {Array} Array of reviewed submissions
 */
async function getReviewedSubmissions(limit = 50) {
  const params = {
    TableName: process.env.SUBMISSIONS_TABLE,
    FilterExpression: 'proctoringData.reviewStatus IN (:approved, :rejected)',
    ExpressionAttributeValues: {
      ':approved': 'approved',
      ':rejected': 'rejected'
    },
    Limit: limit
  };
  
  const result = await dynamodb.send(new ScanCommand(params));
  return result.Items || [];
}

/**
 * Approve a submission's proctoring review
 * @param {string} submissionId - The submission ID
 * @param {string} reviewedBy - The admin's user ID
 * @param {string} reviewNotes - Optional review notes
 * @returns {object} The updated submission
 */
async function approveReview(submissionId, reviewedBy, reviewNotes = '') {
  const params = {
    TableName: process.env.SUBMISSIONS_TABLE,
    Key: { submissionId },
    UpdateExpression: 'SET proctoringData.reviewStatus = :approved, proctoringData.reviewedBy = :reviewedBy, proctoringData.reviewedAt = :reviewedAt, proctoringData.reviewNotes = :reviewNotes, updatedAt = :updatedAt',
    ExpressionAttributeValues: {
      ':approved': 'approved',
      ':reviewedBy': reviewedBy,
      ':reviewedAt': new Date().toISOString(),
      ':reviewNotes': reviewNotes,
      ':updatedAt': new Date().toISOString()
    },
    ReturnValues: 'ALL_NEW'
  };
  
  const result = await dynamodb.send(new UpdateCommand(params));
  return result.Attributes;
}

/**
 * Reject a submission's proctoring review
 * @param {string} submissionId - The submission ID
 * @param {string} reviewedBy - The admin's user ID
 * @param {string} rejectionReason - Reason for rejection
 * @returns {object} The updated submission
 */
async function rejectReview(submissionId, reviewedBy, rejectionReason) {
  const params = {
    TableName: process.env.SUBMISSIONS_TABLE,
    Key: { submissionId },
    UpdateExpression: 'SET proctoringData.reviewStatus = :rejected, proctoringData.reviewedBy = :reviewedBy, proctoringData.reviewedAt = :reviewedAt, proctoringData.reviewNotes = :rejectionReason, #status = :failed, updatedAt = :updatedAt',
    ExpressionAttributeNames: {
      '#status': 'status'
    },
    ExpressionAttributeValues: {
      ':rejected': 'rejected',
      ':reviewedBy': reviewedBy,
      ':reviewedAt': new Date().toISOString(),
      ':rejectionReason': rejectionReason,
      ':failed': 'failed',
      ':updatedAt': new Date().toISOString()
    },
    ReturnValues: 'ALL_NEW'
  };
  
  const result = await dynamodb.send(new UpdateCommand(params));
  return result.Attributes;
}

module.exports = {
  getPendingReviews,
  getReviewedSubmissions,
  approveReview,
  rejectReview
};