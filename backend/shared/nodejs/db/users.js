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
      role: userData.role || 'user', // Default to 'user', can be 'admin'
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
  // Build update expression dynamically based on what fields are provided
  const updateExpressions = [];
  const expressionAttributeNames = {};
  const expressionAttributeValues = {};
  
  if (updates.name !== undefined) {
    updateExpressions.push('#name = :name');
    expressionAttributeNames['#name'] = 'name';
    expressionAttributeValues[':name'] = updates.name;
  }
  
  if (updates.email !== undefined) {
    updateExpressions.push('email = :email');
    expressionAttributeValues[':email'] = updates.email;
  }
  
  // Always update the updatedAt timestamp
  updateExpressions.push('updatedAt = :updatedAt');
  expressionAttributeValues[':updatedAt'] = new Date().toISOString();
  
  const params = {
    TableName: process.env.USERS_TABLE,
    Key: { userId },
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

module.exports = {
  createUser,
  getUser,
  updateUser
};