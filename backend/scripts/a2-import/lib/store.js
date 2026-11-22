// S3 and DynamoDB for the A2 pilot import. The SDK classes are injected (`sdk`) so tests can use fakes; the real ones come from the shared
// layer folder. Files go to the recordings bucket under a2-pilot/<importId>/ with server-side encryption AES256, which is how that bucket
// is encrypted by default (SSE-S3). Nothing here logs code.
const { DEFAULT_BUCKET, DEFAULT_REGION, S3_PREFIX, sharedRequire, normalizeUsername } = require('./common');

function realSdk() {
  const s3 = sharedRequire('@aws-sdk/client-s3');
  const ddb = sharedRequire('@aws-sdk/lib-dynamodb');
  const { DynamoDBClient } = sharedRequire('@aws-sdk/client-dynamodb');
  return { s3, ddb, DynamoDBClient };
}

/**
 * @param {{ table: string, bucket?: string, region?: string, sdk?: object, s3?: object, ddb?: object }} options
 *   sdk: { PutObjectCommand, DeleteObjectCommand, PutCommand, QueryCommand, ScanCommand, DeleteCommand }; s3 / ddb: clients with send().
 */
function makeStore({ table, bucket = DEFAULT_BUCKET, region = DEFAULT_REGION, sdk, s3, ddb }) {
  let commands = sdk;
  let s3Client = s3;
  let ddbClient = ddb;
  if (!commands) {
    const real = realSdk();
    commands = { ...real.s3, ...real.ddb };
    s3Client = s3Client || new real.s3.S3Client({ region });
    ddbClient = ddbClient || real.ddb.DynamoDBDocumentClient.from(new real.DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } });
  }
  const safeKey = (key) => {
    if (typeof key !== 'string' || !key.startsWith(`${S3_PREFIX}/`) || key.includes('..')) throw new Error(`refusing to touch an S3 key outside ${S3_PREFIX}/`);
    return key;
  };

  return {
    bucket,
    table,

    /** Upload functions.h and functions.cpp of one import. */
    async putFiles(keys, header, source) {
      const put = (key, body) => s3Client.send(new commands.PutObjectCommand({ Bucket: bucket, Key: safeKey(key), Body: body, ContentType: 'text/plain; charset=utf-8', ServerSideEncryption: 'AES256' }));
      if (typeof header === 'string') await put(keys.header, header);
      await put(keys.source, source);
    },

    async putRecord(record) {
      await ddbClient.send(new commands.PutCommand({ TableName: table, Item: record, ConditionExpression: 'attribute_not_exists(importId)' }));
    },

    /** Every record of one GitHub username (through GithubUsernameIndex). */
    async findByUsername(username) {
      const items = [];
      let key;
      do {
        const r = await ddbClient.send(new commands.QueryCommand({
          TableName: table,
          IndexName: 'GithubUsernameIndex',
          KeyConditionExpression: 'githubUsername = :u',
          ExpressionAttributeValues: { ':u': normalizeUsername(username) },
          ExclusiveStartKey: key,
        }));
        items.push(...(r.Items || []));
        key = r.LastEvaluatedKey;
      } while (key);
      return items;
    },

    /** Every record in the table (a few hundred at most in a pilot). */
    async scanAll() {
      const items = [];
      let key;
      do {
        const r = await ddbClient.send(new commands.ScanCommand({ TableName: table, ExclusiveStartKey: key }));
        items.push(...(r.Items || []));
        key = r.LastEvaluatedKey;
      } while (key);
      return items;
    },

    /** The text of one stored file. */
    async getFile(key) {
      const r = await s3Client.send(new commands.GetObjectCommand({ Bucket: bucket, Key: safeKey(key) }));
      return r.Body.transformToString('utf-8');
    },

    /** Set the plan field of a record. Nothing else in the record is changed. */
    async setPlan(importId, plan) {
      await ddbClient.send(new commands.UpdateCommand({
        TableName: table,
        Key: { importId },
        UpdateExpression: 'SET #plan = :plan',
        ConditionExpression: 'attribute_exists(importId)',
        ExpressionAttributeNames: { '#plan': 'plan' },
        ExpressionAttributeValues: { ':plan': plan },
      }));
    },

    async deleteObject(key) {
      await s3Client.send(new commands.DeleteObjectCommand({ Bucket: bucket, Key: safeKey(key) }));
    },

    async deleteRecord(importId) {
      await ddbClient.send(new commands.DeleteCommand({ TableName: table, Key: { importId } }));
    },
  };
}

module.exports = { makeStore };
