const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      credentialsCount: 0,
      milestonesCompleted: 0
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
    UpdateExpression: 'set #name = :name, updatedAt = :updatedAt',
    ExpressionAttributeNames: {
      '#name': 'name'
    },
    ExpressionAttributeValues: {
      ':name': updates.name,
      ':updatedAt': new Date().toISOString()
    },
    ReturnValues: 'ALL_NEW'
  };
  
  const result = await dynamodb.send(new UpdateCommand(params));
  return result.Attributes;
}

module.exports = {
  createUser,
  getUser,
  updateUser
};