const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const log = require('./logger');

const client = new SecretsManagerClient({});

// In-memory cache — secrets persist for the lifetime of the Lambda container
const cache = {};

/**
 * Get a secret value from AWS Secrets Manager with caching.
 * The cache lives for the Lambda container's lifetime (minutes to hours),
 * avoiding a Secrets Manager API call on every request.
 *
 * @param {string} secretArn - The ARN or name of the secret
 * @returns {string} The secret value
 */
async function getSecret(secretArn) {
  if (cache[secretArn]) {
    return cache[secretArn];
  }

  log.info('Fetching secret from Secrets Manager', {
    secretArn: secretArn.split(':').pop(), // Log only the name, not full ARN
  });

  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );

  cache[secretArn] = response.SecretString;
  return response.SecretString;
}

/**
 * Clear the secrets cache (useful for testing).
 */
function clearCache() {
  for (const key of Object.keys(cache)) {
    delete cache[key];
  }
}

module.exports = { getSecret, clearCache };
