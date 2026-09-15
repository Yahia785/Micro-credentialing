/**
 * Structured JSON logger for CloudWatch.
 *
 * Usage:
 *   const log = require('/opt/nodejs/utils/logger');
 *
 *   log.info('Submission created', { submissionId, userId, milestoneId });
 *   log.warn('Judge0 slow', { attempt: 5, elapsed: '5s' });
 *   log.error('DynamoDB write failed', { error: err.message, table: 'Submissions' });
 */

const LEVELS = { debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR' };

function emit(level, message, data = {}) {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...data,
  };
  // Use console.error for WARN/ERROR so CloudWatch can filter by stream
  const writer = (level === 'ERROR' || level === 'WARN') ? console.error : console.log;
  writer(JSON.stringify(entry));
}

module.exports = {
  debug: (msg, data) => emit(LEVELS.debug, msg, data),
  info:  (msg, data) => emit(LEVELS.info,  msg, data),
  warn:  (msg, data) => emit(LEVELS.warn,  msg, data),
  error: (msg, data) => emit(LEVELS.error, msg, data),
};
