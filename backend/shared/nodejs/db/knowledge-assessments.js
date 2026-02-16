const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, DeleteCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

/**
 * Create a new knowledge assessment
 * @param {object} data - Assessment data
 * @returns {Promise<object>} Created assessment
 */
async function createKnowledgeAssessment(data) {
  const milestoneId = data.milestoneId || `knowledge_${Date.now()}`;
  
  const params = {
    TableName: process.env.MILESTONES_TABLE,
    Item: {
      milestoneId,
      type: 'knowledge',
      title: data.title,
      description: data.description || '',
      timeLimit: data.timeLimit || 30,
      passingScore: data.passingScore || 70,
      questions: data.questions || [],
      bcdiplomaTemplateId: data.bcdiplomaTemplateId || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  };
  
  await dynamodb.send(new PutCommand(params));
  return params.Item;
}

/**
 * Get a knowledge assessment by ID
 * @param {string} milestoneId - Assessment ID
 * @returns {Promise<object|null>} Assessment or null
 */
async function getKnowledgeAssessment(milestoneId) {
  const params = {
    TableName: process.env.MILESTONES_TABLE,
    Key: { milestoneId }
  };
  
  const result = await dynamodb.send(new GetCommand(params));
  
  // Verify it's a knowledge assessment
  if (result.Item && result.Item.type !== 'knowledge') {
    return null;
  }
  
  return result.Item;
}

/**
 * Get all knowledge assessments
 * @returns {Promise<object[]>} Array of assessments
 */
async function getAllKnowledgeAssessments() {
  const params = {
    TableName: process.env.MILESTONES_TABLE,
    FilterExpression: '#type = :type',
    ExpressionAttributeNames: { '#type': 'type' },
    ExpressionAttributeValues: { ':type': 'knowledge' }
  };
  
  const result = await dynamodb.send(new ScanCommand(params));
  return result.Items || [];
}

/**
 * Update a knowledge assessment
 * @param {string} milestoneId - Assessment ID
 * @param {object} updates - Fields to update
 * @returns {Promise<object>} Updated assessment
 */
async function updateKnowledgeAssessment(milestoneId, updates) {
  const updateExpressions = [];
  const expressionAttributeNames = { '#type': 'type' };
  const expressionAttributeValues = {};
  
  if (updates.title !== undefined) {
    updateExpressions.push('#title = :title');
    expressionAttributeNames['#title'] = 'title';
    expressionAttributeValues[':title'] = updates.title;
  }
  
  if (updates.description !== undefined) {
    updateExpressions.push('description = :description');
    expressionAttributeValues[':description'] = updates.description;
  }
  
  if (updates.timeLimit !== undefined) {
    updateExpressions.push('timeLimit = :timeLimit');
    expressionAttributeValues[':timeLimit'] = updates.timeLimit;
  }
  
  if (updates.passingScore !== undefined) {
    updateExpressions.push('passingScore = :passingScore');
    expressionAttributeValues[':passingScore'] = updates.passingScore;
  }
  
  if (updates.questions !== undefined) {
    updateExpressions.push('questions = :questions');
    expressionAttributeValues[':questions'] = updates.questions;
  }
  
  if (updates.bcdiplomaTemplateId !== undefined) {
    updateExpressions.push('bcdiplomaTemplateId = :bcdiplomaTemplateId');
    expressionAttributeValues[':bcdiplomaTemplateId'] = updates.bcdiplomaTemplateId;
  }
  
  updateExpressions.push('updatedAt = :updatedAt');
  expressionAttributeValues[':updatedAt'] = new Date().toISOString();
  
  const params = {
    TableName: process.env.MILESTONES_TABLE,
    Key: { milestoneId },
    UpdateExpression: `SET ${updateExpressions.join(', ')}`,
    ConditionExpression: '#type = :typeCondition',
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: {
      ...expressionAttributeValues,
      ':typeCondition': 'knowledge'
    },
    ReturnValues: 'ALL_NEW'
  };
  
  const result = await dynamodb.send(new UpdateCommand(params));
  return result.Attributes;
}

/**
 * Delete a knowledge assessment
 * @param {string} milestoneId - Assessment ID
 * @returns {Promise<boolean>} Success
 */
async function deleteKnowledgeAssessment(milestoneId) {
  // First verify it's a knowledge assessment
  const existing = await getKnowledgeAssessment(milestoneId);
  if (!existing) {
    throw new Error('Knowledge assessment not found');
  }
  
  const params = {
    TableName: process.env.MILESTONES_TABLE,
    Key: { milestoneId }
  };
  
  await dynamodb.send(new DeleteCommand(params));
  return true;
}

module.exports = {
  createKnowledgeAssessment,
  getKnowledgeAssessment,
  getAllKnowledgeAssessments,
  updateKnowledgeAssessment,
  deleteKnowledgeAssessment
};