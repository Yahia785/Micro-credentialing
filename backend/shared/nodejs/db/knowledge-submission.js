const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

/**
 * Create a knowledge submission
 */
async function createKnowledgeSubmission(data) {
  const submissionId = data.submissionId || `ksub_${Date.now()}_${data.userId}`;
  
  const params = {
    TableName: process.env.SUBMISSIONS_TABLE,
    Item: {
      submissionId,
      userId: data.userId,
      milestoneId: data.milestoneId,
      userMilestoneKey: `${data.userId}#${data.milestoneId}`,
      type: 'knowledge',
      answers: data.answers || [],
      results: data.results || [],
      totalScore: data.totalScore || 0,
      maxScore: data.maxScore || 0,
      percentage: data.percentage || 0,
      passed: data.passed || false,
      status: data.passed ? 'passed' : 'failed',
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
 * Get a knowledge submission by ID
 */
async function getKnowledgeSubmission(submissionId) {
  const params = {
    TableName: process.env.SUBMISSIONS_TABLE,
    Key: { submissionId }
  };
  
  const result = await dynamodb.send(new GetCommand(params));
  return result.Item;
}

/**
 * Get all knowledge submissions for an assessment
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
      ':type': 'knowledge'
    },
    Limit: limit,
    ScanIndexForward: false
  };
  
  const result = await dynamodb.send(new QueryCommand(params));
  return result.Items || [];
}

/**
 * Get user's submissions for a knowledge assessment
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
      ':type': 'knowledge'
    },
    Limit: limit,
    ScanIndexForward: false
  };
  
  const result = await dynamodb.send(new QueryCommand(params));
  return result.Items || [];
}

/**
 * Update submission credential status
 */
async function updateCredentialStatus(submissionId, credentialId) {
  const params = {
    TableName: process.env.SUBMISSIONS_TABLE,
    Key: { submissionId },
    UpdateExpression: 'SET credentialIssued = :issued, credentialId = :credId',
    ExpressionAttributeValues: {
      ':issued': true,
      ':credId': credentialId
    },
    ReturnValues: 'ALL_NEW'
  };
  
  const result = await dynamodb.send(new UpdateCommand(params));
  return result.Attributes;
}

module.exports = {
  createKnowledgeSubmission,
  getKnowledgeSubmission,
  getSubmissionsByAssessment,
  getUserSubmissionsForAssessment,
  updateCredentialStatus
};