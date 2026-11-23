/**
 * Read access to the A2 pilot's imported submissions: the record (with its plan) from the ImportedSubmissions table and the student's two
 * files from S3 (a2-pilot/<importId>/). Read only: the import scripts write them. Only keys under a2-pilot/ are ever read.
 *
 * The record holds the GitHub username. It is read here only to show an admin who a practice record is; it is never copied into an
 * interview, a log line or a model request (see plan-config.js, which removes it from the plan).
 */
const { NotFoundError, ValidationError } = require('../utils/errors');

const S3_PREFIX = 'a2-pilot';
const IMPORT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const tableName = () => process.env.IMPORTED_SUBMISSIONS_TABLE;
const bucketName = () => process.env.PROCTORING_BUCKET_NAME || 'micro-credentialing-recordings';

let clients;
function realClients() {
  if (!clients) {
    const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
    const ddb = require('@aws-sdk/lib-dynamodb');
    const s3 = require('@aws-sdk/client-s3');
    clients = {
      ddb: { client: ddb.DynamoDBDocumentClient.from(new DynamoDBClient({})), GetCommand: ddb.GetCommand, ScanCommand: ddb.ScanCommand },
      s3: { client: new s3.S3Client({}), GetObjectCommand: s3.GetObjectCommand },
    };
  }
  return clients;
}

/** The two S3 keys of one import. The importId must be a UUID, so a key can never leave a2-pilot/<importId>/. */
function keysFor(importId) {
  if (typeof importId !== 'string' || !IMPORT_ID_PATTERN.test(importId)) throw new ValidationError('importId must be an import id');
  return { header: `${S3_PREFIX}/${importId}/functions.h`, source: `${S3_PREFIX}/${importId}/functions.cpp` };
}

/** One record, or a NotFoundError. */
async function getRecord(importId, { ddb = realClients().ddb } = {}) {
  keysFor(importId);
  const result = await ddb.client.send(new ddb.GetCommand({ TableName: tableName(), Key: { importId } }));
  if (!result.Item) throw new NotFoundError('Imported submission');
  return result.Item;
}

/** The text of one stored file (null when there is none). */
async function getFile(key, { s3 = realClients().s3 } = {}) {
  if (typeof key !== 'string' || !key.startsWith(`${S3_PREFIX}/`) || key.includes('..')) throw new Error('refusing to read an S3 key outside a2-pilot/');
  try {
    const result = await s3.client.send(new s3.GetObjectCommand({ Bucket: bucketName(), Key: key }));
    return await result.Body.transformToString('utf-8');
  } catch (error) {
    if (error && (error.name === 'NoSuchKey' || error.name === 'NotFound')) return null;
    throw error;
  }
}

/** The student's functions.cpp and functions.h (header is null when the student has none stored). */
async function getCode(importId, deps = {}) {
  const keys = keysFor(importId);
  const [source, header] = await Promise.all([getFile(keys.source, deps), getFile(keys.header, deps)]);
  return { code: source, header };
}

/** Every record as { importId, githubUsername, status, form } for an admin to choose from. Only these fields are read. */
async function listRecords({ ddb = realClients().ddb } = {}) {
  const items = [];
  let lastKey;
  do {
    const result = await ddb.client.send(new ddb.ScanCommand({
      TableName: tableName(),
      ProjectionExpression: 'importId, githubUsername, #status, #plan.form, #plan.noPlan',
      ExpressionAttributeNames: { '#status': 'status', '#plan': 'plan' },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items
    .map((item) => ({
      importId: item.importId,
      githubUsername: item.githubUsername,
      status: item.status,
      form: item.plan && item.plan.form ? item.plan.form : null,
      hasPlan: !!(item.plan && item.plan.form && !item.plan.noPlan),
    }))
    .sort((a, b) => String(a.githubUsername).localeCompare(String(b.githubUsername)));
}

module.exports = { getRecord, getFile, getCode, listRecords, keysFor, S3_PREFIX, IMPORT_ID_PATTERN };
