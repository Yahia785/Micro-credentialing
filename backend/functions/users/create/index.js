const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

/**
 * Create user in DynamoDB (inline - no shared import)
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
 * Lambda Handler: Create User Profile
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  try {
    // Check if triggered by Cognito (Post Confirmation)
    if (event.triggerSource === 'PostConfirmation_ConfirmSignUp') {
      const userId = event.request.userAttributes.sub;
      const email = event.request.userAttributes.email;
      const name = event.request.userAttributes.name || '';
      
      await createUser({ userId, email, name });
      
      console.log(`User profile created for: ${email}`);
      return event;
    }
    
    // Or API Gateway format
    const userId = event.requestContext?.authorizer?.claims?.sub;
    
    if (!userId) {
      return {
        statusCode: 401,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ error: 'Unauthorized' })
      };
    }
    
    const body = JSON.parse(event.body || '{}');
    
    console.log('Creating user:', { userId, email: body.email });
    const user = await createUser({
      userId: userId,
      email: body.email,
      name: body.name || ''
    });
    
    console.log('User created:', user);
    return {
      statusCode: 201,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        message: 'User profile created',
        user: user
      })
    };
    
  } catch (error) {
    console.error('Error creating user:', error);
    
    if (event.triggerSource) {
      console.error('Failed to create user profile, but allowing auth to continue');
      return event;
    }
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ 
        error: 'Failed to create user profile',
        details: error.message 
      })
    };
  }
};