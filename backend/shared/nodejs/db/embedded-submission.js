const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

/**
 * Create an embedded assessment submission
 * @param {object} data - Submission data
 * @returns {Promise<object>} Created submission
 */
async function createEmbeddedSubmission(data) {
  const submissionId = data.submissionId || `esub_${Date.now()}_${data.userId}`;

  const params = {
    TableName: process.env.SUBMISSIONS_TABLE,
    Item: {
      submissionId,
      userId: data.userId,
      milestoneId: data.milestoneId,
      userMilestoneKey: `${data.userId}#${data.milestoneId}`,
      type: 'embedded',
      gradingType: 'llm',
      code: data.code,
      rubricResults: data.rubricResults || [],
      passedCriteria: data.passedCriteria || 0,
      totalCriteria: data.totalCriteria || 0,
      score: data.score || 0,
      passed: data.passed || false,
      status: data.passed ? 'passed' : 'failed',
      llmModel: data.llmModel || null,
       proctoringData: {
        reviewStatus: 'pending'
      },
      submittedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      credentialIssued: false,
      credentialId: null
    }
  };

  await dynamodb.send(new PutCommand(params));
  return params.Item;
}

/**
 * Get an embedded submission by ID
 * @param {string} submissionId - Submission ID
 * @returns {Promise<object|null>} Submission or null
 */
async function getEmbeddedSubmission(submissionId) {
  const params = {
    TableName: process.env.SUBMISSIONS_TABLE,
    Key: { submissionId }
  };

  const result = await dynamodb.send(new GetCommand(params));
  return result.Item || null;
}

/**
 * Get all embedded submissions for an assessment
 * @param {string} milestoneId - Assessment ID
 * @param {number} limit - Max results
 * @returns {Promise<Array>} Array of submissions
 */
async function getSubmissionsByAssessment(milestoneId, limit = 50) {
  const params = {
    TableName: process.env.SUBMISSIONS_TABLE,
    IndexName: 'MilestoneIdIndex',
    KeyConditionExpression: 'milestoneId = :milestoneId',
    FilterExpression: '#type = :type',
    ExpressionAttributeNames: { '#type': 'type' },
    ExpressionAttributeValues: {
      ':milestoneId': milestoneId,
      ':type': 'embedded'
    },
    Limit: limit,
    ScanIndexForward: false
  };

  const result = await dynamodb.send(new QueryCommand(params));
  return result.Items || [];
}

/**
 * Get a user's submissions for a specific embedded assessment
 * @param {string} userId - User ID
 * @param {string} milestoneId - Assessment ID
 * @param {number} limit - Max results
 * @returns {Promise<Array>} Array of submissions
 */
async function getUserSubmissionsForAssessment(userId, milestoneId, limit = 10) {
  const params = {
    TableName: process.env.SUBMISSIONS_TABLE,
    IndexName: 'UserMilestoneIndex',
    KeyConditionExpression: 'userMilestoneKey = :userMilestoneKey',
    FilterExpression: '#type = :type',
    ExpressionAttributeNames: { '#type': 'type' },
    ExpressionAttributeValues: {
      ':userMilestoneKey': `${userId}#${milestoneId}`,
      ':type': 'embedded'
    },
    Limit: limit,
    ScanIndexForward: false
  };

  const result = await dynamodb.send(new QueryCommand(params));
  return result.Items || [];
}

/**
 * Update submission credential status after BCdiploma issues
 * @param {string} submissionId - Submission ID
 * @param {string} credentialId - BCdiploma credential ID
 * @returns {Promise<object>} Updated submission
 */
async function updateCredentialStatus(submissionId, credentialId) {
  const params = {
    TableName: process.env.SUBMISSIONS_TABLE,
    Key: { submissionId },
    UpdateExpression: 'SET credentialIssued = :issued, credentialId = :credId, updatedAt = :updatedAt',
    ExpressionAttributeValues: {
      ':issued': true,
      ':credId': credentialId,
      ':updatedAt': new Date().toISOString()
    },
    ReturnValues: 'ALL_NEW'
  };

  const result = await dynamodb.send(new UpdateCommand(params));
  return result.Attributes;
}

/**
 * Update submission score (used when admin overrides LLM score)
 * @param {string} submissionId - Submission ID
 * @param {number} adjustedScore - Admin-adjusted score
 * @param {string} reviewedBy - Admin user ID
 * @param {string} reviewNotes - Optional review notes
 * @returns {Promise<object>} Updated submission
 */
async function updateAdjustedScore(submissionId, adjustedScore, reviewedBy, reviewNotes = '') {
  const params = {
    TableName: process.env.SUBMISSIONS_TABLE,
    Key: { submissionId },
    UpdateExpression: 'SET score = :score, proctoringData.adjustedScore = :adjustedScore, proctoringData.reviewedBy = :reviewedBy, proctoringData.reviewNotes = :reviewNotes, proctoringData.reviewedAt = :reviewedAt, updatedAt = :updatedAt',
    ExpressionAttributeValues: {
      ':score': adjustedScore,
      ':adjustedScore': adjustedScore,
      ':reviewedBy': reviewedBy,
      ':reviewNotes': reviewNotes,
      ':reviewedAt': new Date().toISOString(),
      ':updatedAt': new Date().toISOString()
    },
    ReturnValues: 'ALL_NEW'
  };

  const result = await dynamodb.send(new UpdateCommand(params));
  return result.Attributes;
}

module.exports = {
  createEmbeddedSubmission,
  getEmbeddedSubmission,
  getSubmissionsByAssessment,
  getUserSubmissionsForAssessment,
  updateCredentialStatus,
  updateAdjustedScore
};