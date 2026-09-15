const {
  errorResponse,
  CORS_HEADERS,
  AppError,
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ExternalServiceError,
} = require('../utils/errors');

describe('error classes', () => {
  it('ValidationError has statusCode 400', () => {
    const err = new ValidationError('bad input');
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe('bad input');
    expect(err.name).toBe('ValidationError');
  });

  it('NotFoundError has statusCode 404 and includes the resource name', () => {
    const err = new NotFoundError('Milestone');
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('Milestone not found');
    expect(err.name).toBe('NotFoundError');
  });

  it('ForbiddenError has statusCode 403', () => {
    const err = new ForbiddenError();
    expect(err.statusCode).toBe(403);
    expect(err.name).toBe('ForbiddenError');

    const custom = new ForbiddenError('Admins only');
    expect(custom.message).toBe('Admins only');
  });

  it('ExternalServiceError has statusCode 502 and includes the service name', () => {
    const err = new ExternalServiceError('judge0', 'timed out');
    expect(err.statusCode).toBe(502);
    expect(err.service).toBe('judge0');
    expect(err.message).toBe('judge0 error: timed out');
    expect(err.name).toBe('ExternalServiceError');
  });

  it('all typed errors extend AppError', () => {
    expect(new ValidationError('x')).toBeInstanceOf(AppError);
    expect(new NotFoundError('x')).toBeInstanceOf(AppError);
    expect(new ForbiddenError()).toBeInstanceOf(AppError);
    expect(new ExternalServiceError('svc', 'x')).toBeInstanceOf(AppError);
  });

  it('all typed errors extend Error', () => {
    expect(new ValidationError('x')).toBeInstanceOf(Error);
    expect(new NotFoundError('x')).toBeInstanceOf(Error);
    expect(new ForbiddenError()).toBeInstanceOf(Error);
    expect(new ExternalServiceError('svc', 'x')).toBeInstanceOf(Error);
    expect(new AppError('x')).toBeInstanceOf(Error);
  });
});

describe('errorResponse', () => {
  it('returns the given statusCode', () => {
    const res = errorResponse(404, 'Not found');
    expect(res.statusCode).toBe(404);
  });

  it('includes CORS headers', () => {
    const res = errorResponse(400, 'Bad request');
    expect(res.headers).toEqual(expect.objectContaining(CORS_HEADERS));
  });

  it('has a body that is valid JSON with the error message', () => {
    const res = errorResponse(500, 'Something broke');
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toBe('Something broke');
  });

  it('merges extra headers when provided', () => {
    const res = errorResponse(429, 'Too many requests', undefined, { 'Retry-After': '2' });
    expect(res.headers['Retry-After']).toBe('2');
    expect(res.headers).toEqual(expect.objectContaining(CORS_HEADERS));
  });
});
