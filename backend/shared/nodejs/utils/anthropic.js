const { getSecret } = require('./secrets');
const log = require('./logger');

async function getAnthropicApiKey() {
  return await getSecret(process.env.ANTHROPIC_API_KEY_SECRET_ARN);
}

async function gradeEmbeddedCode(code, rubric) {
  let apiKey;
  try {
    apiKey = await getAnthropicApiKey();
  } catch (secretError) {
    log.warn('Could not retrieve Anthropic API key from Secrets Manager, returning mock grading results', { error: secretError.message });
    return {
      rubricResults: rubric.map(criterion => ({
        criterion,
        passed: false,
        feedback: 'Grading unavailable: could not reach grading service. Admin review required.'
      })),
      passedCriteria: 0,
      totalCriteria: rubric.length,
      score: 0,
      passed: false,
      llmModel: 'mock'
    };
  }



  const prompt = buildGradingPrompt(code, rubric);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
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
    log.error('Anthropic API error', { status: response.status });
    throw new Error(`Anthropic API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const rawText = data.content[0].text;

  log.info('Anthropic response received', { responseLength: rawText.length });

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
    llmModel: 'claude-sonnet-4-6'
  };
}

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

function parseGradingResponse(rawText, rubric) {
  try {
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) {
      throw new Error('Response is not an array');
    }

    return parsed.map((item, index) => ({
      criterion: item.criterion || rubric[index] || `Criterion ${index + 1}`,
      passed: typeof item.passed === 'boolean' ? item.passed : false,
      feedback: item.feedback || 'No feedback provided'
    }));

  } catch (error) {
    log.error('Failed to parse Anthropic grading response', { error: error.message, responseLength: rawText.length });

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
