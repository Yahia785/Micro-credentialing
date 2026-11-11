/**
 * Starts the prepare step of an interview. In the deployed API it invokes PrepareInterviewFunction asynchronously (Lambda "Event"
 * invocation: the call returns at once, so create never waits for the work and API Gateway's 29 second limit never applies). Without
 * PREPARE_INTERVIEW_FUNCTION (local runs, the evaluation, tests) the step runs in-process, one after the other. If starting it fails, the
 * interview is marked "failed" and goes on without what the step would have prepared; the student never loses the submission.
 */
const log = require('../utils/logger');
const interviews = require('../db/interviews');

let lambdaClient;
async function invokeLambda(functionName, payload) {
  const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
  if (!lambdaClient) lambdaClient = new LambdaClient({});
  await lambdaClient.send(new InvokeCommand({ FunctionName: functionName, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify(payload)) }));
}

/**
 * @param {{ interviewId: string, invokePrepare?: Function, prepare: Function }} p
 *   invokePrepare replaces the default (tests, the evaluation); prepare is the in-process step used when no function is configured
 */
async function launchPrepare({ interviewId, invokePrepare, prepare }) {
  try {
    if (invokePrepare) await invokePrepare({ interviewId });
    else if (process.env.PREPARE_INTERVIEW_FUNCTION) await invokeLambda(process.env.PREPARE_INTERVIEW_FUNCTION, { interviewId });
    else await prepare({ interviewId });
  } catch (error) {
    log.error('Could not start the interview prepare step', { interviewId, error: error.name });
    try {
      await interviews.finishPrepare(interviewId, { metaUpdates: { prepareStatus: 'failed' }, firstTurnUpdates: {} });
    } catch (again) {
      log.error('Could not mark the interview prepare step as failed', { interviewId, error: again.name });
    }
  }
}

module.exports = { launchPrepare };
