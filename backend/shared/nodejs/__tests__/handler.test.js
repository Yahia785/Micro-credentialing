jest.mock('../db/users', () => ({
  getUser: jest.fn(),
}));

const { getUser } = require('../db/users');
const { withHandler } = require('../middleware/handler');

function baseEvent(overrides = {}) {
  return {
    httpMethod: 'GET',
    path: '/things',
    requestContext: {
      authorizer: { claims: { sub: 'user-123' } },
    },
    pathParameters: null,
    queryStringParameters: null,
    body: null,
    ...overrides,
  };
}

const ORIGINAL_ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS;

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation();
  jest.spyOn(console, 'error').mockImplementation();
  getUser.mockReset();
  process.env.ALLOWED_ORIGINS = 'https://develop.example.amplifyapp.com,http://localhost:5173';
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env.ALLOWED_ORIGINS = ORIGINAL_ALLOWED_ORIGINS;
});

describe('withHandler', () => {
  it('returns the OPTIONS response for preflight requests', async () => {
    const fn = jest.fn();
    const handler = withHandler(fn);

    const result = await handler(baseEvent({ httpMethod: 'OPTIONS' }));

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('');
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns 401 for missing auth on a non-public handler', async () => {
    const fn = jest.fn();
    const handler = withHandler(fn);

    const result = await handler(baseEvent({ requestContext: {} }));

    expect(result.statusCode).toBe(401);
    expect(fn).not.toHaveBeenCalled();
  });

  it('passes through for a public handler with no auth', async () => {
    const fn = jest.fn().mockResolvedValue({ ok: true });
    const handler = withHandler(fn, { public: true });

    const result = await handler(baseEvent({ requestContext: {} }));

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true });
  });

  it('parses the JSON body into ctx.body', async () => {
    let capturedCtx;
    const fn = jest.fn(async (ctx) => { capturedCtx = ctx; return {}; });
    const handler = withHandler(fn);

    await handler(baseEvent({ body: JSON.stringify({ name: 'Alice' }) }));

    expect(capturedCtx.body).toEqual({ name: 'Alice' });
  });

  it('returns 400 for a malformed JSON body', async () => {
    const fn = jest.fn();
    const handler = withHandler(fn);

    const result = await handler(baseEvent({ body: '{not valid json' }));

    expect(result.statusCode).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });

  it('provides ctx.pathParams and ctx.queryParams', async () => {
    let capturedCtx;
    const fn = jest.fn(async (ctx) => { capturedCtx = ctx; return {}; });
    const handler = withHandler(fn);

    await handler(baseEvent({
      pathParameters: { id: '42' },
      queryStringParameters: { filter: 'active' },
    }));

    expect(capturedCtx.pathParams).toEqual({ id: '42' });
    expect(capturedCtx.queryParams).toEqual({ filter: 'active' });
  });

  it('defaults ctx.pathParams and ctx.queryParams to {} when absent', async () => {
    let capturedCtx;
    const fn = jest.fn(async (ctx) => { capturedCtx = ctx; return {}; });
    const handler = withHandler(fn);

    await handler(baseEvent());

    expect(capturedCtx.pathParams).toEqual({});
    expect(capturedCtx.queryParams).toEqual({});
  });

  it('wraps a plain object return in successResponse(200)', async () => {
    const fn = jest.fn().mockResolvedValue({ foo: 'bar' });
    const handler = withHandler(fn);

    const result = await handler(baseEvent());

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ foo: 'bar' });
  });

  it('passes through full response objects (statusCode + body), keeping custom headers and adding CORS', async () => {
    const fullResponse = { statusCode: 201, headers: { 'X-Custom': '1' }, body: JSON.stringify({ created: true }) };
    const fn = jest.fn().mockResolvedValue(fullResponse);
    const handler = withHandler(fn);

    const result = await handler(baseEvent());

    expect(result.statusCode).toBe(201);
    expect(result.body).toBe(fullResponse.body);
    expect(result.headers['X-Custom']).toBe('1');
  });

  it('returns 403 for a non-admin user on a requireAdmin handler', async () => {
    getUser.mockResolvedValue({ userId: 'user-123', role: 'user' });
    const fn = jest.fn();
    const handler = withHandler(fn, { requireAdmin: true });

    const result = await handler(baseEvent());

    expect(result.statusCode).toBe(403);
    expect(fn).not.toHaveBeenCalled();
  });

  it('allows an admin user through on a requireAdmin handler', async () => {
    getUser.mockResolvedValue({ userId: 'user-123', role: 'admin' });
    const fn = jest.fn().mockResolvedValue({ ok: true });
    const handler = withHandler(fn, { requireAdmin: true });

    const result = await handler(baseEvent());

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.statusCode).toBe(200);
  });

  it('catches unknown errors and returns 500', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('boom'));
    const handler = withHandler(fn);

    const result = await handler(baseEvent());

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error).toBe('Internal server error');
  });

  it('returns a typed AppError\'s own statusCode and message', async () => {
    class FakeValidationError extends Error {
      constructor(message) { super(message); this.name = 'ValidationError'; this.statusCode = 400; }
    }
    const fn = jest.fn().mockRejectedValue(new FakeValidationError('bad input'));
    const handler = withHandler(fn);

    const result = await handler(baseEvent());

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('bad input');
  });

  it('returns 502 for an ExternalServiceError', async () => {
    class FakeExternalServiceError extends Error {
      constructor(message) { super(message); this.name = 'ExternalServiceError'; this.service = 'judge0'; }
    }
    const fn = jest.fn().mockRejectedValue(new FakeExternalServiceError('judge0 error: timeout'));
    const handler = withHandler(fn);

    const result = await handler(baseEvent());

    expect(result.statusCode).toBe(502);
  });

  it('returns 429 with Retry-After for DynamoDB throttling errors', async () => {
    class ThrottlingException extends Error {
      constructor(message) { super(message); this.name = 'ThrottlingException'; }
    }
    const fn = jest.fn().mockRejectedValue(new ThrottlingException('slow down'));
    const handler = withHandler(fn);

    const result = await handler(baseEvent());

    expect(result.statusCode).toBe(429);
    expect(result.headers['Retry-After']).toBe('2');
  });

  it('passes through the raw return value for non-HTTP invocations (no httpMethod)', async () => {
    const rawEvent = { triggerSource: 'PostConfirmation_ConfirmSignUp', request: {} };
    const fn = jest.fn().mockResolvedValue(rawEvent);
    const handler = withHandler(fn, { public: true });

    const result = await handler(rawEvent);

    expect(result).toBe(rawEvent);
  });

  describe('CORS', () => {
    it('echoes back an allowed origin on a successful response', async () => {
      const fn = jest.fn().mockResolvedValue({ ok: true });
      const handler = withHandler(fn, { public: true });

      const result = await handler(baseEvent({
        requestContext: {},
        headers: { Origin: 'http://localhost:5173' },
      }));

      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
      expect(result.headers['Vary']).toBe('Origin');
    });

    it('is case-insensitive when reading the Origin header', async () => {
      const fn = jest.fn().mockResolvedValue({ ok: true });
      const handler = withHandler(fn, { public: true });

      const result = await handler(baseEvent({
        requestContext: {},
        headers: { origin: 'https://develop.example.amplifyapp.com' },
      }));

      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://develop.example.amplifyapp.com');
    });

    it('omits Access-Control-Allow-Origin for an unknown origin', async () => {
      const fn = jest.fn().mockResolvedValue({ ok: true });
      const handler = withHandler(fn, { public: true });

      const result = await handler(baseEvent({
        requestContext: {},
        headers: { Origin: 'https://evil.example.com' },
      }));

      expect(result.headers['Access-Control-Allow-Origin']).toBeUndefined();
      expect(result.headers['Vary']).toBeUndefined();
    });

    it('omits Access-Control-Allow-Origin when no Origin header is present', async () => {
      const fn = jest.fn().mockResolvedValue({ ok: true });
      const handler = withHandler(fn, { public: true });

      const result = await handler(baseEvent({ requestContext: {} }));

      expect(result.headers['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('echoes an allowed origin on an OPTIONS preflight request', async () => {
      const fn = jest.fn();
      const handler = withHandler(fn);

      const result = await handler(baseEvent({
        httpMethod: 'OPTIONS',
        headers: { Origin: 'http://localhost:5173' },
      }));

      expect(result.statusCode).toBe(200);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
      expect(fn).not.toHaveBeenCalled();
    });

    it('does not echo an unknown origin on an OPTIONS preflight request', async () => {
      const fn = jest.fn();
      const handler = withHandler(fn);

      const result = await handler(baseEvent({
        httpMethod: 'OPTIONS',
        headers: { Origin: 'https://evil.example.com' },
      }));

      expect(result.statusCode).toBe(200);
      expect(result.headers['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('echoes an allowed origin on error responses (e.g. 401)', async () => {
      const fn = jest.fn();
      const handler = withHandler(fn);

      const result = await handler(baseEvent({
        requestContext: {},
        headers: { Origin: 'http://localhost:5173' },
      }));

      expect(result.statusCode).toBe(401);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
    });
  });
});
