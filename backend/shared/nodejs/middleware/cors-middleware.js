/**
 * CORS Middleware for Lambda Proxy Integration
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'OPTIONS,GET,POST,PUT,DELETE'
};

/**
 * Add CORS headers to any response
 */
function addCorsHeaders(response) {
  return {
    ...response,
    headers: {
      ...(response.headers || {}),
      ...CORS_HEADERS
    }
  };
}

/**
 * Handle OPTIONS preflight request
 */
function handleOptionsRequest() {
  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: ''
  };
}

module.exports = {
  addCorsHeaders,
  handleOptionsRequest,
  CORS_HEADERS
};