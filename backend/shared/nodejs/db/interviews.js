const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand, TransactWriteCommand,
} = require('@aws-sdk/lib-dynamodb');
const { AppError } = require('../utils/errors');

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

const META_SK = 'META';
const TURN_PREFIX = 'T#';

/** One interview per submission: the ID is derived, so a conditional put enforces it atomically. */
function interviewIdFor(submissionId) {
  return `int_${submissionId}`;
}

function turnSk(position) {
  return `${TURN_PREFIX}${String(position).padStart(4, '0')}`;
}

/** Epoch seconds for the DynamoDB TTL attribute, or null when no retention period is configured. */
function expiresAtFor(now = Date.now()) {
  const days = Number(process.env.INTERVIEW_RETENTION_DAYS || 0);
  if (!Number.isFinite(days) || days <= 0) return null;
  return Math.floor(now / 1000) + Math.round(days * 86400);
}

function isConditionFailure(error) {
  if (error.name === 'ConditionalCheckFailedException') return true;
  return error.name === 'TransactionCanceledException'
    && (error.CancellationReasons || []).some((r) => r && r.Code === 'ConditionalCheckFailed');
}

function table() {
  return process.env.INTERVIEWS_TABLE;
}

/**
 * Create the interview and its first host turn together.
 * @throws {AppError} 409 when this submission already has an interview
 */
async function createInterview(meta, firstTurn) {
  const expiresAt = expiresAtFor(Date.parse(meta.startedAt));
  const withTtl = (item) => (expiresAt ? { ...item, expiresAt } : item);

  try {
    await dynamodb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: table(),
            Item: withTtl({ ...meta, sk: META_SK }),
            ConditionExpression: 'attribute_not_exists(interviewId)',
          },
        },
        {
          Put: {
            TableName: table(),
            Item: withTtl({ interviewId: meta.interviewId, sk: turnSk(1), ...firstTurn }),
          },
        },
      ],
    }));
  } catch (error) {
    if (isConditionFailure(error)) throw new AppError('An interview already exists for this submission', 409);
    throw error;
  }
  return meta;
}

async function getInterviewMeta(interviewId) {
  const result = await dynamodb.send(new GetCommand({
    TableName: table(),
    Key: { interviewId, sk: META_SK },
    ConsistentRead: true,
  }));
  return result.Item || null;
}

/** All turns of an interview in order. */
async function getInterviewTurns(interviewId) {
  const turns = [];
  let lastKey;
  do {
    const result = await dynamodb.send(new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'interviewId = :id AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':id': interviewId, ':prefix': TURN_PREFIX },
      ConsistentRead: true,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    turns.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return turns;
}

async function getInterviewBySubmission(submissionId) {
  const result = await dynamodb.send(new QueryCommand({
    TableName: table(),
    IndexName: 'SubmissionIdIndex',
    KeyConditionExpression: 'submissionId = :sid',
    ExpressionAttributeValues: { ':sid': submissionId },
    Limit: 1,
  }));
  return (result.Items || [])[0] || null;
}

/**
 * Append turns and update the META counters in one transaction. The update only applies if
 * the interview is still in progress and nobody else has appended since `expectedTurnCount`,
 * so a double-submitted answer cannot produce duplicate or interleaved turns.
 *
 * @param {object} p
 * @param {string} p.interviewId
 * @param {number} p.expectedTurnCount turnCount that was read before the model was called
 * @param {object[]} p.turns turns to append, in order
 * @param {object} p.metaUpdates fields to set on META (counters, or status/endedAt/endReason)
 * @throws {AppError} 409 on a concurrent change
 */
async function appendTurns({ interviewId, expectedTurnCount, turns, metaUpdates, now = Date.now() }) {
  const expiresAt = expiresAtFor(now);
  const updates = { ...metaUpdates, turnCount: expectedTurnCount + turns.length, updatedAt: new Date(now).toISOString() };

  const names = { '#status': 'status' };
  const values = { ':expected': expectedTurnCount, ':inProgress': 'in_progress' };
  const sets = [];
  Object.entries(updates).forEach(([key, value], i) => {
    names[`#f${i}`] = key;
    values[`:v${i}`] = value;
    sets.push(`#f${i} = :v${i}`);
  });

  try {
    await dynamodb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: table(),
            Key: { interviewId, sk: META_SK },
            UpdateExpression: `SET ${sets.join(', ')}`,
            ConditionExpression: 'turnCount = :expected AND #status = :inProgress',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          },
        },
        ...turns.map((turn, i) => ({
          Put: {
            TableName: table(),
            Item: { interviewId, sk: turnSk(expectedTurnCount + i + 1), ...turn, ...(expiresAt && { expiresAt }) },
            ConditionExpression: 'attribute_not_exists(sk)',
          },
        })),
      ],
    }));
  } catch (error) {
    if (isConditionFailure(error)) throw new AppError('This interview was updated by another request. Please retry.', 409);
    throw error;
  }
}

/** Mark an in-progress interview as finished without adding turns. Returns false if it already ended. */
async function endInterview(interviewId, { status, endReason, now = Date.now() }) {
  try {
    await dynamodb.send(new UpdateCommand({
      TableName: table(),
      Key: { interviewId, sk: META_SK },
      UpdateExpression: 'SET #status = :status, endReason = :reason, endedAt = :endedAt, updatedAt = :endedAt',
      ConditionExpression: '#status = :inProgress',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': status,
        ':reason': endReason,
        ':endedAt': new Date(now).toISOString(),
        ':inProgress': 'in_progress',
      },
    }));
    return true;
  } catch (error) {
    if (isConditionFailure(error)) return false;
    throw error;
  }
}

module.exports = {
  interviewIdFor,
  turnSk,
  expiresAtFor,
  createInterview,
  getInterviewMeta,
  getInterviewTurns,
  getInterviewBySubmission,
  appendTurns,
  endInterview,
};
