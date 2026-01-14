/**
 * Shared error handling utilities for Lambda functions
 */

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'OPTIONS,GET,POST,PUT,DELETE'
};

/**
 * Format an error response
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message to display
 * @param {string} details - Additional error details (optional, for logging)
 * @returns {object} Lambda response object
 * 
 * @example
 * return errorResponse(400, 'Invalid input');
 * return errorResponse(500, 'Database error', error.message);
 */
function errorResponse(statusCode = 500, message = 'Internal Server Error', details = null) {
  const errorBody = {
    error: message
  };
  
  if (details) {
    errorBody.details = details;
  }
  
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(errorBody)
  };
}

module.exports = {
  errorResponse,
  CORS_HEADERS
};