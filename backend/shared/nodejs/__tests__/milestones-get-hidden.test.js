// GET /milestones: hidden problems are for admins only.
const mockGetAllMilestones = jest.fn();
const mockGetUser = jest.fn();

jest.mock('/opt/nodejs/db/milestones', () => ({ getMilestone: jest.fn(), getAllMilestones: (...a) => mockGetAllMilestones(...a) }), { virtual: true });
jest.mock('/opt/nodejs/db/users', () => ({ getUser: (...a) => mockGetUser(...a) }), { virtual: true });
jest.mock('../db/users', () => ({ getUser: (...a) => mockGetUser(...a) }));
jest.mock('/opt/nodejs/middleware/handler', () => require('../middleware/handler'), { virtual: true });
jest.mock('/opt/nodejs/utils/responses', () => require('../utils/responses'), { virtual: true });
jest.mock('/opt/nodejs/utils/errors', () => require('../utils/errors'), { virtual: true });
jest.mock('/opt/nodejs/utils/logger', () => require('../utils/logger'), { virtual: true });

const { handler } = require('../../../functions/milestones/get/index.js');

const rows = [
  { milestoneId: 'm1', title: 'Public' },
  { milestoneId: 'm2', title: 'Hidden C++ test', isHidden: true },
  { milestoneId: 'm3', title: 'Explicitly visible', isHidden: false }
];

const event = () => ({
  httpMethod: 'GET',
  path: '/milestones',
  pathParameters: null,
  requestContext: { authorizer: { claims: { sub: 'user-1' } } }
});

const ids = (res) => JSON.parse(res.body).milestones.map(m => m.milestoneId);

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation();
  jest.spyOn(console, 'warn').mockImplementation();
  jest.spyOn(console, 'error').mockImplementation();
  mockGetAllMilestones.mockReset().mockResolvedValue(rows);
  mockGetUser.mockReset();
});
afterEach(() => jest.restoreAllMocks());

describe('GET /milestones hidden problems', () => {
  it('returns hidden problems to admins, each with isHidden: true', async () => {
    mockGetUser.mockResolvedValue({ userId: 'user-1', role: 'admin' });
    const res = await handler(event(), {});
    expect(res.statusCode).toBe(200);
    expect(ids(res)).toEqual(['m1', 'm2', 'm3']);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(3);
    expect(body.milestones.find(m => m.milestoneId === 'm2').isHidden).toBe(true);
  });

  it('hides them from students', async () => {
    mockGetUser.mockResolvedValue({ userId: 'user-1', role: 'student' });
    const res = await handler(event(), {});
    expect(ids(res)).toEqual(['m1', 'm3']);
    expect(JSON.parse(res.body).count).toBe(2);
  });

  it('hides them when the caller has no user record or the role lookup fails', async () => {
    mockGetUser.mockResolvedValueOnce(null);
    expect(ids(await handler(event(), {}))).toEqual(['m1', 'm3']);
    mockGetUser.mockRejectedValueOnce(new Error('AccessDenied'));
    expect(ids(await handler(event(), {}))).toEqual(['m1', 'm3']);
  });
});
