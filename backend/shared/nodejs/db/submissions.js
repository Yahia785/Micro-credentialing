const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');

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
      submissionId: submissionData.submissionId || `sub_${Date.now()}_${submissionData.userId}`,
      userId: submissionData.userId,
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
  const updateExpressions = [];
  const expressionAttributeNames = {};
  const expressionAttributeValues = {};
  
  if (updates.status !== undefined) {
    updateExpressions.push('#status = :status');
    expressionAttributeNames['#status'] = 'status';
    expressionAttributeValues[':status'] = updates.status;
  }
  
  if (updates.passedTests !== undefined) {
    updateExpressions.push('passedTests = :passedTests');
    expressionAttributeValues[':passedTests'] = updates.passedTests;
  }
  
  if (updates.totalTests !== undefined) {
    updateExpressions.push('totalTests = :totalTests');
    expressionAttributeValues[':totalTests'] = updates.totalTests;
  }
  
  if (updates.score !== undefined) {
    updateExpressions.push('score = :score');
    expressionAttributeValues[':score'] = updates.score;
  }

  if (updates.originalScore !== undefined) {
    updateExpressions.push('originalScore = :originalScore');
    expressionAttributeValues[':originalScore'] = updates.originalScore;
  }

  if (updates.criteriaModifications !== undefined) {
  updateExpressions.push('criteriaModifications = :criteriaModifications');
  expressionAttributeValues[':criteriaModifications'] = updates.criteriaModifications;
}
  
  if (updates.testResults !== undefined) {
    updateExpressions.push('testResults = :testResults');
    expressionAttributeValues[':testResults'] = updates.testResults;
  }
  
  if (updates.completedAt !== undefined) {
    updateExpressions.push('completedAt = :completedAt');
    expressionAttributeValues[':completedAt'] = updates.completedAt;
  }
  
  if (updates.credentialAwarded !== undefined) {
    updateExpressions.push('credentialAwarded = :credentialAwarded');
    expressionAttributeValues[':credentialAwarded'] = updates.credentialAwarded;
  }
  
  if (updates.totalExecutionTime !== undefined) {
    updateExpressions.push('totalExecutionTime = :totalExecutionTime');
    expressionAttributeValues[':totalExecutionTime'] = updates.totalExecutionTime;
  }
  
  if (updates.averageExecutionTime !== undefined) {
    updateExpressions.push('averageExecutionTime = :averageExecutionTime');
    expressionAttributeValues[':averageExecutionTime'] = updates.averageExecutionTime;
  }
  
  if (updates.maxExecutionTime !== undefined) {
    updateExpressions.push('maxExecutionTime = :maxExecutionTime');
    expressionAttributeValues[':maxExecutionTime'] = updates.maxExecutionTime;
  }
  
  if (updates.totalMemory !== undefined) {
    updateExpressions.push('totalMemory = :totalMemory');
    expressionAttributeValues[':totalMemory'] = updates.totalMemory;
  }
  
  if (updates.averageMemory !== undefined) {
    updateExpressions.push('averageMemory = :averageMemory');
    expressionAttributeValues[':averageMemory'] = updates.averageMemory;
  }
  
  if (updates.maxMemory !== undefined) {
    updateExpressions.push('maxMemory = :maxMemory');
    expressionAttributeValues[':maxMemory'] = updates.maxMemory;
  }
  
  if (updates.judge0BatchId !== undefined) {
    updateExpressions.push('judge0BatchId = :judge0BatchId');
    expressionAttributeValues[':judge0BatchId'] = updates.judge0BatchId;
  }
  
  if (updateExpressions.length === 0) {
    throw new Error('No fields to update');
  }
  
  const params = {
    TableName: process.env.SUBMISSIONS_TABLE,
    Key: { submissionId },
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