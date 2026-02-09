const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { TextractClient, DetectDocumentTextCommand } = require('@aws-sdk/client-textract');
const { corsHeaders } = require('/opt/nodejs/cors-middleware');
const { errorResponse } = require('/opt/nodejs/responses');

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});
const textractClient = new TextractClient({});

const SUBMISSIONS_TABLE = process.env.SUBMISSIONS_TABLE;
const PROCTORING_BUCKET = process.env.PROCTORING_BUCKET_NAME;
const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || '').split(',').map(d => d.trim().toLowerCase());
const FORBIDDEN_DOMAINS = (process.env.FORBIDDEN_DOMAINS || '').split(',').map(d => d.trim().toLowerCase());

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
exports.handler = async (event) => {
  console.log('OCR Screenshot Analysis Event:', JSON.stringify(event, null, 2));

  try {
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { submissionId, s3Key, timestamp } = body;

    // Validation
    if (!submissionId || !s3Key || !timestamp) {
      return errorResponse(400, 'Missing required fields: submissionId, s3Key, timestamp', corsHeaders);
    }

    console.log(`Analyzing screenshot for submission ${submissionId}, key: ${s3Key}`);

    // STEP 1: Fetch screenshot from S3
    const imageBytes = await fetchScreenshotFromS3(s3Key);

    // STEP 2: Run Textract OCR
    const extractedText = await runTextractOcr(imageBytes);
    console.log('Extracted text:', extractedText);

    // STEP 3: Analyze text for violations
    const analysisResult = analyzeTextForViolations(extractedText);
    console.log('Analysis result:', analysisResult);

    // STEP 4: Save analysis to DynamoDB
    await saveAnalysisToDynamoDB(submissionId, timestamp, s3Key, analysisResult, extractedText);

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        message: 'Screenshot analyzed successfully',
        submissionId,
        timestamp,
        status: analysisResult.status,
        violationsDetected: analysisResult.forbiddenDomains.length > 0
      })
    };

  } catch (error) {
    console.error('Error in OCR analysis:', error);
    return errorResponse(500, `OCR analysis failed: ${error.message}`, corsHeaders);
  }
};

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
 * Run AWS Textract OCR on image
 */
async function runTextractOcr(imageBytes) {
  const command = new DetectDocumentTextCommand({
    Document: {
      Bytes: imageBytes
    }
  });

  const response = await textractClient.send(command);
  
  // Extract text from Textract response
  const textLines = response.Blocks
    .filter(block => block.BlockType === 'LINE')
    .map(block => block.Text)
    .join(' ');

  return textLines;
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
        analyzedAt: new Date().toISOString()
      }
    }
  });

  await docClient.send(command);
  console.log(`Saved analysis for ${submissionId} at ${timestamp}`);
}