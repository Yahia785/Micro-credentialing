const crypto = require('crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, DeleteCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { buildUpdateExpression } = require('./dynamo-utils');

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

/**
 * Create a new embedded assessment
 * @param {object} data - Assessment data
 * @returns {Promise<object>} Created assessment
 */
async function createEmbeddedAssessment(data) {
  const milestoneId = data.milestoneId || `embedded_${crypto.randomUUID()}`;

  const params = {
    TableName: process.env.MILESTONES_TABLE,
    Item: {
      milestoneId,
      type: 'embedded',
      title: data.title,
      description: data.description || '',
      difficulty: data.difficulty || 'medium',
      rubric: data.rubric || [],
      bcdiplomaTemplateId: data.bcdiplomaTemplateId || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  };

  await dynamodb.send(new PutCommand(params));
  return params.Item;
}

/**
 * Get an embedded assessment by ID
 * @param {string} milestoneId - Assessment ID
 * @returns {Promise<object|null>} Assessment or null
 */
async function getEmbeddedAssessment(milestoneId) {
  const params = {
    TableName: process.env.MILESTONES_TABLE,
    Key: { milestoneId }
  };

  const result = await dynamodb.send(new GetCommand(params));

  if (result.Item && result.Item.type !== 'embedded') {
    return null;
  }

  return result.Item || null;
}

/**
 * Get all embedded assessments
 * @returns {Promise<Array>} Array of embedded assessments
 */
async function getAllEmbeddedAssessments() {
  const allItems = [];
  let lastEvaluatedKey;

  do {
    const params = {
      TableName: process.env.MILESTONES_TABLE,
      FilterExpression: '#type = :embedded',
      ExpressionAttributeNames: { '#type': 'type' },
      ExpressionAttributeValues: { ':embedded': 'embedded' },
      ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
    };

    const result = await dynamodb.send(new ScanCommand(params));
    if (result.Items) {
      allItems.push(...result.Items);
    }
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return allItems;
}

/**
 * Update an embedded assessment
 * @param {string} milestoneId - Assessment ID
 * @param {object} updates - Fields to update
 * @returns {Promise<object>} Updated assessment
 */
async function updateEmbeddedAssessment(milestoneId, updates) {
  const params = {
    TableName: process.env.MILESTONES_TABLE,
    Key: { milestoneId },
    ...buildUpdateExpression(updates),
    ReturnValues: 'ALL_NEW'
  };
  const result = await dynamodb.send(new UpdateCommand(params));
  return result.Attributes;
}

/**
 * Delete an embedded assessment
 * @param {string} milestoneId - Assessment ID
 * @returns {Promise<boolean>} True if deleted
 */
async function deleteEmbeddedAssessment(milestoneId) {
  const params = {
    TableName: process.env.MILESTONES_TABLE,
    Key: { milestoneId }
  };

  await dynamodb.send(new DeleteCommand(params));
  return true;
}

module.exports = {
  createEmbeddedAssessment,
  getEmbeddedAssessment,
  getAllEmbeddedAssessments,
  updateEmbeddedAssessment,
  deleteEmbeddedAssessment
};