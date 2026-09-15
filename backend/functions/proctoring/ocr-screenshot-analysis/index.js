const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { TextractClient, DetectDocumentTextCommand } = require('@aws-sdk/client-textract');
const { withHandler } = require('/opt/nodejs/middleware/handler');
const { errorResponse } = require('/opt/nodejs/utils/errors');
const log = require('/opt/nodejs/utils/logger');

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});
const textractClient = new TextractClient({});

const SUBMISSIONS_TABLE = process.env.SUBMISSIONS_TABLE;
const PROCTORING_BUCKET = process.env.PROCTORING_BUCKET_NAME;
const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || '').split(',').map(d => d.trim().toLowerCase());
const FORBIDDEN_DOMAINS = (process.env.FORBIDDEN_DOMAINS || '').split(',').map(d => d.trim().toLowerCase());

// Textract rate limiting configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000; // Start with 1 second, then exponential backoff

/**
 * Lambda handler for OCR screenshot analysis
 *
 * Expected input:
 * {
 *   "submissionId": "string",
 *   "s3Key": "string",  // e.g., "screenshots/sub_123/1234567890.jpg"
 *   "timestamp": "string"  // ISO timestamp when screenshot was captured
 * }
 */
exports.handler = withHandler(async (ctx) => {
  // Parse request body
  const body = ctx.body;
  const { submissionId, s3Key, timestamp } = body;

  // Validation
  if (!submissionId || !s3Key || !timestamp) {
    return errorResponse(400, 'Missing required fields: submissionId, s3Key, timestamp');
  }

  log.info('Analyzing screenshot', { submissionId, s3Key });

  // STEP 1: Fetch screenshot from S3
  let imageBytes;
  try {
    imageBytes = await fetchScreenshotFromS3(s3Key);
    log.info('Fetched screenshot from S3', { size: imageBytes.length });
  } catch (error) {
    log.error('Failed to fetch screenshot from S3', { error: error.message });

    // Save error status to DynamoDB
    await saveAnalysisError(submissionId, timestamp, s3Key, 'S3_FETCH_FAILED', error.message);

    return errorResponse(500, `Failed to fetch screenshot from S3: ${error.message}`);
  }

  // STEP 2: Run Textract OCR with retry logic
  let extractedText;
  try {
    extractedText = await runTextractOcrWithRetry(imageBytes);
    log.info('Textract extracted text', { length: extractedText.length, preview: extractedText.substring(0, 200) });
  } catch (error) {
    log.error('Textract OCR failed after retries', { error: error.message });

    // Save error status to DynamoDB
    await saveAnalysisError(submissionId, timestamp, s3Key, 'TEXTRACT_FAILED', error.message);

    // Don't fail the entire request - mark as unknown and continue
    extractedText = '';
    log.warn('Continuing with empty text due to Textract failure', { submissionId });
  }

  // STEP 3: Analyze text for violations
  const analysisResult = analyzeTextForViolations(extractedText);
  log.info('Analysis result', { analysisResult });

  // STEP 4: Save analysis to DynamoDB
  try {
    await saveAnalysisToDynamoDB(submissionId, timestamp, s3Key, analysisResult, extractedText);
    log.info('Saved analysis to DynamoDB', { submissionId });
  } catch (error) {
    log.error('Failed to save to DynamoDB', { error: error.message });
    return errorResponse(500, `Failed to save analysis: ${error.message}`);
  }

  return {
    message: 'Screenshot analyzed successfully',
    submissionId,
    timestamp,
    status: analysisResult.status,
    violationsDetected: analysisResult.forbiddenDomains.length > 0,
    extractedTextLength: extractedText.length
  };
});

/**
 * Fetch screenshot from S3
 */
async function fetchScreenshotFromS3(s3Key) {
  const command = new GetObjectCommand({
    Bucket: PROCTORING_BUCKET,
    Key: s3Key
  });

  const response = await s3Client.send(command);

  // Convert stream to buffer
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Run AWS Textract OCR with exponential backoff retry logic
 */
async function runTextractOcrWithRetry(imageBytes, retryCount = 0) {
  try {
    return await runTextractOcr(imageBytes);
  } catch (error) {
    // Check if error is retryable
    const isRetryable = isRetryableError(error);

    if (isRetryable && retryCount < MAX_RETRIES) {
      // Calculate exponential backoff delay
      const delayMs = RETRY_DELAY_MS * Math.pow(2, retryCount);

      log.warn('Textract error, retrying', { attempt: retryCount + 1, maxAttempts: MAX_RETRIES + 1, error: error.message, delayMs });

      // Wait before retrying
      await sleep(delayMs);

      // Retry with incremented count
      return await runTextractOcrWithRetry(imageBytes, retryCount + 1);
    }

    // If not retryable or max retries reached, throw error
    log.error('Textract failed permanently', { error: error.message });
    throw error;
  }
}

/**
 * Run AWS Textract OCR on image
 */
async function runTextractOcr(imageBytes) {
  const command = new DetectDocumentTextCommand({
    Document: {
      Bytes: imageBytes
    }
  });

  const response = await textractClient.send(command);

  // Extract text from Textract response (only LINE blocks)
  const textLines = response.Blocks
    .filter(block => block.BlockType === 'LINE')
    .map(block => block.Text)
    .join(' ');

  return textLines;
}

/**
 * Determine if a Textract error is retryable
 */
function isRetryableError(error) {
  const retryableErrorCodes = [
    'ProvisionedThroughputExceededException',  // Rate limit exceeded
    'ThrottlingException',                      // Throttled
    'ServiceUnavailable',                       // Service temporarily unavailable
    'InternalServerError',                      // AWS internal error
    'RequestTimeout',                           // Request timed out
    'TooManyRequestsException'                  // Too many requests
  ];

  // Check if error code matches any retryable errors
  const errorCode = error.name || error.code || error.$metadata?.httpStatusCode;

  return retryableErrorCodes.some(code =>
    errorCode && errorCode.includes(code)
  ) || (error.$metadata?.httpStatusCode >= 500); // Retry on 5xx errors
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Analyze extracted text for violations
 */
function analyzeTextForViolations(text) {
  const lowerText = text.toLowerCase();

  // Find detected domains
  const detectedAllowed = ALLOWED_DOMAINS.filter(domain => lowerText.includes(domain));
  const detectedForbidden = FORBIDDEN_DOMAINS.filter(domain => lowerText.includes(domain));

  // Determine status
  let status = 'unknown';
  if (detectedForbidden.length > 0) {
    status = 'violation';
  } else if (detectedAllowed.length > 0) {
    status = 'compliant';
  }

  return {
    status,
    allowedDomains: detectedAllowed,
    forbiddenDomains: detectedForbidden,
    hasAllowed: detectedAllowed.length > 0,
    hasForbidden: detectedForbidden.length > 0
  };
}

/**
 * Save analysis results to DynamoDB
 */
async function saveAnalysisToDynamoDB(submissionId, timestamp, s3Key, analysisResult, extractedText) {
  const command = new UpdateCommand({
    TableName: SUBMISSIONS_TABLE,
    Key: { submissionId },
    UpdateExpression: 'SET proctoringData.screenshots.#ts = :screenshotData',
    ExpressionAttributeNames: {
      '#ts': timestamp
    },
    ExpressionAttributeValues: {
      ':screenshotData': {
        s3Key,
        status: analysisResult.status,
        detectedURLs: [...analysisResult.allowedDomains, ...analysisResult.forbiddenDomains],
        hasAllowed: analysisResult.hasAllowed,
        hasForbidden: analysisResult.hasForbidden,
        extractedText: extractedText.substring(0, 500), // Store first 500 chars for debugging
        analyzedAt: new Date().toISOString(),
        error: null // Clear any previous errors
      }
    }
  });

  await docClient.send(command);
  log.info('Saved analysis', { submissionId, timestamp });
}

/**
 * Save error status to DynamoDB when analysis fails
 */
async function saveAnalysisError(submissionId, timestamp, s3Key, errorType, errorMessage) {
  try {
    const command = new UpdateCommand({
      TableName: SUBMISSIONS_TABLE,
      Key: { submissionId },
      UpdateExpression: 'SET proctoringData.screenshots.#ts = :screenshotData',
      ExpressionAttributeNames: {
        '#ts': timestamp
      },
      ExpressionAttributeValues: {
        ':screenshotData': {
          s3Key,
          status: 'error',
          error: {
            type: errorType,
            message: errorMessage.substring(0, 200), // Limit error message length
            occurredAt: new Date().toISOString()
          },
          analyzedAt: new Date().toISOString()
        }
      }
    });

    await docClient.send(command);
    log.warn('Saved error status', { submissionId, timestamp, errorType });
  } catch (dbError) {
    log.error('Failed to save error to DynamoDB', { error: dbError.message });
    // Don't throw - this is a best-effort error logging
  }
}
