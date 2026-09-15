const crypto = require('crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

/**
 * Create a new credential in DynamoDB
 * @param {object} credentialData - The credential data
 * @returns {object} The created credential
 */
async function createCredential(credentialData) {
  const params = {
    TableName: process.env.CREDENTIALS_TABLE,
    Item: {
      credentialId: credentialData.credentialId || `cred_${crypto.randomUUID()}`,
      userId: credentialData.userId,
      milestoneId: credentialData.milestoneId,
      submissionId: credentialData.submissionId,
      
      // BCdiploma data
      bcdiplomaKey: credentialData.bcdiplomaKey, // Unique key from BCdiploma
      bcdiplomaUrl: credentialData.bcdiplomaUrl, // Certificate viewing URL
      bcdiplomaBadgeUrl: credentialData.bcdiplomaBadgeUrl || null, // Badge URL if available
      bcdiplomaTemplateId: credentialData.bcdiplomaTemplateId, // Template used
      bcdiplomaCampaignId: credentialData.bcdiplomaCampaignId, // Campaign ID for tracking
      
      // Credential details
      issuedAt: credentialData.issuedAt || new Date().toISOString(),
      expiresAt: null, // Lifelong credential
      
      // Metadata
      recipientName: credentialData.recipientName, // Full name
      recipientEmail: credentialData.recipientEmail,
      problemTitle: credentialData.problemTitle,
      score: credentialData.score,
      
      // Status
      status: credentialData.status || 'issued', // issued, revoked
      revokedAt: null,
      revokedReason: null,
      
      // Timestamps
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  };
  
  await dynamodb.send(new PutCommand(params));
  return params.Item;
}

/**
 * Get a credential by credentialId
 * @param {string} credentialId - The credential ID
 * @returns {object|null} The credential data or null if not found
 */
async function getCredential(credentialId) {
  const params = {
    TableName: process.env.CREDENTIALS_TABLE,
    Key: { credentialId }
  };
  
  const result = await dynamodb.send(new GetCommand(params));
  return result.Item;
}

/**
 * Get all credentials for a user
 * @param {string} userId - The user ID
 * @param {number} limit - Maximum number of results (default: 50)
 * @returns {Array} Array of credentials
 */
async function getCredentialsByUser(userId, limit = 50) {
  const params = {
    TableName: process.env.CREDENTIALS_TABLE,
    IndexName: 'UserIdIndex',
    KeyConditionExpression: 'userId = :userId',
    ExpressionAttributeValues: {
      ':userId': userId
    },
    Limit: limit,
    ScanIndexForward: false // Sort by issue date descending (newest first)
  };
  
  const result = await dynamodb.send(new QueryCommand(params));
  return result.Items || [];
}

/**
 * Get credential by submission ID
 * @param {string} submissionId - The submission ID
 * @returns {object|null} The credential or null if not found
 */
async function getCredentialBySubmissionId(submissionId) {
  const params = {
    TableName: process.env.CREDENTIALS_TABLE,
    IndexName: 'SubmissionIdIndex',
    KeyConditionExpression: 'submissionId = :submissionId',
    ExpressionAttributeValues: {
      ':submissionId': submissionId
    },
    Limit: 1
  };
  
  const result = await dynamodb.send(new QueryCommand(params));
  return result.Items && result.Items.length > 0 ? result.Items[0] : null;
}

/**
 * Update credential status (e.g., revoke)
 * @param {string} credentialId - The credential ID
 * @param {object} updates - The fields to update
 * @returns {object} The updated credential
 */
async function updateCredential(credentialId, updates) {
  const updateExpressions = [];
  const expressionAttributeNames = {};
  const expressionAttributeValues = {};
  
  if (updates.status !== undefined) {
    updateExpressions.push('#status = :status');
    expressionAttributeNames['#status'] = 'status';
    expressionAttributeValues[':status'] = updates.status;
  }
  
  if (updates.revokedAt !== undefined) {
    updateExpressions.push('revokedAt = :revokedAt');
    expressionAttributeValues[':revokedAt'] = updates.revokedAt;
  }
  
  if (updates.revokedReason !== undefined) {
    updateExpressions.push('revokedReason = :revokedReason');
    expressionAttributeValues[':revokedReason'] = updates.revokedReason;
  }
  
  // Always update the updatedAt timestamp
  updateExpressions.push('updatedAt = :updatedAt');
  expressionAttributeValues[':updatedAt'] = new Date().toISOString();
  
  const params = {
    TableName: process.env.CREDENTIALS_TABLE,
    Key: { credentialId },
    UpdateExpression: `SET ${updateExpressions.join(', ')}`,
    ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0 
      ? expressionAttributeNames 
      : undefined,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: 'ALL_NEW'
  };
  
  const result = await dynamodb.send(new UpdateCommand(params));
  return result.Attributes;
}

/**
 * Check if a credential exists for a submission
 * @param {string} submissionId - The submission ID
 * @returns {boolean} True if credential exists
 */
async function credentialExistsForSubmission(submissionId) {
  const credential = await getCredentialBySubmissionId(submissionId);
  return credential !== null;
}

module.exports = {
  createCredential,
  getCredential,
  getCredentialsByUser,
  getCredentialBySubmissionId,
  updateCredential,
  credentialExistsForSubmission
};