/**
 * Shared Amazon Bedrock access for the interview agents (Converse API).
 *
 * - Region is fixed to us-east-1 and the model is called directly. Cross-region inference
 *   profiles are refused on purpose, so prompts are processed in one Region only.
 * - Nothing here logs prompts or completions. Callers get text plus timings and token counts.
 * - Data retention is an account/Region setting in Bedrock, not a per-request option.
 */
const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

const AGENT_REGION = 'us-east-1';
const DEFAULT_MODEL_ID = 'qwen.qwen3-coder-30b-a3b-v1:0';
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 300;
const DEFAULT_TIMEOUT_MS = 20000; // API Gateway cuts requests off at 29s

/** Failure to get a usable answer from the model. The message never contains request text. */
class ModelUnavailableError extends Error {
  constructor(reason) {
    super(`Model unavailable: ${reason}`);
    this.name = 'ModelUnavailableError';
    this.reason = reason;
  }
}

// Inference profiles ("us.", "eu.", "global.", or an ARN) can route a request to another Region.
const PROFILE_PREFIX = /^(us|eu|apac|global|us-gov)\./i;

function resolveModelId(modelId = process.env.AGENT_MODEL_ID || DEFAULT_MODEL_ID) {
  if (PROFILE_PREFIX.test(modelId) || modelId.startsWith('arn:')) {
    throw new Error('AgentModelId must be a direct model ID, not a cross-region inference profile');
  }
  return modelId;
}

let sharedClient;
function getClient() {
  if (!sharedClient) {
    sharedClient = new BedrockRuntimeClient({ region: AGENT_REGION, maxAttempts: 2 });
  }
  return sharedClient;
}

/**
 * One Converse call.
 * @returns {Promise<{ text: string, inputTokens: number, outputTokens: number, latencyMs: number, stopReason: string }>}
 * @throws {ModelUnavailableError}
 */
async function converse({
  system,
  messages,
  modelId,
  maxTokens = DEFAULT_MAX_TOKENS,
  temperature = DEFAULT_TEMPERATURE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  client = getClient(),
}) {
  const started = Date.now();
  let response;
  try {
    response = await client.send(
      new ConverseCommand({
        modelId: resolveModelId(modelId),
        system: [{ text: system }],
        messages,
        inferenceConfig: { maxTokens, temperature },
      }),
      { abortSignal: AbortSignal.timeout(timeoutMs) }
    );
  } catch (error) {
    // Only the error class is kept; the SDK message may echo parts of the request.
    throw new ModelUnavailableError(error.name || 'UnknownError');
  }

  const blocks = response?.output?.message?.content || [];
  const text = blocks.map((b) => b.text || '').join('').trim();
  if (!text) throw new ModelUnavailableError('EmptyResponse');

  return {
    text,
    inputTokens: response.usage?.inputTokens || 0,
    outputTokens: response.usage?.outputTokens || 0,
    latencyMs: Date.now() - started,
    stopReason: response.stopReason || '',
  };
}

module.exports = {
  converse,
  resolveModelId,
  ModelUnavailableError,
  AGENT_REGION,
  DEFAULT_MODEL_ID,
  DEFAULT_TEMPERATURE,
  DEFAULT_MAX_TOKENS,
};
