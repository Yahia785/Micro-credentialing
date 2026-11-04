const { incrementCounters } = require('../db/run-usage');
const { RateLimitError, ValidationError } = require('../utils/errors');
const log = require('../utils/logger');

/**
 * Usage limits for the "Run" feature (running code before submitting). Call checkAndCountRun / checkAndCountAgentRun
 * BEFORE calling the code runner; they throw RateLimitError (HTTP 429, the handler wrapper turns it into the response)
 * when a limit is reached, and otherwise count the run. Submissions (grading) never go through this module.
 *
 *   per student, per minute         RUN_LIMIT_PER_MINUTE            default 10   (counter per fixed minute, TTL 2 minutes)
 *   per student, per assessment     RUN_LIMIT_PER_ASSESSMENT        default 150  (Run-button runs)
 *   per student, per interview      RUN_LIMIT_AGENT_PER_INTERVIEW   default 30   (agent runs: their own counter, not counted
 *                                                                    against the two limits above)
 * Counters live in the DynamoDB table named by RUN_USAGE_TABLE (RunUsage-<Environment>) and are incremented atomically with
 * a condition, so concurrent calls cannot go over a limit. A Run is counted in both of its counters or in neither.
 * If DynamoDB itself fails, the run is allowed (the limits protect cost and fairness, not security) and the failure is
 * logged. Only counts are logged, never code.
 */

const DEFAULTS = { perMinute: 10, perAssessment: 150, agentPerInterview: 30 };
const MINUTE_MS = 60 * 1000;

function limit(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const limits = () => ({
  perMinute: limit('RUN_LIMIT_PER_MINUTE', DEFAULTS.perMinute),
  perAssessment: limit('RUN_LIMIT_PER_ASSESSMENT', DEFAULTS.perAssessment),
  agentPerInterview: limit('RUN_LIMIT_AGENT_PER_INTERVIEW', DEFAULTS.agentPerInterview)
});

function requireIds(userId, scopeId, scopeName) {
  if (!userId || typeof userId !== 'string') throw new ValidationError('userId is required');
  if (!scopeId || typeof scopeId !== 'string') throw new ValidationError(`${scopeName} is required`);
}

async function count(counters, userId, onRefused) {
  let outcome;
  try {
    outcome = await incrementCounters(counters);
  } catch (error) {
    log.error('Run usage counter failed, allowing the run', { error: error.message });
    return;
  }
  if (!outcome.ok) {
    const kind = counters.find(c => c.key === outcome.failedKey).kind;
    log.info('Run refused: limit reached', { userId, kind, limit: counters.find(c => c.key === outcome.failedKey).limit });
    throw onRefused(kind);
  }
}

/** A Run-button run for one assessment: counts against the per-minute and the per-assessment limit. */
async function checkAndCountRun({ userId, assessmentId, now = Date.now() }) {
  requireIds(userId, assessmentId, 'assessmentId');
  const max = limits();
  const minute = Math.floor(now / MINUTE_MS);
  await count([
    { key: `run#${userId}#${assessmentId}`, limit: max.perAssessment, kind: 'assessment' },
    { key: `minute#${userId}#${minute}`, limit: max.perMinute, kind: 'minute', expiresAt: (minute + 2) * 60 }
  ], userId, kind => kind === 'assessment'
    ? new RateLimitError("You've reached the run limit for this assessment", 'assessment')
    : new RateLimitError('Too many runs, please wait a minute', 'minute'));
}

/** An agent run (AI interview): its own counter per interview. */
async function checkAndCountAgentRun({ userId, interviewId }) {
  requireIds(userId, interviewId, 'interviewId');
  await count([
    { key: `agent#${userId}#${interviewId}`, limit: limits().agentPerInterview, kind: 'agent' }
  ], userId, () => new RateLimitError("You've reached the agent run limit for this interview", 'agent'));
}

module.exports = { checkAndCountRun, checkAndCountAgentRun, DEFAULTS };
