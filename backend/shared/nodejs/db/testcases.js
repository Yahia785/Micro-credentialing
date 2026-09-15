const crypto = require('crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, DeleteCommand, QueryCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

/**
 * Create a new test case in DynamoDB
 * @param {object} testCaseData - The test case data
 * @returns {object} The created test case
 */
async function createTestCase(testCaseData) {
  const params = {
    TableName: process.env.TESTCASES_TABLE,
    Item: {
      testCaseId: testCaseData.testCaseId || `test_${crypto.randomUUID()}`,
      milestoneId: testCaseData.milestoneId,
      input: testCaseData.input,
      expectedOutput: testCaseData.expectedOutput,
      isHidden: testCaseData.isHidden !== undefined ? testCaseData.isHidden : false,
      includeInJudge0: testCaseData.includeInJudge0 !== undefined ? testCaseData.includeInJudge0 : true,
      weight: testCaseData.weight || 1,
      order: testCaseData.order || 0,
      testTier: testCaseData.testTier || 'standard',
      createdAt: new Date().toISOString()
    }
  };
  
  await dynamodb.send(new PutCommand(params));
  return params.Item;
}

/**
 * Create multiple test cases in batch
 * @param {Array} testCasesArray - Array of test case objects
 * @returns {Array} Array of created test cases
 */
async function createTestCasesBatch(testCasesArray) {
  const tableName = process.env.TESTCASES_TABLE;
  const createdTestCases = [];
  
  // DynamoDB BatchWrite supports max 25 items per request
  const batchSize = 25;
  
  for (let i = 0; i < testCasesArray.length; i += batchSize) {
    const batch = testCasesArray.slice(i, i + batchSize);
    
    const putRequests = batch.map(tc => {
      const item = {
        testCaseId: tc.testCaseId || `test_${crypto.randomUUID()}`,
        milestoneId: tc.milestoneId,
        input: tc.input,
        expectedOutput: tc.expectedOutput,
        isHidden: tc.isHidden !== undefined ? tc.isHidden : false,
        includeInJudge0: tc.includeInJudge0 !== undefined ? tc.includeInJudge0 : true,
        weight: tc.weight || 1,
        order: tc.order || 0,
        testTier: tc.testTier || 'standard',
        createdAt: new Date().toISOString()
      };
      
      createdTestCases.push(item);
      
      return {
        PutRequest: {
          Item: item
        }
      };
    });
    
    const params = {
      RequestItems: {
        [tableName]: putRequests
      }
    };
    
    await dynamodb.send(new BatchWriteCommand(params));
  }
  
  return createdTestCases;
}

/**
 * Get a test case by testCaseId
 * @param {string} testCaseId - The test case ID
 * @returns {object|null} The test case data or null if not found
 */
async function getTestCase(testCaseId) {
  const params = {
    TableName: process.env.TESTCASES_TABLE,
    Key: { testCaseId }
  };
  
  const result = await dynamodb.send(new GetCommand(params));
  return result.Item;
}

/**
 * Get all test cases for a milestone
 * @param {string} milestoneId - The milestone ID
 * @returns {Array} Array of test cases
 */
async function getTestCasesByMilestone(milestoneId) {
  const params = {
    TableName: process.env.TESTCASES_TABLE,
    IndexName: 'MilestoneIdIndex',
    KeyConditionExpression: 'milestoneId = :milestoneId',
    ExpressionAttributeValues: {
      ':milestoneId': milestoneId
    }
  };
  
  const result = await dynamodb.send(new QueryCommand(params));
  return result.Items || [];
}

/**
 * Get test cases for Judge0 submission (only those marked includeInJudge0 = true)
 * @param {string} milestoneId - The milestone ID
 * @returns {Array} Array of test cases for Judge0
 */
async function getJudge0TestCases(milestoneId) {
  const allTestCases = await getTestCasesByMilestone(milestoneId);
  return allTestCases.filter(tc => tc.includeInJudge0 === true);
}

/**
 * Update a test case
 * @param {string} testCaseId - The test case ID
 * @param {object} updates - The fields to update
 * @returns {object} The updated test case
 */
async function updateTestCase(testCaseId, updates) {
  const updateExpressions = [];
  const expressionAttributeNames = {};
  const expressionAttributeValues = {};
  
  if (updates.input !== undefined) {
    updateExpressions.push('#input = :input');
    expressionAttributeNames['#input'] = 'input';
    expressionAttributeValues[':input'] = updates.input;
  }
  
  if (updates.expectedOutput !== undefined) {
    updateExpressions.push('expectedOutput = :expectedOutput');
    expressionAttributeValues[':expectedOutput'] = updates.expectedOutput;
  }
  
  if (updates.isHidden !== undefined) {
    updateExpressions.push('isHidden = :isHidden');
    expressionAttributeValues[':isHidden'] = updates.isHidden;
  }
  
  if (updates.includeInJudge0 !== undefined) {
    updateExpressions.push('includeInJudge0 = :includeInJudge0');
    expressionAttributeValues[':includeInJudge0'] = updates.includeInJudge0;
  }
  
  if (updates.weight !== undefined) {
    updateExpressions.push('weight = :weight');
    expressionAttributeValues[':weight'] = updates.weight;
  }
  
  if (updates.order !== undefined) {
    updateExpressions.push('#order = :order');
    expressionAttributeNames['#order'] = 'order';
    expressionAttributeValues[':order'] = updates.order;
  }
  
  if (updates.testTier !== undefined) {
    updateExpressions.push('testTier = :testTier');
    expressionAttributeValues[':testTier'] = updates.testTier;
  }
  
  if (updateExpressions.length === 0) {
    throw new Error('No fields to update');
  }
  
  const params = {
    TableName: process.env.TESTCASES_TABLE,
    Key: { testCaseId },
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
 * Delete a test case
 * @param {string} testCaseId - The test case ID
 * @returns {boolean} True if deleted successfully
 */
async function deleteTestCase(testCaseId) {
  const params = {
    TableName: process.env.TESTCASES_TABLE,
    Key: { testCaseId }
  };
  
  await dynamodb.send(new DeleteCommand(params));
  return true;
}

/**
 * Delete all test cases for a milestone
 * @param {string} milestoneId - The milestone ID
 * @returns {number} Number of test cases deleted
 */
async function deleteTestCasesByMilestone(milestoneId) {
  const testCases = await getTestCasesByMilestone(milestoneId);
  
  if (testCases.length === 0) {
    return 0;
  }
  
  // Delete in batches of 25 (DynamoDB limit)
  const batchSize = 25;
  let deletedCount = 0;
  
  for (let i = 0; i < testCases.length; i += batchSize) {
    const batch = testCases.slice(i, i + batchSize);
    
    const deleteRequests = batch.map(tc => ({
      DeleteRequest: {
        Key: { testCaseId: tc.testCaseId }
      }
    }));
    
    const params = {
      RequestItems: {
        [process.env.TESTCASES_TABLE]: deleteRequests
      }
    };
    
    await dynamodb.send(new BatchWriteCommand(params));
    deletedCount += batch.length;
  }
  
  return deletedCount;
}

module.exports = {
  createTestCase,
  createTestCasesBatch,
  getTestCase,
  getTestCasesByMilestone,
  getJudge0TestCases,
  updateTestCase,
  deleteTestCase,
  deleteTestCasesByMilestone
};