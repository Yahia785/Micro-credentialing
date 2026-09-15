const { configureWebhook, getWebhookConfig, testWebhook } = require('/opt/nodejs/utils/bcdiploma');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: Configure BCdiploma Webhook (ONE-TIME SETUP)
 * Endpoint: POST /admin/configure-webhook
 * Authorization: Admin only
 *
 * This tells BCdiploma where to send notifications when certificates are ready
 */
exports.handler = withHandler(async (ctx) => {
  // Parse request body
  const body = ctx.body;
  const action = body.action || 'configure'; // 'configure', 'get', or 'test'

  // Get the API Gateway URL from the event
  const apiGatewayUrl = `https://${ctx.event.requestContext.domainName}/${ctx.event.requestContext.stage}`;
  const webhookUrl = `${apiGatewayUrl}/webhooks/bcdiploma-notification`;

  log.info('Webhook URL computed', { webhookUrl });

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

    log.info('Webhook configured successfully', { webhookUrl, method });

    return successResponse(200, {
      message: 'Webhook configured successfully',
      webhookUrl: webhookUrl,
      method: method,
      result: result,
      instructions: 'BCdiploma will now call this endpoint when certificates are ready. No more 30-second waits!'
    });
  }
}, { requireAdmin: true });
