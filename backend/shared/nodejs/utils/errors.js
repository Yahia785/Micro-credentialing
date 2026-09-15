/**
 * Shared error handling utilities for Lambda functions
 */

const { CORS_HEADERS } = require('../middleware/cors-middleware');

/**
 * Format an error response
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message to display
 * @param {string} details - Additional error details (optional, for logging)
 * @param {object} extraHeaders - Additional response headers (optional)
 * @returns {object} Lambda response object
 *
 * @example
 * return errorResponse(400, 'Invalid input');
 * return errorResponse(500, 'Database error', error.message);
 */
function errorResponse(statusCode = 500, message = 'Internal Server Error', details = null, extraHeaders = {}) {
  const errorBody = {
    error: message
  };

  if (details) {
    errorBody.details = details;
  }

  return {
    statusCode,
    headers: { ...CORS_HEADERS, ...extraHeaders },
    body: JSON.stringify(errorBody)
  };
}

/**
 * Application error classes for consistent error handling.
 */
class AppError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
  }
}

class ValidationError extends AppError {
  constructor(message) { super(message, 400); this.name = 'ValidationError'; }
}

class NotFoundError extends AppError {
  constructor(resource) { super(`${resource} not found`, 404); this.name = 'NotFoundError'; }
}

class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') { super(message, 403); this.name = 'ForbiddenError'; }
}

class ExternalServiceError extends AppError {
  constructor(service, message) {
    super(`${service} error: ${message}`, 502);
    this.name = 'ExternalServiceError';
    this.service = service;
  }
}

module.exports = {
  errorResponse,
  CORS_HEADERS,
  AppError,
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ExternalServiceError
};
