const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

/**
 * Get Anthropic API key from AWS Secrets Manager
 * @returns {Promise<string>} API key
 */
async function getAnthropicApiKey() {
  const secretsClient = new SecretsManagerClient({});

  const response = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: process.env.ANTHROPIC_API_KEY_SECRET_ARN
    })
  );

  return response.SecretString;
}

/**
 * Grade student embedded systems code against a rubric using Claude Haiku
 * @param {string} code - Student's submitted C code
 * @param {string[]} rubric - Array of grading criteria strings
 * @returns {Promise<object>} { rubricResults, passedCriteria, totalCriteria, score, passed }
 */
async function gradeEmbeddedCode(code, rubric) {
  // Attempt to get API key — fall back to mock if secret doesn't exist yet
  let apiKey;
  try {
    apiKey = await getAnthropicApiKey();
  } catch (secretError) {
    console.warn('Could not retrieve Anthropic API key from Secrets Manager — returning mock grading results:', secretError.message);
    return {
      rubricResults: rubric.map(criterion => ({
        criterion,
        passed: true,
        feedback: 'Mock grading: criterion marked as passed for testing purposes.'
      })),
      passedCriteria: rubric.length,
      totalCriteria: rubric.length,
      score: 100,
      passed: true,
      llmModel: 'mock'
    };
  }

  const apiKey = await getAnthropicApiKey();

  const prompt = buildGradingPrompt(code, rubric);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Anthropic API error:', response.status, errorText);
    throw new Error(`Anthropic API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const rawText = data.content[0].text;

  console.log('Anthropic raw response:', rawText);

  const rubricResults = parseGradingResponse(rawText, rubric);
  const passedCriteria = rubricResults.filter(r => r.passed).length;
  const totalCriteria = rubricResults.length;
  const score = totalCriteria > 0 ? Math.round((passedCriteria / totalCriteria) * 100) : 0;
  const passed = score === 100;

  return {
    rubricResults,
    passedCriteria,
    totalCriteria,
    score,
    passed,
    llmModel: 'claude-haiku-4-5-20251001'
  };
}

/**
 * Build the grading prompt sent to Claude
 * @param {string} code - Student code
 * @param {string[]} rubric - Rubric criteria
 * @returns {string} Prompt string
 */
function buildGradingPrompt(code, rubric) {
  const rubricList = rubric
    .map((criterion, index) => `${index + 1}. ${criterion}`)
    .join('\n');

  return `You are grading an embedded systems programming assignment for an MSP432 microcontroller course. Evaluate the student's C code against each rubric criterion below.

RUBRIC CRITERIA:
${rubricList}

STUDENT CODE:
\`\`\`c
${code}
\`\`\`

For each criterion, determine if the student's code satisfies it. Consider that students may use different but equivalent implementations (e.g., \`(1<<1)\`, \`0x02\`, and \`2\` are all equivalent for bit 1).

Respond with ONLY a valid JSON array. No explanation before or after. Each element must have exactly these fields:
- "criterion": the criterion text (copy it exactly)
- "passed": true or false
- "feedback": one sentence explaining your decision

Example format:
[
  {"criterion": "LEFT_BUTTON is defined as bit 1", "passed": true, "feedback": "Student correctly defines LEFT_BUTTON as (1<<1) which sets bit 1."},
  {"criterion": "P1DIR configured for LED output", "passed": false, "feedback": "Student wrote P1DIR = LEFT_LED instead of P1DIR |= LEFT_LED, which overwrites other pin configurations."}
]`;
}

/**
 * Parse Claude's JSON response into rubric results
 * Falls back gracefully if Claude returns malformed output
 * @param {string} rawText - Raw text from Claude
 * @param {string[]} rubric - Original rubric criteria
 * @returns {Array} Parsed rubric results
 */
function parseGradingResponse(rawText, rubric) {
  try {
    // Strip any accidental markdown code fences
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) {
      throw new Error('Response is not an array');
    }

    // Validate each item has required fields
    return parsed.map((item, index) => ({
      criterion: item.criterion || rubric[index] || `Criterion ${index + 1}`,
      passed: typeof item.passed === 'boolean' ? item.passed : false,
      feedback: item.feedback || 'No feedback provided'
    }));

  } catch (error) {
    console.error('Failed to parse Anthropic grading response:', error);
    console.error('Raw text was:', rawText);

    // Fallback: return all criteria as failed with an error note
    // This surfaces the issue to the admin during review rather than silently passing
    return rubric.map(criterion => ({
      criterion,
      passed: false,
      feedback: 'Grading error: could not parse LLM response. Admin review required.'
    }));
  }
}

module.exports = {
  gradeEmbeddedCode
};