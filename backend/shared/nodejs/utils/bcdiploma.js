const { getSecret } = require('./secrets');
const log = require('./logger');

/**
 * Get BCdiploma API credentials from AWS Secrets Manager
 * @returns {Object} { apiKey, issuerId, apiUrl }
 */
async function getBCdiplomaCredentials() {
  const apiKey = await getSecret(process.env.BCDIPLOMA_API_KEY_SECRET_ARN);
  const issuerId = await getSecret(process.env.BCDIPLOMA_ISSUER_ID_SECRET_ARN);

  return {
    apiKey,
    issuerId,
    apiUrl: process.env.BCDIPLOMA_API_URL || 'https://api-staging.bcdiploma.com',
  };
}

/**
 * Configure webhook notification endpoint in BCdiploma
 * @param {string} webhookUrl - Your webhook URL (e.g., https://api.example.com/webhooks/bcdiploma-notification)
 * @param {string} method - HTTP method: 'GET' or 'POST'
 * @param {Object} postContent - Content to send with POST (optional)
 * @returns {Object} Configuration response
 */
async function configureWebhook(webhookUrl, method = 'POST', postContent = null) {
  const { apiKey, issuerId, apiUrl } = await getBCdiplomaCredentials();

  const requestBody = {
    url: webhookUrl,
    method: method.toUpperCase()
  };

  // For POST, add content
  if (method.toUpperCase() === 'POST') {
    requestBody.content = postContent || {
      id: '${campaignId}',
      from: 'BCdiploma',
      operation: 'CAMPAIGN-NOTIFICATION'
    };
  }

  log.info('Configuring BCdiploma webhook', { requestBody });

  try {
    const response = await fetch(`${apiUrl}/issuer/${issuerId}/notif`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error('Webhook configuration error', { status: response.status });
      throw new Error(`Failed to configure webhook: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    log.info('Webhook configured successfully');

    return result;
  } catch (error) {
    log.error('Error configuring webhook', { error: error.message });
    throw error;
  }
}

/**
 * Get current webhook configuration
 * @returns {Object} Current webhook configuration
 */
async function getWebhookConfig() {
  const { apiKey, issuerId, apiUrl } = await getBCdiplomaCredentials();

  try {
    const response = await fetch(`${apiUrl}/issuer/${issuerId}/notif`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get webhook config: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    log.info('Current webhook configuration retrieved');

    return result;
  } catch (error) {
    log.error('Error getting webhook config', { error: error.message });
    throw error;
  }
}

/**
 * Test webhook endpoint
 * @returns {Object} Test result
 */
async function testWebhook() {
  const { apiKey, issuerId, apiUrl } = await getBCdiplomaCredentials();

  try {
    const response = await fetch(`${apiUrl}/issuer/${issuerId}/testnotif`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Webhook test failed: ${response.status} - ${errorText}`);
    }

    log.info('Webhook test successful');
    return true;
  } catch (error) {
    log.error('Error testing webhook', { error: error.message });
    throw error;
  }
}

/**
 * Push certificate data to BCdiploma (Step 1: Request certification)
 * @param {string} templateId - BCdiploma template ID (e.g., "0x13" or "1x02")
 * @param {Array} certificateData - Array of certificate data objects (already formatted)
 * @param {Object} options - Optional settings (notification email, notes)
 * @returns {Object} Response with campaignId
 *
 * IMPORTANT: certificateData must be pre-formatted with these exact fields:
 * - ID, Email, language, firstName, lastName, obtentionDate, expirationDate,
 *   assessment, linkLabel, linkURL
 */
async function pushCertificate(templateId, certificateData, options = {}) {
  const { apiKey, apiUrl } = await getBCdiplomaCredentials();

  // Validate template ID format - BCdiploma uses 0x or 1x prefix
  if (!templateId || !(templateId.startsWith('0x') || templateId.startsWith('1x'))) {
    throw new Error(`Invalid BCdiploma template ID format: ${templateId}. Must start with "0x" or "1x" (e.g., "0x13" or "1x02")`);
  }

  // BCdiploma API requires these fields to be present, even if empty
  const requestBody = {
    templateId: templateId,
    contentType: 'application/json',
    notes: 'Test', // Required field - can be empty string
    notification: 'yahiatawfeek20@gmail.com', // Required field - can be empty string
    data: certificateData // Must already be formatted with correct fields
  };

  log.info('BCdiploma push request', { templateId, recipientCount: certificateData.length });

  try {
    const response = await fetch(`${apiUrl}/admin/data`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    const responseText = await response.text();
    log.info('BCdiploma raw response received', { status: response.status });

    if (!response.ok) {
      log.error('BCdiploma push error', { status: response.status });

      // Try to parse error response as JSON for better error messages
      let errorMessage = responseText;
      let errorDetails = null;
      try {
        const errorJson = JSON.parse(responseText);
        if (errorJson.message) {
          errorMessage = errorJson.message;
        }
        errorDetails = errorJson;
        log.error('BCdiploma error details', { message: errorJson.message });
      } catch (e) {
        // Response is not JSON, use raw text
        log.error('BCdiploma error response was not valid JSON', { status: response.status });
      }

      // Specific error handling
      if (response.status === 429) {
        throw new Error('BCdiploma rate limit exceeded. Publishing endpoint allows 20 requests per 5 seconds.');
      } else if (response.status === 401) {
        throw new Error(`BCdiploma authentication failed (401): ${errorMessage}. Check your API key in Secrets Manager.`);
      } else if (response.status === 400) {
        throw new Error(`BCdiploma validation error (400): ${errorMessage}. Check your data format and required fields.`);
      } else if (response.status === 403) {
        // 403 Forbidden - most common causes
        const troubleshooting = [
          '1. Template not activated for your account',
          '2. API key lacks permissions',
          '3. Issuer ID mismatch',
          '4. Template exists in different environment (staging vs production)'
        ];
        throw new Error(
          `BCdiploma forbidden (403): ${errorMessage}\n\n` +
          `Possible causes:\n${troubleshooting.join('\n')}\n\n` +
          `Contact BCdiploma support with this error and confirm:\n` +
          `- Template "${templateId}" is activated for your account\n` +
          `- Your API key has POST /admin/data permissions\n` +
          `- Using correct environment (${apiUrl})`
        );
      } else if (response.status === 404) {
        throw new Error(`BCdiploma endpoint not found (404): ${errorMessage}. Check API URL: ${apiUrl}/admin/data`);
      }

      // Generic error with details
      throw new Error(`BCdiploma Push failed (${response.status}): ${errorMessage}`);
    }

    // Success - parse response
    let result;
    try {
      result = JSON.parse(responseText);
    } catch (parseError) {
      log.error('Failed to parse BCdiploma success response');
      throw new Error('Invalid JSON response from BCdiploma (should contain campaignId)');
    }

    log.info('BCdiploma push response parsed', { campaignId: result.campaignId });

    if (!result.campaignId) {
      log.error('BCdiploma response missing campaignId field');
      throw new Error('BCdiploma response missing campaignId field');
    }

    log.info('BCdiploma push successful', { campaignId: result.campaignId });
    return result;

  } catch (error) {
    log.error('Error calling BCdiploma Push API', { error: error.message });
    throw error;
  }
}

/**
 * Pull certificate URLs from BCdiploma (Step 3: Retrieve certified links)
 * @param {string} campaignId - Campaign ID from push response
 * @returns {Object} Certificate data with URLs and keys
 */
async function pullCertificate(campaignId) {
  const { apiKey, apiUrl } = await getBCdiplomaCredentials();

  log.info('BCdiploma pull request', { campaignId });

  try {
    const response = await fetch(`${apiUrl}/admin/data?campaignId=${campaignId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    const responseText = await response.text();

    if (!response.ok) {
      log.error('BCdiploma pull error', { status: response.status });

      if (response.status === 429) {
        throw new Error('BCdiploma rate limit exceeded.');
      } else if (response.status === 404) {
        throw new Error(`Campaign ${campaignId} not found or still processing.`);
      }

      throw new Error(`BCdiploma Pull failed: ${response.status} - ${responseText}`);
    }

    let result;
    try {
      result = JSON.parse(responseText);
    } catch (parseError) {
      log.error('Failed to parse BCdiploma pull response');
      throw new Error('Invalid JSON response from BCdiploma Pull');
    }

    log.info('BCdiploma pull response received', { campaignId, certificateCount: result.data?.length || 0 });

    return result;
  } catch (error) {
    log.error('Error calling BCdiploma Pull API', { error: error.message });
    throw error;
  }
}

/**
 * Send certificate emails via BCdiploma
 * @param {string} campaignId - Campaign ID
 * @param {string} ids - Semicolon-separated IDs (e.g., "1234;5678")
 * @param {Object} emailOptions - Email settings
 */
async function sendCertificateEmail(campaignId, ids, emailOptions = {}) {
  const { apiKey, apiUrl } = await getBCdiplomaCredentials();

  const requestBody = {
    campaignId: campaignId,
    ids: ids,
    object: emailOptions.subject || 'Your Certificate',
    reply_to: emailOptions.replyTo || 'noreply@example.com',
    from_name: emailOptions.fromName || 'Micro-Credentialing Platform',
    ...(emailOptions.notification && { notification: emailOptions.notification })
  };

  log.info('BCdiploma send email request', { campaignId, ids });

  try {
    const response = await fetch(`${apiUrl}/admin/mailing`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error('BCdiploma send email error', { status: response.status });
      throw new Error(`BCdiploma Email failed: ${response.status} - ${errorText}`);
    }

    log.info('Certificate email sent successfully');
    return true;
  } catch (error) {
    log.error('Error sending certificate email', { error: error.message });
    throw error;
  }
}

module.exports = {
  getBCdiplomaCredentials,
  configureWebhook,
  getWebhookConfig,
  testWebhook,
  pushCertificate,
  pullCertificate,
  sendCertificateEmail
};
