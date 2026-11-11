const { prepareInterview } = require('/opt/nodejs/services/interview-service');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: Prepare Interview
 * Not an API route: CreateInterviewFunction (and the practice starter) invoke it asynchronously, so the API's 29 second limit never
 * applies. It classifies the code, runs the run inputs and (host.v7) analyzes the code, then marks the interview "ready".
 * Event: { interviewId }
 */
exports.handler = async (event) => {
  const interviewId = event && event.interviewId;
  if (!interviewId || typeof interviewId !== 'string') {
    log.error('Prepare interview called without an interview id');
    return { prepared: false };
  }
  // Leave a margin before the function's own timeout for the final write.
  return prepareInterview({ interviewId, deadlineMs: Date.now() + 100000 });
};
