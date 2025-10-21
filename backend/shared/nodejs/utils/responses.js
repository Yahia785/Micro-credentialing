/**
 * Shared response utilities for successful API responses
 */

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*'
};

/**
 * Format a successful response
 * @param {number} statusCode - HTTP status code (default: 200)
 * @param {object} data - Response body data
 * @returns {object} Lambda response object
 * 
 * @example
 * return successResponse(200, { user: userData });
 * return successResponse(201, { message: 'Created', user });
 */
function successResponse(statusCode = 200, data = {}) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(data)
  };
}

module.exports = {
  successResponse,
  CORS_HEADERS
};