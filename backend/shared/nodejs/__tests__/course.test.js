const mockSend = jest.fn(async (command) => command.params);
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  PutCommand: jest.fn((params) => ({ params })),
  GetCommand: jest.fn(),
  UpdateCommand: jest.fn((params) => ({ params })),
  DeleteCommand: jest.fn(),
  ScanCommand: jest.fn(),
  BatchWriteCommand: jest.fn()
}));

const { parseCourse, MAX_COURSE_LENGTH } = require('../utils/course');
const { createMilestone, updateMilestone } = require('../db/milestones');
const { createEmbeddedAssessment, updateEmbeddedAssessment } = require('../db/embedded-assessments');

describe('parseCourse', () => {
  it('missing course: not provided, so a stored value is left alone', () => {
    expect(parseCourse(undefined)).toEqual({ provided: false, value: null, error: null });
  });

  it('null, empty and blank clear the course', () => {
    for (const raw of [null, '', '   ']) {
      expect(parseCourse(raw)).toEqual({ provided: true, value: null, error: null });
    }
  });

  it('trims and collapses whitespace', () => {
    expect(parseCourse('  ECE   3430 ').value).toBe('ECE 3430');
  });

  it('accepts ordinary course names', () => {
    for (const name of ['CS 101', 'Embedded Systems: MSP432', "Intro to C++ (Fall '26)", 'Programmation & Logique']) {
      expect(parseCourse(name).error).toBeNull();
    }
  });

  it('rejects non-strings, markup and control characters', () => {
    expect(parseCourse(42).error).toMatch(/string/);
    expect(parseCourse('<script>alert(1)</script>').error).toMatch(/plain text/);
    expect(parseCourse('bad\u0000name').error).toMatch(/plain text/);
  });

  it('rejects names longer than the limit', () => {
    expect(parseCourse('x'.repeat(MAX_COURSE_LENGTH)).error).toBeNull();
    expect(parseCourse('x'.repeat(MAX_COURSE_LENGTH + 1)).error).toMatch(/exceed/);
  });
});

describe('course on coding milestones', () => {
  beforeEach(() => mockSend.mockClear());

  it('stores the course when given', async () => {
    const item = await createMilestone({ title: 'T', description: 'D', course: 'CS 101' });
    expect(item.course).toBe('CS 101');
    expect(mockSend.mock.calls[0][0].params.Item.course).toBe('CS 101');
  });

  it('an assessment with no course has no course attribute at all (shown as "No course")', async () => {
    const item = await createMilestone({ title: 'T', description: 'D' });
    expect(item).not.toHaveProperty('course');
    const nulled = await createMilestone({ title: 'T', description: 'D', course: null });
    expect(nulled).not.toHaveProperty('course');
  });

  it('update can set and clear the course', async () => {
    await updateMilestone('m1', { course: 'CS 101' });
    expect(mockSend.mock.calls[0][0].params.ExpressionAttributeValues[':course']).toBe('CS 101');
    await updateMilestone('m1', { course: null });
    expect(mockSend.mock.calls[1][0].params.ExpressionAttributeValues[':course']).toBeNull();
  });
});

describe('course on embedded assessments', () => {
  beforeEach(() => mockSend.mockClear());

  it('stores the course when given', async () => {
    const item = await createEmbeddedAssessment({ title: 'T', rubric: ['a'], course: 'ECE 3430' });
    expect(item.course).toBe('ECE 3430');
    expect(item.type).toBe('embedded');
  });

  it('an assessment with no course has no course attribute', async () => {
    const item = await createEmbeddedAssessment({ title: 'T', rubric: ['a'] });
    expect(item).not.toHaveProperty('course');
  });

  it('update can set and clear the course', async () => {
    await updateEmbeddedAssessment('e1', { course: 'ECE 3430' });
    expect(mockSend.mock.calls[0][0].params.ExpressionAttributeValues[':course']).toBe('ECE 3430');
    await updateEmbeddedAssessment('e1', { course: null });
    expect(mockSend.mock.calls[1][0].params.ExpressionAttributeValues[':course']).toBeNull();
  });
});
