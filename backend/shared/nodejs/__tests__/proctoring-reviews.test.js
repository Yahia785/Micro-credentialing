const mockSend = jest.fn(async () => ({ Items: [] }));
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  UpdateCommand: jest.fn(),
  QueryCommand: jest.fn(),
  ScanCommand: jest.fn((params) => ({ params }))
}));

const { getPendingReviews } = require('../db/proctoring-reviews');

const lastScanParams = () => mockSend.mock.calls[mockSend.mock.calls.length - 1][0].params;

describe('getPendingReviews filters', () => {
  beforeEach(() => mockSend.mockClear());

  it('failed filter also lists ungraded submissions (grading_failed, manual_review)', async () => {
    await getPendingReviews(10, 'failed');
    const params = lastScanParams();
    expect(params.FilterExpression).toContain('#status IN (:status, :gradingFailed, :manualReview)');
    expect(params.ExpressionAttributeValues).toMatchObject({
      ':pending': 'pending',
      ':status': 'failed',
      ':gradingFailed': 'grading_failed',
      ':manualReview': 'manual_review'
    });
  });

  it('ungraded filter lists only never-graded submissions', async () => {
    await getPendingReviews(10, 'ungraded');
    const params = lastScanParams();
    expect(params.FilterExpression).toContain('#status IN (:gradingFailed, :manualReview)');
    expect(params.ExpressionAttributeValues).toEqual({
      ':pending': 'pending',
      ':gradingFailed': 'grading_failed',
      ':manualReview': 'manual_review'
    });
    expect(params.ExpressionAttributeValues[':status']).toBeUndefined();
  });

  it('passed filter is unchanged', async () => {
    await getPendingReviews(10, 'passed');
    expect(lastScanParams().ExpressionAttributeValues[':status']).toBe('passed');
  });
});
