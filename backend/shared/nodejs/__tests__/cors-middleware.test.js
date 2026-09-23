const { getCorsHeaders, handleOptionsRequest, CORS_HEADERS } = require('../middleware/cors-middleware');

const ORIGINAL_ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS;

beforeEach(() => {
  process.env.ALLOWED_ORIGINS = 'https://develop.example.amplifyapp.com,http://localhost:5173';
});
afterEach(() => {
  process.env.ALLOWED_ORIGINS = ORIGINAL_ALLOWED_ORIGINS;
});

describe('CORS_HEADERS', () => {
  it('does not include Access-Control-Allow-Origin (origin is per-request)', () => {
    expect(CORS_HEADERS['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('keeps the existing allowed headers and methods', () => {
    expect(CORS_HEADERS['Access-Control-Allow-Headers']).toBe(
      'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'
    );
    expect(CORS_HEADERS['Access-Control-Allow-Methods']).toBe('OPTIONS,GET,POST,PUT,DELETE');
  });
});

describe('getCorsHeaders', () => {
  it('echoes back an origin that is in ALLOWED_ORIGINS', () => {
    const headers = getCorsHeaders({ headers: { Origin: 'http://localhost:5173' } });
    expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
    expect(headers['Vary']).toBe('Origin');
  });

  it('reads the Origin header case-insensitively', () => {
    const headers = getCorsHeaders({ headers: { origin: 'https://develop.example.amplifyapp.com' } });
    expect(headers['Access-Control-Allow-Origin']).toBe('https://develop.example.amplifyapp.com');
  });

  it('gives an unknown origin no Access-Control-Allow-Origin', () => {
    const headers = getCorsHeaders({ headers: { Origin: 'https://evil.example.com' } });
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(headers['Vary']).toBeUndefined();
  });

  it('gives a missing Origin header no Access-Control-Allow-Origin', () => {
    const headers = getCorsHeaders({ headers: {} });
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('handles a missing headers object on the event', () => {
    const headers = getCorsHeaders({});
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('trims whitespace around entries in ALLOWED_ORIGINS', () => {
    process.env.ALLOWED_ORIGINS = ' https://develop.example.amplifyapp.com , http://localhost:5173 ';
    const headers = getCorsHeaders({ headers: { Origin: 'http://localhost:5173' } });
    expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
  });

  it('always keeps the allowed headers and methods regardless of origin', () => {
    const allowed = getCorsHeaders({ headers: { Origin: 'http://localhost:5173' } });
    const unknown = getCorsHeaders({ headers: { Origin: 'https://evil.example.com' } });
    expect(allowed['Access-Control-Allow-Headers']).toBe(unknown['Access-Control-Allow-Headers']);
    expect(allowed['Access-Control-Allow-Methods']).toBe(unknown['Access-Control-Allow-Methods']);
  });
});

describe('handleOptionsRequest', () => {
  it('returns a 200 with an empty body', () => {
    const res = handleOptionsRequest();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });
});
