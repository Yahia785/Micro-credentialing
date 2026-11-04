const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, TransactWriteCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

/**
 * Atomically add 1 to every counter, but only if none of them has reached its limit. All-or-nothing (one DynamoDB
 * transaction), so a run that is refused by one limit is not counted against the other.
 *
 * counters: [{ key, limit, expiresAt? }]  key = partition key of the counter item in RunUsage-<Environment>;
 *           expiresAt (epoch seconds) sets the table's TTL attribute, for counters that should vanish by themselves.
 * Returns { ok: true } or { ok: false, failedKey } (the first counter that was at its limit).
 * Any other DynamoDB failure is thrown. Stores counts only, never code.
 */
async function incrementCounters(counters) {
  const TableName = process.env.RUN_USAGE_TABLE;
  const TransactItems = counters.map(({ key, limit, expiresAt }) => ({
    Update: {
      TableName,
      Key: { pk: key },
      UpdateExpression: expiresAt
        ? 'SET #count = if_not_exists(#count, :zero) + :one, expiresAt = :expiresAt'
        : 'SET #count = if_not_exists(#count, :zero) + :one',
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
      ExpressionAttributeNames: { '#count': 'count' },
      ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':limit': limit, ...(expiresAt ? { ':expiresAt': expiresAt } : {}) }
    }
  }));

  try {
    await dynamodb.send(new TransactWriteCommand({ TransactItems }));
    return { ok: true };
  } catch (error) {
    if (error.name === 'TransactionCanceledException' && Array.isArray(error.CancellationReasons)) {
      const index = error.CancellationReasons.findIndex(reason => reason && reason.Code === 'ConditionalCheckFailed');
      if (index >= 0) return { ok: false, failedKey: counters[index].key };
    }
    throw error;
  }
}

module.exports = { incrementCounters };
