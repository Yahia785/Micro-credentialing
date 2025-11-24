const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, DeleteCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

/**
 * Create a new milestone (problem) in DynamoDB
 * @param {object} milestoneData - The milestone data
 * @returns {object} The created milestone
 */
async function createMilestone(milestoneData) {
  const params = {
    TableName: process.env.MILESTONES_TABLE,
    Item: {
      milestoneId: milestoneData.milestoneId || `milestone_${Date.now()}`,
      title: milestoneData.title,
      description: milestoneData.description,
      difficulty: milestoneData.difficulty || 'medium',
      concept: milestoneData.concept || '',
      language: milestoneData.language || 'python',
      starterCode: milestoneData.starterCode || '',
      timeLimit: milestoneData.timeLimit || 5000,
      memoryLimit: milestoneData.memoryLimit || 256000,
      sampleTestCases: milestoneData.sampleTestCases || [],
      testCaseCount: milestoneData.testCaseCount || 0,
      // NEW: BCdiploma template ID for this problem
      bcdiplomaTemplateId: milestoneData.bcdiplomaTemplateId || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  };
  
  await dynamodb.send(new PutCommand(params));
  return params.Item;
}

/**
 * Get a milestone by milestoneId
 * @param {string} milestoneId - The milestone ID
 * @returns {object|null} The milestone data or null if not found
 */
async function getMilestone(milestoneId) {
  const params = {
    TableName: process.env.MILESTONES_TABLE,
    Key: { milestoneId }
  };
  
  const result = await dynamodb.send(new GetCommand(params));
  return result.Item;
}

/**
 * Get all milestones
 * @returns {Array} Array of all milestones
 */
async function getAllMilestones() {
  const params = {
    TableName: process.env.MILESTONES_TABLE
  };
  
  const result = await dynamodb.send(new ScanCommand(params));
  return result.Items || [];
}

/**
 * Update a milestone
 * @param {string} milestoneId - The milestone ID
 * @param {object} updates - The fields to update
 * @returns {object} The updated milestone
 */
async function updateMilestone(milestoneId, updates) {
  // Build update expression dynamically based on what fields are provided
  const updateExpressions = [];
  const expressionAttributeNames = {};
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
  
  if (updates.difficulty !== undefined) {
    updateExpressions.push('difficulty = :difficulty');
    expressionAttributeValues[':difficulty'] = updates.difficulty;
  }
  
  if (updates.language !== undefined) {
    updateExpressions.push('#language = :language');
    expressionAttributeNames['#language'] = 'language';
    expressionAttributeValues[':language'] = updates.language;
  }
  
  if (updates.starterCode !== undefined) {
    updateExpressions.push('starterCode = :starterCode');
    expressionAttributeValues[':starterCode'] = updates.starterCode;
  }
  
  if (updates.timeLimit !== undefined) {
    updateExpressions.push('timeLimit = :timeLimit');
    expressionAttributeValues[':timeLimit'] = updates.timeLimit;
  }
  
  if (updates.memoryLimit !== undefined) {
    updateExpressions.push('memoryLimit = :memoryLimit');
    expressionAttributeValues[':memoryLimit'] = updates.memoryLimit;
  }
  
  if (updates.sampleTestCases !== undefined) {
    updateExpressions.push('sampleTestCases = :sampleTestCases');
    expressionAttributeValues[':sampleTestCases'] = updates.sampleTestCases;
  }
  
  if (updates.testCaseCount !== undefined) {
    updateExpressions.push('testCaseCount = :testCaseCount');
    expressionAttributeValues[':testCaseCount'] = updates.testCaseCount;
  }
  
  // NEW: Allow updating BCdiploma template ID
  if (updates.bcdiplomaTemplateId !== undefined) {
    updateExpressions.push('bcdiplomaTemplateId = :bcdiplomaTemplateId');
    expressionAttributeValues[':bcdiplomaTemplateId'] = updates.bcdiplomaTemplateId;
  }
  
  // Always update the updatedAt timestamp
  updateExpressions.push('updatedAt = :updatedAt');
  expressionAttributeValues[':updatedAt'] = new Date().toISOString();
  
  const params = {
    TableName: process.env.MILESTONES_TABLE,
    Key: { milestoneId },
    UpdateExpression: `SET ${updateExpressions.join(', ')}`,
    ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0 
      ? expressionAttributeNames 
      : undefined,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: 'ALL_NEW'
  };
  
  const result = await dynamodb.send(new UpdateCommand(params));
  return result.Attributes;
}

/**
 * Delete a milestone
 * @param {string} milestoneId - The milestone ID
 * @returns {boolean} True if deleted successfully
 */
async function deleteMilestone(milestoneId) {
  const params = {
    TableName: process.env.MILESTONES_TABLE,
    Key: { milestoneId }
  };
  
  await dynamodb.send(new DeleteCommand(params));
  return true;
}

module.exports = {
  createMilestone,
  getMilestone,
  getAllMilestones,
  updateMilestone,
  deleteMilestone
};