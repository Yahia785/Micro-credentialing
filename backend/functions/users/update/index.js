const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

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

/**
 * Lambda Handler: Update User Profile
 * Endpoint: PUT /users/{userId} or PUT /users/me
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  try {
    // Get userId from JWT token (logged in user)
    const authenticatedUserId = event.requestContext?.authorizer?.claims?.sub;
    
    if (!authenticatedUserId) {
      return {
        statusCode: 401,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ error: 'Unauthorized' })
      };
    }
    
    // Get userId from path (if specified)
    const pathUserId = event.pathParameters?.userId;
    
    // Determine which user to update
    let userIdToUpdate;
    if (pathUserId === 'me' || !pathUserId) {
      // Update current user
      userIdToUpdate = authenticatedUserId;
    } else {
      // Security: Only allow users to update their own profile
      if (pathUserId !== authenticatedUserId) {
        return {
          statusCode: 403,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          },
          body: JSON.stringify({ error: 'Forbidden: You can only update your own profile' })
        };
      }
      userIdToUpdate = pathUserId;
    }
    
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    
    // Validate input
    if (!body.name && !body.email) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ error: 'At least one field (name or email) must be provided' })
      };
    }
    
    console.log('Updating user:', userIdToUpdate, 'with data:', body);
    
    // Update user
    const updatedUser = await updateUser(userIdToUpdate, body);
    
    console.log('User updated:', updatedUser);
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        message: 'User profile updated successfully',
        user: updatedUser
      })
    };
    
  } catch (error) {
    console.error('Error updating user:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ 
        error: 'Failed to update user profile',
        details: error.message 
      })
    };
  }
};