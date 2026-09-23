/**
 * CORS Middleware for Lambda Proxy Integration
 */

const ALLOW_HEADERS = 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token';
const ALLOW_METHODS = 'OPTIONS,GET,POST,PUT,DELETE';

// Static headers only — no Access-Control-Allow-Origin here, since the correct
// value depends on the request's Origin header. getCorsHeaders(event) computes
// that per-request; withHandler applies it to every response it returns.
const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Headers': ALLOW_HEADERS,
  'Access-Control-Allow-Methods': ALLOW_METHODS
};

function getAllowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function getRequestOrigin(event) {
  const headers = (event && event.headers) || {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'origin');
  return key ? headers[key] : undefined;
}

/**
 * Compute CORS headers for a single request. Echoes back the request's Origin
 * header (plus Vary: Origin) only if it's in ALLOWED_ORIGINS; unknown or missing
 * origins get no Access-Control-Allow-Origin.
 */
function getCorsHeaders(event) {
  const headers = { ...CORS_HEADERS };

  const origin = getRequestOrigin(event);
  if (origin && getAllowedOrigins().includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }

  return headers;
}

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
  getCorsHeaders,
  CORS_HEADERS
};
