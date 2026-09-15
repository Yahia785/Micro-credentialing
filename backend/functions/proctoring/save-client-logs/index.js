const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { successResponse } = require('/opt/nodejs/utils/responses');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const dynamodb = DynamoDBDocumentClient.from(client);

const SUBMISSIONS_TABLE = process.env.SUBMISSIONS_TABLE;

/**
 * Lambda Handler: Save Client-Side Proctoring Logs
 * Endpoint: POST /proctoring/client-logs
 * Authorization: Authenticated users only
 *
 * Stores the frontend's structured event log on the submission record so that
 * missing-recording failures can be diagnosed without relying solely on
 * browser DevTools output.
 *
 * Request Body:
 * {
 *   submissionId: "esub_...",
 *   logs: [
 *     { timestamp, event, level, data }
 *   ]
 * }
 */
exports.handler = withHandler(async (ctx) => {
  const userId = ctx.userId;

  const body = ctx.body;
  const { submissionId, logs } = body;

  if (!submissionId) {
    return errorResponse(400, 'submissionId is required');
  }

  if (!Array.isArray(logs) || logs.length === 0) {
    return errorResponse(400, 'logs must be a non-empty array');
  }

  // Cap log entries to avoid oversized DynamoDB items
  const MAX_ENTRIES = 200;
  const trimmedLogs = logs.slice(0, MAX_ENTRIES);

  log.info('Saving client log entries', { count: trimmedLogs.length, submissionId });

  // Verify the submission exists and belongs to this user before writing.
  // If the submission doesn't exist (e.g. the submit call itself failed),
  // return 200 anyway — the logs are for debugging and we don't want to
  // suppress them just because the submission record is missing.
  const existing = await dynamodb.send(new GetCommand({
    TableName: SUBMISSIONS_TABLE,
    Key: { submissionId },
  }));

  if (!existing.Item) {
    log.warn('Submission not found for client logs, discarding', { submissionId });
    return successResponse(200, { message: 'Submission not found — logs discarded', submissionId });
  }

  if (existing.Item.userId !== userId) {
    return errorResponse(403, 'Forbidden');
  }

  await dynamodb.send(new UpdateCommand({
    TableName: SUBMISSIONS_TABLE,
    Key: { submissionId },
    UpdateExpression: 'SET clientLogs = :logs, updatedAt = :updatedAt',
    ExpressionAttributeValues: {
      ':logs': trimmedLogs,
      ':updatedAt': new Date().toISOString(),
    },
  }));

  log.info('Client logs saved successfully', { submissionId });

  return successResponse(200, {
    message: 'Client logs saved',
    submissionId,
    entriesSaved: trimmedLogs.length,
  });
});
