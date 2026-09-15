const crypto = require('crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, DeleteCommand, ScanCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { buildUpdateExpression } = require('./dynamo-utils');

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
      milestoneId: milestoneData.milestoneId || `milestone_${crypto.randomUUID()}`,
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
  const allItems = [];
  let lastEvaluatedKey;

  do {
    const params = {
      TableName: process.env.MILESTONES_TABLE,
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
 * Update a milestone
 * @param {string} milestoneId - The milestone ID
 * @param {object} updates - The fields to update
 * @returns {object} The updated milestone
 */
async function updateMilestone(milestoneId, updates) {
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

/**
 * Delete a milestone and all associated records (test cases, submissions, credentials).
 * Uses batch operations for efficiency.
 *
 * Note: credentials are intentionally NOT deleted here. Credentials are
 * permanent records — if a student earned one, it should survive even if the
 * instructor removes the milestone from the course. The orphaned credential
 * remains valid and viewable.
 */
async function deleteMilestoneWithCleanup(milestoneId) {
  const log = require('../utils/logger');

  // 1. Delete all test cases for this milestone
  const { getTestCasesByMilestone } = require('./testcases');
  const testCases = await getTestCasesByMilestone(milestoneId);
  if (testCases.length > 0) {
    const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
    // DynamoDB batch write accepts max 25 items per call
    const chunks = [];
    for (let i = 0; i < testCases.length; i += 25) {
      chunks.push(testCases.slice(i, i + 25));
    }
    for (const chunk of chunks) {
      await dynamodb.send(new BatchWriteCommand({
        RequestItems: {
          [process.env.TESTCASES_TABLE]: chunk.map(tc => ({
            DeleteRequest: { Key: { testCaseId: tc.testCaseId } }
          }))
        }
      }));
    }
    log.info('Deleted test cases for milestone', { milestoneId, count: testCases.length });
  }

  // 2. Delete all submissions for this milestone
  const { getSubmissionsByMilestone } = require('./submissions');
  const submissions = await getSubmissionsByMilestone(milestoneId);
  if (submissions.length > 0) {
    const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
    const chunks = [];
    for (let i = 0; i < submissions.length; i += 25) {
      chunks.push(submissions.slice(i, i + 25));
    }
    for (const chunk of chunks) {
      await dynamodb.send(new BatchWriteCommand({
        RequestItems: {
          [process.env.SUBMISSIONS_TABLE]: chunk.map(s => ({
            DeleteRequest: { Key: { submissionId: s.submissionId } }
          }))
        }
      }));
    }
    log.info('Deleted submissions for milestone', { milestoneId, count: submissions.length });
  }

  // 3. Delete the milestone itself
  await deleteMilestone(milestoneId);
  log.info('Deleted milestone', { milestoneId });

  return {
    deletedTestCases: testCases.length,
    deletedSubmissions: submissions.length,
  };
}

module.exports = {
  createMilestone,
  getMilestone,
  getAllMilestones,
  updateMilestone,
  deleteMilestone,
  deleteMilestoneWithCleanup
};