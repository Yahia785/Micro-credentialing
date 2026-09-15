const crypto = require('crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { buildUpdateExpression } = require('./dynamo-utils');

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

/**
 * Create a new submission in DynamoDB
 * @param {object} submissionData - The submission data
 * @returns {object} The created submission
 */
async function createSubmission(submissionData) {
  const params = {
    TableName: process.env.SUBMISSIONS_TABLE,
    Item: {
      submissionId: submissionData.submissionId || `sub_${crypto.randomUUID()}`,
      userId: submissionData.userId,
      studentEmail: submissionData.studentEmail || null,
      studentName: submissionData.studentName || null,
      milestoneId: submissionData.milestoneId,
      userMilestoneKey: `${submissionData.userId}#${submissionData.milestoneId}`,
      code: submissionData.code,
      language: submissionData.language,
      status: submissionData.status || 'pending',
      passedTests: 0,
      totalTests: 0,
      score: 0,
      testResults: [],
      submittedAt: submissionData.submittedAt || new Date().toISOString(),
      completedAt: null,
      credentialAwarded: false,
      // NEW: Track if credential has been issued via BCdiploma
      credentialIssued: false,
      credentialId: null,
      totalExecutionTime: 0,
      averageExecutionTime: 0,
      maxExecutionTime: 0,
      totalMemory: 0,
      averageMemory: 0,
      maxMemory: 0
    }
  };
  
  await dynamodb.send(new PutCommand(params));
  return params.Item;
}

/**
 * Get a submission by submissionId
 * @param {string} submissionId - The submission ID
 * @returns {object|null} The submission data or null if not found
 */
async function getSubmission(submissionId) {
  const params = {
    TableName: process.env.SUBMISSIONS_TABLE,
    Key: { submissionId }
  };
  
  const result = await dynamodb.send(new GetCommand(params));
  return result.Item;
}

/**
 * Get all submissions by a user
 * @param {string} userId - The user ID
 * @param {number} limit - Maximum number of results (default: 20)
 * @returns {Array} Array of submissions
 */
async function getSubmissionsByUser(userId, limit = 20) {
  const params = {
    TableName: process.env.SUBMISSIONS_TABLE,
    IndexName: 'UserIdIndex',
    KeyConditionExpression: 'userId = :userId',
    ExpressionAttributeValues: {
      ':userId': userId
    },
    Limit: limit,
    ScanIndexForward: false // Sort by submission date descending (newest first)
  };
  
  const result = await dynamodb.send(new QueryCommand(params));
  return result.Items || [];
}

/**
 * Get all submissions for a milestone
 * @param {string} milestoneId - The milestone ID
 * @param {number} limit - Maximum number of results (default: 50)
 * @returns {Array} Array of submissions
 */
async function getSubmissionsByMilestone(milestoneId, limit = 50) {
  const params = {
    TableName: process.env.SUBMISSIONS_TABLE,
    IndexName: 'MilestoneIdIndex',
    KeyConditionExpression: 'milestoneId = :milestoneId',
    ExpressionAttributeValues: {
      ':milestoneId': milestoneId
    },
    Limit: limit,
    ScanIndexForward: false
  };
  
  const result = await dynamodb.send(new QueryCommand(params));
  return result.Items || [];
}

/**
 * Get a user's submissions for a specific milestone
 * @param {string} userId - The user ID
 * @param {string} milestoneId - The milestone ID
 * @param {number} limit - Maximum number of results (default: 10)
 * @returns {Array} Array of submissions
 */
async function getUserSubmissionsForMilestone(userId, milestoneId, limit = 10) {
  const params = {
    TableName: process.env.SUBMISSIONS_TABLE,
    IndexName: 'UserMilestoneIndex',
    KeyConditionExpression: 'userMilestoneKey = :userMilestoneKey',
    ExpressionAttributeValues: {
      ':userMilestoneKey': `${userId}#${milestoneId}`
    },
    Limit: limit,
    ScanIndexForward: false
  };
  
  const result = await dynamodb.send(new QueryCommand(params));
  return result.Items || [];
}

/**
 * Update a submission
 * @param {string} submissionId - The submission ID
 * @param {object} updates - The fields to update
 * @returns {object} The updated submission
 */
async function updateSubmission(submissionId, updates) {
  const params = {
    TableName: process.env.SUBMISSIONS_TABLE,
    Key: { submissionId },
    ...buildUpdateExpression(updates),
    ReturnValues: 'ALL_NEW'
  };
  const result = await dynamodb.send(new UpdateCommand(params));
  return result.Attributes;
}

/**
 * Update submission with Judge0 results
 * @param {string} submissionId - The submission ID
 * @param {string} status - The submission status ('passed', 'failed', 'error')
 * @param {object} results - The test results and metrics
 * @returns {object} The updated submission
 */
async function updateSubmissionStatus(submissionId, status, results) {
  const updates = {
    status: status,
    completedAt: new Date().toISOString(),
    passedTests: results.passedTests || 0,
    totalTests: results.totalTests || 0,
    score: results.score || 0,
    testResults: results.testResults || [],
    totalExecutionTime: results.totalExecutionTime || 0,
    averageExecutionTime: results.averageExecutionTime || 0,
    maxExecutionTime: results.maxExecutionTime || 0,
    totalMemory: results.totalMemory || 0,
    averageMemory: results.averageMemory || 0,
    maxMemory: results.maxMemory || 0
  };
  
  return await updateSubmission(submissionId, updates);
}

module.exports = {
  createSubmission,
  getSubmission,
  getSubmissionsByUser,
  getSubmissionsByMilestone,
  getUserSubmissionsForMilestone,
  updateSubmission,
  updateSubmissionStatus
};