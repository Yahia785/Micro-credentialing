const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

/**
 * Get BCdiploma API credentials from AWS Secrets Manager
 * @returns {Object} { apiKey, issuerId, apiUrl }
 */
async function getBCdiplomaCredentials() {
  const secretsClient = new SecretsManagerClient({});
  
  try {
    // Get API Key
    const apiKeyResponse = await secretsClient.send(
      new GetSecretValueCommand({
        SecretId: process.env.BCDIPLOMA_API_KEY_SECRET_ARN,
      })
    );
    
    // Get Issuer ID
    const issuerIdResponse = await secretsClient.send(
      new GetSecretValueCommand({
        SecretId: process.env.BCDIPLOMA_ISSUER_ID_SECRET_ARN,
      })
    );
    
    return {
      apiKey: apiKeyResponse.SecretString,
      issuerId: issuerIdResponse.SecretString,
      apiUrl: process.env.BCDIPLOMA_API_URL || 'https://api-staging.bcdiploma.com'
    };
  } catch (error) {
    console.error('Error fetching BCdiploma credentials:', error);
    throw new Error('Failed to retrieve BCdiploma credentials from Secrets Manager');
  }
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
  
  console.log('Configuring BCdiploma webhook:', requestBody);
  
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
      console.error('Webhook configuration error:', response.status, errorText);
      throw new Error(`Failed to configure webhook: ${response.status} - ${errorText}`);
    }
    
    const result = await response.json();
    console.log('✓ Webhook configured successfully:', result);
    
    return result;
  } catch (error) {
    console.error('Error configuring webhook:', error);
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
    console.log('Current webhook configuration:', result);
    
    return result;
  } catch (error) {
    console.error('Error getting webhook config:', error);
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
    
    console.log('✓ Webhook test successful');
    return true;
  } catch (error) {
    console.error('Error testing webhook:', error);
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
  
  console.log('BCdiploma Push Request:', JSON.stringify(requestBody, null, 2));
  
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
    console.log('BCdiploma Raw Response:', response.status, responseText);
    
    if (!response.ok) {
      console.error('BCdiploma Push Error:', response.status);
      console.error('Response Body:', responseText);
      
      // Try to parse error response as JSON for better error messages
      let errorMessage = responseText;
      let errorDetails = null;
      try {
        const errorJson = JSON.parse(responseText);
        if (errorJson.message) {
          errorMessage = errorJson.message;
        }
        errorDetails = errorJson;
        console.error('BCdiploma Error Details (JSON):', JSON.stringify(errorJson, null, 2));
      } catch (e) {
        // Response is not JSON, use raw text
        console.error('BCdiploma Error (Raw):', responseText);
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
      console.error('Failed to parse BCdiploma success response:', responseText);
      throw new Error('Invalid JSON response from BCdiploma (should contain campaignId)');
    }
    
    console.log('BCdiploma Push Response (Parsed):', JSON.stringify(result, null, 2));
    
    if (!result.campaignId) {
      console.error('Response missing campaignId:', result);
      throw new Error('BCdiploma response missing campaignId field');
    }
    
    console.log('✓ BCdiploma Push successful. Campaign ID:', result.campaignId);
    return result;
    
  } catch (error) {
    console.error('Error calling BCdiploma Push API:', error);
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
  
  console.log('BCdiploma Pull Request for campaign:', campaignId);
  
  try {
    const response = await fetch(`${apiUrl}/admin/data?campaignId=${campaignId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });
    
    const responseText = await response.text();
    
    if (!response.ok) {
      console.error('BCdiploma Pull Error:', response.status, responseText);
      
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
      console.error('Failed to parse BCdiploma Pull response:', responseText);
      throw new Error('Invalid JSON response from BCdiploma Pull');
    }
    
    console.log('BCdiploma Pull Response:', JSON.stringify(result, null, 2));
    
    return result;
  } catch (error) {
    console.error('Error calling BCdiploma Pull API:', error);
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
  
  console.log('BCdiploma Send Email Request:', requestBody);
  
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
      console.error('BCdiploma Send Email Error:', response.status, errorText);
      throw new Error(`BCdiploma Email failed: ${response.status} - ${errorText}`);
    }
    
    console.log('✓ Certificate email sent successfully');
    return true;
  } catch (error) {
    console.error('Error sending certificate email:', error);
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