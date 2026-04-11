const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

/**
 * Get submissions pending review (passed tests but not yet reviewed)
 * Uses paginated scan to ensure ALL matching items are found.
 * @param {number} limit - Maximum number of results to return
 * @param {string} filter - 'passed', 'failed', or 'all'
 * @returns {Array} Array of submissions pending review
 */
async function getPendingReviews(limit = 50, filter = 'all') {
  let filterExpression = 'proctoringData.reviewStatus = :pending';
  const expressionAttributeValues = {
    ':pending': 'pending'
  };
  const expressionAttributeNames = {};

  if (filter === 'passed') {
    filterExpression += ' AND #status = :status';
    expressionAttributeNames['#status'] = 'status';
    expressionAttributeValues[':status'] = 'passed';
  } else if (filter === 'failed') {
    filterExpression += ' AND #status = :status';
    expressionAttributeNames['#status'] = 'status';
    expressionAttributeValues[':status'] = 'failed';
  }

  const allItems = [];
  let lastEvaluatedKey = undefined;

  do {
    const params = {
      TableName: process.env.SUBMISSIONS_TABLE,
      FilterExpression: filterExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ...(Object.keys(expressionAttributeNames).length > 0 && {
        ExpressionAttributeNames: expressionAttributeNames
      }),
      ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey })
    };

    const result = await dynamodb.send(new ScanCommand(params));
    
    if (result.Items) {
      allItems.push(...result.Items);
    }

    lastEvaluatedKey = result.LastEvaluatedKey;

    // Stop early if we already have enough results
    if (allItems.length >= limit) {
      break;
    }
  } while (lastEvaluatedKey);

  return allItems.slice(0, limit);
}

/**
 * Get reviewed submissions (approved or rejected)
 * Uses paginated scan to ensure ALL matching items are found.
 * @param {number} limit - Maximum number of results
 * @returns {Array} Array of reviewed submissions
 */
async function getReviewedSubmissions(limit = 50) {
  const allItems = [];
  let lastEvaluatedKey = undefined;

  do {
    const params = {
      TableName: process.env.SUBMISSIONS_TABLE,
      FilterExpression: 'proctoringData.reviewStatus IN (:approved, :rejected)',
      ExpressionAttributeValues: {
        ':approved': 'approved',
        ':rejected': 'rejected'
      },
      ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey })
    };

    const result = await dynamodb.send(new ScanCommand(params));

    if (result.Items) {
      allItems.push(...result.Items);
    }

    lastEvaluatedKey = result.LastEvaluatedKey;

    if (allItems.length >= limit) {
      break;
    }
  } while (lastEvaluatedKey);

  return allItems.slice(0, limit);
}

/**
 * Approve a submission's proctoring review
 * @param {string} submissionId - The submission ID
 * @param {string} reviewedBy - The admin's user ID
 * @param {string} reviewNotes - Optional review notes
 * @returns {object} The updated submission
 */
async function approveReview(submissionId, reviewedBy, reviewNotes = '') {
  const params = {
    TableName: process.env.SUBMISSIONS_TABLE,
    Key: { submissionId },
    UpdateExpression: 'SET proctoringData.reviewStatus = :approved, proctoringData.reviewedBy = :reviewedBy, proctoringData.reviewedAt = :reviewedAt, proctoringData.reviewNotes = :reviewNotes, updatedAt = :updatedAt',
    ExpressionAttributeValues: {
      ':approved': 'approved',
      ':reviewedBy': reviewedBy,
      ':reviewedAt': new Date().toISOString(),
      ':reviewNotes': reviewNotes,
      ':updatedAt': new Date().toISOString()
    },
    ReturnValues: 'ALL_NEW'
  };
  
  const result = await dynamodb.send(new UpdateCommand(params));
  return result.Attributes;
}

/**
 * Reject a submission's proctoring review
 * @param {string} submissionId - The submission ID
 * @param {string} reviewedBy - The admin's user ID
 * @param {string} rejectionReason - Reason for rejection
 * @returns {object} The updated submission
 */
async function rejectReview(submissionId, reviewedBy, rejectionReason) {
  const params = {
    TableName: process.env.SUBMISSIONS_TABLE,
    Key: { submissionId },
    UpdateExpression: 'SET proctoringData.reviewStatus = :rejected, proctoringData.reviewedBy = :reviewedBy, proctoringData.reviewedAt = :reviewedAt, proctoringData.reviewNotes = :rejectionReason, #status = :failed, updatedAt = :updatedAt',
    ExpressionAttributeNames: {
      '#status': 'status'
    },
    ExpressionAttributeValues: {
      ':rejected': 'rejected',
      ':reviewedBy': reviewedBy,
      ':reviewedAt': new Date().toISOString(),
      ':rejectionReason': rejectionReason,
      ':failed': 'failed',
      ':updatedAt': new Date().toISOString()
    },
    ReturnValues: 'ALL_NEW'
  };
  
  const result = await dynamodb.send(new UpdateCommand(params));
  return result.Attributes;
}

module.exports = {
  getPendingReviews,
  getReviewedSubmissions,
  approveReview,
  rejectReview
};