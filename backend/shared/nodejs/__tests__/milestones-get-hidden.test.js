// Hidden problems (isHidden): admins and the users on the problem's previewUserIds list see them, everyone else never does.
// The handlers import the layer as /opt/nodejs/..., which jest.config.js maps to this folder, so only the database modules are mocked.
const mockGetAllMilestones = jest.fn();
const mockGetMilestone = jest.fn();
const mockGetUser = jest.fn();
const mockGetTestCases = jest.fn();

jest.mock('../db/milestones', () => ({
  getMilestone: (...a) => mockGetMilestone(...a),
  getAllMilestones: (...a) => mockGetAllMilestones(...a)
}));
jest.mock('../db/users', () => ({ getUser: (...a) => mockGetUser(...a) }));
jest.mock('../db/testcases', () => ({ getTestCasesByMilestone: (...a) => mockGetTestCases(...a) }));

const { handler } = require('../../../functions/milestones/get/index.js');
const { handler: testCasesHandler } = require('../../../functions/testcases/get/index.js');

const rows = [
  { milestoneId: 'm1', title: 'Public' },
  { milestoneId: 'm2', title: 'Hidden C++ test', isHidden: true },
  { milestoneId: 'm3', title: 'Explicitly visible', isHidden: false },
  { milestoneId: 'm4', title: 'Hidden with a preview list', isHidden: true, previewUserIds: ['user-1', 'user-9'] }
];

const event = (milestoneId, userId = 'user-1') => ({
  httpMethod: 'GET',
  path: milestoneId ? `/milestones/${milestoneId}` : '/milestones',
  pathParameters: milestoneId ? { milestoneId } : null,
  requestContext: { authorizer: { claims: { sub: userId } } }
});

const ids = (res) => JSON.parse(res.body).milestones.map(m => m.milestoneId);

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation();
  jest.spyOn(console, 'warn').mockImplementation();
  jest.spyOn(console, 'error').mockImplementation();
  mockGetAllMilestones.mockReset().mockResolvedValue(rows);
  mockGetMilestone.mockReset().mockImplementation(async (id) => rows.find(r => r.milestoneId === id));
  mockGetTestCases.mockReset().mockResolvedValue([{ testCaseId: 't1', isHidden: false, order: 0 }]);
  mockGetUser.mockReset();
});
afterEach(() => jest.restoreAllMocks());

describe('GET /milestones hidden problems', () => {
  it('returns hidden problems to admins, each with isHidden: true', async () => {
    mockGetUser.mockResolvedValue({ userId: 'user-1', role: 'admin' });
    const res = await handler(event(), {});
    expect(res.statusCode).toBe(200);
    expect(ids(res)).toEqual(['m1', 'm2', 'm3', 'm4']);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(4);
    expect(body.milestones.find(m => m.milestoneId === 'm2').isHidden).toBe(true);
    // Admins also see who is on the preview list.
    expect(body.milestones.find(m => m.milestoneId === 'm4').previewUserIds).toEqual(['user-1', 'user-9']);
  });

  it('hides them from students', async () => {
    mockGetUser.mockResolvedValue({ userId: 'user-2', role: 'student' });
    const res = await handler(event(null, 'user-2'), {});
    expect(ids(res)).toEqual(['m1', 'm3']);
    expect(JSON.parse(res.body).count).toBe(2);
  });

  it('hides them when the caller has no user record or the role lookup fails', async () => {
    mockGetUser.mockResolvedValueOnce(null);
    expect(ids(await handler(event(null, 'user-2'), {}))).toEqual(['m1', 'm3']);
    mockGetUser.mockRejectedValueOnce(new Error('AccessDenied'));
    expect(ids(await handler(event(), {}))).toEqual(['m1', 'm3']);
  });
});

describe('previewUserIds', () => {
  it('shows a hidden problem to a student on its list, as an ordinary problem', async () => {
    mockGetUser.mockResolvedValue({ userId: 'user-1', role: 'student' });
    const res = await handler(event(), {});
    expect(ids(res)).toEqual(['m1', 'm3', 'm4']);
    const m4 = JSON.parse(res.body).milestones.find(m => m.milestoneId === 'm4');
    // Not marked hidden, and the other people on the list are not exposed.
    expect(m4).not.toHaveProperty('isHidden');
    expect(m4).not.toHaveProperty('previewUserIds');
    expect(JSON.stringify(JSON.parse(res.body))).not.toContain('user-9');
  });

  it('still hides it from a student who is not on the list', async () => {
    mockGetUser.mockResolvedValue({ userId: 'user-2', role: 'student' });
    expect(ids(await handler(event(null, 'user-2'), {}))).toEqual(['m1', 'm3']);
  });

  it('treats a caller whose lookup fails as a normal student, even if they are on the list', async () => {
    mockGetUser.mockRejectedValue(new Error('AccessDenied'));
    expect(ids(await handler(event(), {}))).toEqual(['m1', 'm3']);
    const one = await handler(event('m4'), {});
    expect(one.statusCode).toBe(404);
  });

  it('opens a single hidden problem for the preview user and admins, and 404s for everyone else', async () => {
    mockGetUser.mockResolvedValue({ userId: 'user-1', role: 'student' });
    const ok = await handler(event('m4'), {});
    expect(ok.statusCode).toBe(200);
    const milestone = JSON.parse(ok.body).milestone;
    expect(milestone.milestoneId).toBe('m4');
    expect(milestone).not.toHaveProperty('previewUserIds');

    mockGetUser.mockResolvedValue({ userId: 'user-2', role: 'student' });
    expect((await handler(event('m4', 'user-2'), {})).statusCode).toBe(404);
    expect((await handler(event('m2', 'user-1'), {})).statusCode).toBe(404);

    mockGetUser.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
    expect((await handler(event('m2', 'admin-1'), {})).statusCode).toBe(200);
  });

  it('gives a preview user the test cases of the hidden problem, and no one else', async () => {
    const tcEvent = (userId) => ({
      httpMethod: 'GET',
      path: '/milestones/m4/testcases',
      pathParameters: { milestoneId: 'm4' },
      requestContext: { authorizer: { claims: { sub: userId } } }
    });
    mockGetUser.mockResolvedValue({ userId: 'user-1', role: 'student' });
    expect((await testCasesHandler(tcEvent('user-1'), {})).statusCode).toBe(200);
    mockGetUser.mockResolvedValue({ userId: 'user-2', role: 'student' });
    expect((await testCasesHandler(tcEvent('user-2'), {})).statusCode).toBe(404);
  });
});
