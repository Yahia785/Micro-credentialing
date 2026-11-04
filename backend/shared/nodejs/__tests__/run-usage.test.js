// db/run-usage.js: the DynamoDB request is one transaction with a condition on every counter, so the increment is atomic.
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  TransactWriteCommand: class { constructor(input) { this.input = input; } }
}));

const { incrementCounters } = require('../db/run-usage');

beforeEach(() => {
  mockSend.mockReset();
  process.env.RUN_USAGE_TABLE = 'RunUsage-dev';
});

describe('incrementCounters', () => {
  it('sends one transaction: add 1 to each counter only while it is under its limit (no read-then-write)', async () => {
    mockSend.mockResolvedValue({});
    const outcome = await incrementCounters([{ key: 'run#u#a', limit: 150 }, { key: 'minute#u#5', limit: 10, expiresAt: 1234 }]);
    expect(outcome).toEqual({ ok: true });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const items = mockSend.mock.calls[0][0].input.TransactItems;
    expect(items).toHaveLength(2);
    expect(items[0].Update).toMatchObject({ TableName: 'RunUsage-dev', Key: { pk: 'run#u#a' } });
    expect(items[0].Update.UpdateExpression).toBe('SET #count = if_not_exists(#count, :zero) + :one');
    expect(items[0].Update.ConditionExpression).toBe('attribute_not_exists(#count) OR #count < :limit');
    expect(items[0].Update.ExpressionAttributeValues).toMatchObject({ ':limit': 150, ':one': 1 });
    expect(items[1].Update.UpdateExpression).toContain('expiresAt = :expiresAt'); // TTL only on the per-minute counter
    expect(items[1].Update.ExpressionAttributeValues[':expiresAt']).toBe(1234);
  });

  it('reports which counter was at its limit when the transaction is cancelled by a condition', async () => {
    const error = new Error('cancelled');
    error.name = 'TransactionCanceledException';
    error.CancellationReasons = [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }];
    mockSend.mockRejectedValue(error);
    expect(await incrementCounters([{ key: 'a', limit: 1 }, { key: 'b', limit: 1 }])).toEqual({ ok: false, failedKey: 'b' });
  });

  it('throws every other DynamoDB failure, including a cancellation that is not a condition failure', async () => {
    const other = new Error('throttled');
    other.name = 'TransactionCanceledException';
    other.CancellationReasons = [{ Code: 'ThrottlingError' }];
    mockSend.mockRejectedValue(other);
    await expect(incrementCounters([{ key: 'a', limit: 1 }])).rejects.toThrow('throttled');
    mockSend.mockRejectedValue(new Error('boom'));
    await expect(incrementCounters([{ key: 'a', limit: 1 }])).rejects.toThrow('boom');
  });
});
