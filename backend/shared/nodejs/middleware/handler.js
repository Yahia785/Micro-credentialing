/**
 * Lambda handler wrapper — eliminates boilerplate across all handlers.
 *
 * Usage:
 *   const { withHandler } = require('/opt/nodejs/middleware/handler');
 *
 *   exports.handler = withHandler(async (ctx) => {
 *     const user = await getUser(ctx.userId);
 *     return { user };
 *   });
 *
 *   // Admin-only:
 *   exports.handler = withHandler(async (ctx) => { ... }, { requireAdmin: true });
 *
 *   // Public (no auth):
 *   exports.handler = withHandler(async (ctx) => { ... }, { public: true });
 *
 * ctx contains:
 *   userId     — string from JWT claims.sub (null if public)
 *   body       — parsed JSON body (or {})
 *   pathParams — event.pathParameters (or {})
 *   queryParams — event.queryStringParameters (or {})
 *   event      — raw Lambda event (escape hatch)
 *   context    — raw Lambda context (provides getRemainingTimeInMillis())
 *   user       — User record from DynamoDB (only when requireAdmin is true)
 */

const { handleOptionsRequest, getCorsHeaders } = require('./cors-middleware');
const { errorResponse } = require('../utils/errors');
const { successResponse } = require('../utils/responses');
const log = require('../utils/logger');

// Applies the request's own CORS headers (computed from its Origin header) to a
// response. This is the one place CORS gets decided — successResponse/errorResponse
// keep returning static fallback headers, and this overrides them per-request.
function withCors(response, event) {
  return {
    ...response,
    headers: {
      ...(response.headers || {}),
      ...getCorsHeaders(event)
    }
  };
}

function withHandler(fn, options = {}) {
  const { requireAdmin = false, public: isPublic = false } = options;

  return async (event, context) => {
    log.info('Request received', {
      httpMethod: event.httpMethod,
      path: event.path,
      pathParameters: event.pathParameters,
      queryStringParameters: event.queryStringParameters,
    });

    if (event.httpMethod === 'OPTIONS') {
      return withCors(handleOptionsRequest(), event);
    }

    try {
      const userId = event.requestContext?.authorizer?.claims?.sub || null;

      if (!isPublic && !userId) {
        return withCors(errorResponse(401, 'Unauthorized'), event);
      }

      let user = null;
      if (requireAdmin) {
        const { getUser } = require('../db/users');
        user = await getUser(userId);
        if (!user || user.role !== 'admin') {
          return withCors(errorResponse(403, 'Forbidden: Admin access required'), event);
        }
      }

      let body = {};
      if (event.body) {
        try {
          body = JSON.parse(event.body);
        } catch {
          return withCors(errorResponse(400, 'Invalid JSON in request body'), event);
        }
      }

      const ctx = {
        userId,
        body,
        pathParams: event.pathParameters || {},
        queryParams: event.queryStringParameters || {},
        event,
        context, // Lambda context — provides getRemainingTimeInMillis()
        user,
      };

      const result = await fn(ctx);

      // Non-HTTP invocations (e.g. Cognito triggers) have no httpMethod and expect
      // their return value passed back untouched, not wrapped as an HTTP response.
      if (!event.httpMethod) {
        return result;
      }

      if (result && typeof result.statusCode === 'number' && result.body !== undefined) {
        return withCors(result, event);
      }

      return withCors(successResponse(200, result), event);

    } catch (error) {
      // Handle typed application errors
      if (error.statusCode && error.statusCode < 500) {
        log.warn('Client error', { type: error.name, message: error.message });
        return withCors(errorResponse(error.statusCode, error.message), event);
      }

      if (error.name === 'ExternalServiceError') {
        log.error('External service error', {
          service: error.service,
          message: error.message,
        });
        return withCors(errorResponse(502, error.message), event);
      }

      // DynamoDB throttling
      if (error.name === 'ProvisionedThroughputExceededException' ||
          error.name === 'ThrottlingException') {
        log.warn('DynamoDB throttled', { message: error.message });
        return withCors(errorResponse(429, 'Service busy, please retry', undefined, {
          'Retry-After': '2'
        }), event);
      }

      // Unknown errors
      log.error('Handler error', {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
      return withCors(errorResponse(500, 'Internal server error'), event);
    }
  };
}

module.exports = { withHandler };
