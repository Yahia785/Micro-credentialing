const { prepareInterview } = require('/opt/nodejs/services/interview-service');
const log = require('/opt/nodejs/utils/logger');

/**
 * Lambda Handler: Prepare Interview
 * Not an API route: CreateInterviewFunction (and the practice starter) invoke it asynchronously, so the API's 29 second limit never
 * applies. It classifies the code, runs the run inputs and (host.v7) analyzes the code, then marks the interview "ready".
 * Event: { interviewId }
 */
exports.handler = async (event, context) => {
  const interviewId = event && event.interviewId;
  if (!interviewId || typeof interviewId !== 'string') {
    log.error('Prepare interview called without an interview id');
    return { prepared: false };
  }
  // An absolute time: what is left of this invocation, minus a margin for the final write.
  const left = context && context.getRemainingTimeInMillis ? context.getRemainingTimeInMillis() : 115000;
  return prepareInterview({ interviewId, deadlineAt: Date.now() + left - 15000 });
};
