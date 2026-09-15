const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { buildUpdateExpression } = require('./dynamo-utils');

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

/**
 * Create a user profile in DynamoDB
 */
async function createUser(userData) {
  const params = {
    TableName: process.env.USERS_TABLE,
    Item: {
      userId: userData.userId,
      email: userData.email,
      name: userData.name || '',
      role: userData.role || 'user', // Default to 'user', can be 'admin'
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      credentialsCount: 0,
      milestonesCompleted: 0,
      completedMilestones: []
    }
  };
  
  await dynamodb.send(new PutCommand(params));
  return params.Item;
}

/**
 * Get user profile by userId
 */
async function getUser(userId) {
  const params = {
    TableName: process.env.USERS_TABLE,
    Key: { userId }
  };
  
  const result = await dynamodb.send(new GetCommand(params));
  return result.Item;
}

/**
 * Update user profile
 */
async function updateUser(userId, updates) {
  const params = {
    TableName: process.env.USERS_TABLE,
    Key: { userId },
    ...buildUpdateExpression(updates),
    ReturnValues: 'ALL_NEW'
  };
  const result = await dynamodb.send(new UpdateCommand(params));
  return result.Attributes;
}

/**
 * Add completed milestone to user's profile.
 *
 * Uses an atomic list_append (rather than read-modify-write) guarded by an
 * optimistic lock on updatedAt, since two concurrent submissions completing
 * at the same time would otherwise race and the second write would clobber
 * the first one's read-modify-write of the array.
 */
async function addCompletedMilestone(userId, milestoneData) {
  const newMilestone = {
    milestoneId: milestoneData.milestoneId,
    score: milestoneData.score,
    passedTests: milestoneData.passedTests,
    totalTests: milestoneData.totalTests,
    completedAt: new Date().toISOString(),
    submissionId: milestoneData.submissionId,
  };

  // First, try to atomically append to the existing array.
  // The condition ensures we don't add a duplicate — it checks that
  // no existing entry in completedMilestones has the same milestoneId.
  // DynamoDB doesn't support "array doesn't contain value" natively,
  // so we use a two-step approach:

  // Step 1: Check if milestone already completed
  const user = await getUser(userId);
  if (!user) {
    throw new Error('User not found');
  }

  const alreadyCompleted = (user.completedMilestones || []).some(
    m => m.milestoneId === milestoneData.milestoneId
  );

  if (alreadyCompleted) {
    return user; // Already completed, no-op
  }

  // Step 2: Atomic append using list_append + condition on updatedAt
  // to detect concurrent writes
  try {
    const params = {
      TableName: process.env.USERS_TABLE,
      Key: { userId },
      UpdateExpression: 'SET completedMilestones = list_append(if_not_exists(completedMilestones, :empty), :newMilestone), updatedAt = :now',
      ConditionExpression: 'updatedAt = :expectedUpdatedAt',
      ExpressionAttributeValues: {
        ':newMilestone': [newMilestone],
        ':empty': [],
        ':now': new Date().toISOString(),
        ':expectedUpdatedAt': user.updatedAt,
      },
      ReturnValues: 'ALL_NEW',
    };

    const result = await dynamodb.send(new UpdateCommand(params));
    return result.Attributes;
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      // Concurrent update detected — re-read and retry once
      const freshUser = await getUser(userId);
      const stillNotCompleted = !(freshUser.completedMilestones || []).some(
        m => m.milestoneId === milestoneData.milestoneId
      );

      if (!stillNotCompleted) {
        return freshUser; // Someone else added it concurrently
      }

      // Retry with fresh updatedAt
      const retryParams = {
        TableName: process.env.USERS_TABLE,
        Key: { userId },
        UpdateExpression: 'SET completedMilestones = list_append(if_not_exists(completedMilestones, :empty), :newMilestone), updatedAt = :now',
        ExpressionAttributeValues: {
          ':newMilestone': [newMilestone],
          ':empty': [],
          ':now': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      };

      const retryResult = await dynamodb.send(new UpdateCommand(retryParams));
      return retryResult.Attributes;
    }
    throw error;
  }
}

module.exports = {
  createUser,
  getUser,
  updateUser,
  addCompletedMilestone
};