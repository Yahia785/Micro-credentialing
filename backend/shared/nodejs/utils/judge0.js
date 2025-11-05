/**
 * Judge0 Integration Utilities
 */

/**
 * Map language string to Judge0 language ID
 * @param {string} language - Language name (python, javascript, java, etc.)
 * @returns {number} Judge0 language ID
 */
function getLanguageId(language) {
  const languageMap = {
    'python': 71,      // Python 3.8.1
    'javascript': 63,  // JavaScript (Node.js 12.14.0)
    'java': 62,        // Java (OpenJDK 13.0.1)
    'cpp': 54,         // C++ (GCC 9.2.0)
    'c': 50,           // C (GCC 9.2.0)
    'csharp': 51,      // C# (Mono 6.6.0.161)
    'ruby': 72,        // Ruby (2.7.0)
    'go': 60,          // Go (1.13.5)
    'rust': 73,        // Rust (1.40.0)
    'php': 68          // PHP (7.4.1)
  };
  
  const languageId = languageMap[language.toLowerCase()];
  if (!languageId) {
    throw new Error(`Unsupported language: ${language}`);
  }
  
  return languageId;
}

/**
 * Submit batch of submissions to Judge0
 * @param {Array} submissions - Array of submission objects
 * @param {string} apiKey - Judge0 API key
 * @param {string} apiHost - Judge0 API host
 * @returns {Array} Array of tokens from Judge0
 */
async function submitBatch(submissions, apiKey, apiHost) {
  const url = `https://${apiHost}/submissions/batch?base64_encoded=false&wait=false`;
  
  console.log('Submitting batch to Judge0:', url);
  console.log('Number of submissions:', submissions.length);
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-RapidAPI-Key': apiKey,
      'X-RapidAPI-Host': apiHost
    },
    body: JSON.stringify({ submissions })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('Judge0 batch submission error:', response.status, errorText);
    throw new Error(`Judge0 API error: ${response.status} - ${errorText}`);
  }
  
  const result = await response.json();
  console.log('Judge0 batch submission result:', result);
  
  return result;
}

/**
 * Poll Judge0 for batch results
 * @param {Array} tokens - Array of Judge0 tokens
 * @param {string} apiKey - Judge0 API key
 * @param {string} apiHost - Judge0 API host
 * @param {number} maxAttempts - Maximum polling attempts (default: 30)
 * @param {number} pollInterval - Polling interval in ms (default: 1000)
 * @returns {Array} Array of submission results
 */
async function pollResults(tokens, apiKey, apiHost, maxAttempts = 30, pollInterval = 1000) {
  const tokensString = tokens.join(',');
  const url = `https://${apiHost}/submissions/batch?tokens=${tokensString}&base64_encoded=false`;
  
  console.log('Polling Judge0 for results. Tokens:', tokensString);
  
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    attempts++;
    console.log(`Polling attempt ${attempts}/${maxAttempts}`);
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': apiHost
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Judge0 polling error:', response.status, errorText);
      throw new Error(`Judge0 API error: ${response.status} - ${errorText}`);
    }
    
    const result = await response.json();
    const submissions = result.submissions;
    
    const allDone = submissions.every(s => s.status.id >= 3);
    
    if (allDone) {
      console.log('All submissions completed');
      return submissions;
    }
    
    console.log(`Still processing... Waiting ${pollInterval}ms before next attempt`);
    await sleep(pollInterval);
  }
  
  console.warn('Polling timeout reached');
  throw new Error('Judge0 polling timeout: submissions did not complete in time');
}

/**
 * Parse Judge0 result into standardized format
 */
function parseJudge0Result(judge0Result, testCase) {
  const statusId = judge0Result.status.id;
  const statusDescription = judge0Result.status.description;
  
  return {
    testCaseId: testCase.testCaseId,
    judge0TokenId: judge0Result.token,
    status: statusDescription,
    passed: statusId === 3,
    input: testCase.input,
    expectedOutput: testCase.expectedOutput,
    actualOutput: judge0Result.stdout || '',
    executionTime: parseFloat(judge0Result.time) || 0,
    memory: parseInt(judge0Result.memory) || 0,
    isHidden: testCase.isHidden,
    error: judge0Result.stderr || judge0Result.compile_output || null
  };
}

/**
 * Calculate aggregate metrics from test results
 */
function calculateMetrics(testResults) {
  const passedTests = testResults.filter(r => r.passed).length;
  const totalTests = testResults.length;
  const score = totalTests > 0 ? Math.round((passedTests / totalTests) * 100) : 0;
  
  const totalExecutionTime = testResults.reduce((sum, r) => sum + r.executionTime, 0);
  const totalMemory = testResults.reduce((sum, r) => sum + r.memory, 0);
  
  const executionTimes = testResults.map(r => r.executionTime);
  const memoryValues = testResults.map(r => r.memory);
  
  return {
    passedTests,
    totalTests,
    score,
    status: passedTests === totalTests ? 'passed' : 'failed',
    totalExecutionTime: parseFloat(totalExecutionTime.toFixed(3)),
    averageExecutionTime: parseFloat((totalExecutionTime / totalTests).toFixed(3)),
    maxExecutionTime: Math.max(...executionTimes),
    totalMemory,
    averageMemory: Math.round(totalMemory / totalTests),
    maxMemory: Math.max(...memoryValues)
  };
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  getLanguageId,
  submitBatch,
  pollResults,
  parseJudge0Result,
  calculateMetrics,
  sleep
};