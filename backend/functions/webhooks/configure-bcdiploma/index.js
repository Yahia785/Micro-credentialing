const { configureWebhook, getWebhookConfig, testWebhook } = require('/opt/nodejs/utils/bcdiploma');
const { getUser } = require('/opt/nodejs/db/users');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');

/**
 * Lambda Handler: Configure BCdiploma Webhook (ONE-TIME SETUP)
 * Endpoint: POST /admin/configure-webhook
 * Authorization: Admin only
 * 
 * This tells BCdiploma where to send notifications when certificates are ready
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  try {
    // Get userId from JWT token
    const authenticatedUserId = event.requestContext?.authorizer?.claims?.sub;
    
    if (!authenticatedUserId) {
      return errorResponse(401, 'Unauthorized');
    }
    
    // Check if user is admin
    const user = await getUser(authenticatedUserId);
    if (!user || user.role !== 'admin') {
      return errorResponse(403, 'Forbidden: Admin access required');
    }
    
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const action = body.action || 'configure'; // 'configure', 'get', or 'test'
    
    // Get the API Gateway URL from the event
    const apiGatewayUrl = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
    const webhookUrl = `${apiGatewayUrl}/webhooks/bcdiploma-notification`;
    
    console.log('Webhook URL:', webhookUrl);
    
    if (action === 'get') {
      // Get current configuration
      const config = await getWebhookConfig();
      
      return successResponse(200, {
        message: 'Current webhook configuration',
        config: config
      });
      
    } else if (action === 'test') {
      // Test the webhook
      const testResult = await testWebhook();
      
      return successResponse(200, {
        message: 'Webhook test completed',
        success: testResult
      });
      
    } else {
      // Configure webhook
      const method = body.method || 'POST'; // POST is recommended
      
      const result = await configureWebhook(webhookUrl, method);
      
      console.log('✓ Webhook configured successfully');
      
      return successResponse(200, {
        message: 'Webhook configured successfully',
        webhookUrl: webhookUrl,
        method: method,
        result: result,
        instructions: 'BCdiploma will now call this endpoint when certificates are ready. No more 30-second waits!'
      });
    }
    
  } catch (error) {
    console.error('Error configuring webhook:', error);
    return errorResponse(500, 'Failed to configure webhook', error.message);
  }
};