jest.mock('../db/embedded-assessments');
jest.mock('../db/embedded-submission');
jest.mock('../db/users');
jest.mock('../utils/anthropic', () => ({ gradeEmbeddedCode: jest.fn() }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { getEmbeddedAssessment } = require('../db/embedded-assessments');
const { createEmbeddedSubmission } = require('../db/embedded-submission');
const { getUser, updateUser, addCompletedMilestone } = require('../db/users');
const anthropic = require('../utils/anthropic');
const { processEmbeddedSubmission, resolveGradingMode } = require('../services/embedded-submission-service');

const RUBRIC = ['Initializes the UART', 'Handles errors', 'Uses interrupts'];
const base = { userId: 'u1', assessmentId: 'a1', body: { code: 'int main(){}' } };

beforeEach(() => {
  jest.clearAllMocks();
  getUser.mockResolvedValue({ userId: 'u1', email: 'a@b.c', name: 'A', completedMilestones: [], credentialsCount: 0 });
  getEmbeddedAssessment.mockResolvedValue({ milestoneId: 'a1', rubric: RUBRIC });
  createEmbeddedSubmission.mockImplementation(async (data) => ({ submissionId: 'esub_1', ...data }));
  addCompletedMilestone.mockResolvedValue({});
  updateUser.mockResolvedValue({});
});

describe('resolveGradingMode', () => {
  it('only the exact value "llm" enables LLM grading', () => {
    expect(resolveGradingMode('llm')).toBe('llm');
    expect(resolveGradingMode('manual')).toBe('manual');
    expect(resolveGradingMode(undefined)).toBe('manual');
    expect(resolveGradingMode('')).toBe('manual');
    expect(resolveGradingMode('LLM')).toBe('manual');
    expect(resolveGradingMode('anything')).toBe('manual');
  });
});

describe('manual grading mode', () => {
  it('never calls the Anthropic API and saves the submission for instructor review', async () => {
    const result = await processEmbeddedSubmission({ ...base, gradingMode: 'manual' });

    expect(anthropic.gradeEmbeddedCode).not.toHaveBeenCalled();
    const saved = createEmbeddedSubmission.mock.calls[0][0];
    expect(saved).toMatchObject({
      userId: 'u1',
      milestoneId: 'a1',
      code: 'int main(){}',
      status: 'manual_review',
      gradingType: 'manual',
      gradingMode: 'manual',
      endedBy: 'submit_button',
      score: 0,
      passed: false,
      totalCriteria: 3
    });
    // One ungraded row per rubric criterion so the admin screen can mark each one
    expect(saved.rubricResults.map((r) => r.criterion)).toEqual(RUBRIC);

    // Same fields the older frontend reads, plus the additive gradingMode
    expect(result).toMatchObject({
      submissionId: 'esub_1',
      passed: false,
      score: 0,
      passedCriteria: 0,
      totalCriteria: 3,
      gradingMode: 'manual'
    });
    expect(result.gradingFailed).toBeUndefined();
    // The rubric text is not returned on submit; students see it once the submission is reviewed.
    expect(result.rubricResults).toBeUndefined();
  });

  it('records the attempt, with no credential counters', async () => {
    await processEmbeddedSubmission({ ...base, gradingMode: 'manual' });
    expect(addCompletedMilestone).toHaveBeenCalledWith('u1', expect.objectContaining({ milestoneId: 'a1', submissionId: 'esub_1' }));
    expect(addCompletedMilestone.mock.calls[0][1].gradingFailed).toBeUndefined();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('a missing or unknown mode behaves as manual', async () => {
    await processEmbeddedSubmission({ ...base });
    await processEmbeddedSubmission({ ...base, gradingMode: 'bogus' });
    expect(anthropic.gradeEmbeddedCode).not.toHaveBeenCalled();
  });

  it('request with no endedBy is stored as submit_button; left_page is kept', async () => {
    await processEmbeddedSubmission({ ...base, gradingMode: 'manual' });
    await processEmbeddedSubmission({ ...base, body: { code: 'x', endedBy: 'left_page' }, gradingMode: 'manual' });
    expect(createEmbeddedSubmission.mock.calls[0][0].endedBy).toBe('submit_button');
    expect(createEmbeddedSubmission.mock.calls[1][0].endedBy).toBe('left_page');
  });

  it('keeps the existing validation errors', async () => {
    await expect(processEmbeddedSubmission({ ...base, body: { code: '  ' }, gradingMode: 'manual' }))
      .rejects.toMatchObject({ statusCode: 400, message: 'Code is required' });
    await expect(processEmbeddedSubmission({ ...base, body: { code: 'x', endedBy: 'nope' }, gradingMode: 'manual' }))
      .rejects.toMatchObject({ statusCode: 400 });
    getUser.mockResolvedValueOnce({ userId: 'u1', completedMilestones: [{ milestoneId: 'a1' }] });
    await expect(processEmbeddedSubmission({ ...base, gradingMode: 'manual' }))
      .rejects.toMatchObject({
        statusCode: 400,
        message: 'You have already submitted this assessment. Only one submission is allowed.'
      });
    expect(createEmbeddedSubmission).not.toHaveBeenCalled();
    getEmbeddedAssessment.mockResolvedValueOnce(null);
    await expect(processEmbeddedSubmission({ ...base, gradingMode: 'manual' }))
      .rejects.toMatchObject({ statusCode: 404, message: 'Embedded assessment not found' });
  });
});

describe('llm grading mode (original behaviour)', () => {
  const graded = {
    rubricResults: RUBRIC.map((criterion) => ({ criterion, passed: true, feedback: 'ok' })),
    passedCriteria: 3, totalCriteria: 3, score: 100, passed: true, llmModel: 'm'
  };

  it('grades with the LLM and awards counters on a pass', async () => {
    anthropic.gradeEmbeddedCode.mockResolvedValue(graded);
    const result = await processEmbeddedSubmission({ ...base, gradingMode: 'llm' });

    expect(anthropic.gradeEmbeddedCode).toHaveBeenCalledWith('int main(){}', RUBRIC);
    expect(createEmbeddedSubmission.mock.calls[0][0]).toMatchObject({ passed: true, score: 100, gradingMode: 'llm' });
    expect(createEmbeddedSubmission.mock.calls[0][0].status).toBeUndefined(); // db layer derives 'passed'
    expect(updateUser).toHaveBeenCalledWith('u1', expect.objectContaining({ credentialsCount: 1 }));
    expect(result).toMatchObject({ message: 'Assessment passed!', passed: true, score: 100, gradingMode: 'llm' });
  });

  it('left_page never gets counters, even when it passes', async () => {
    anthropic.gradeEmbeddedCode.mockResolvedValue(graded);
    await processEmbeddedSubmission({ ...base, body: { code: 'x', endedBy: 'left_page' }, gradingMode: 'llm' });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('LLM failure: saves the submission as grading_failed and answers 200-style', async () => {
    anthropic.gradeEmbeddedCode.mockRejectedValue(new Error('Anthropic API error: 529'));
    const result = await processEmbeddedSubmission({ ...base, gradingMode: 'llm' });

    expect(createEmbeddedSubmission.mock.calls[0][0]).toMatchObject({
      status: 'grading_failed',
      code: 'int main(){}',
      endedBy: 'submit_button',
      errorMessage: 'Anthropic API error: 529',
      passed: false,
      score: 0
    });
    expect(result).toMatchObject({
      submissionId: 'esub_1',
      passed: false,
      score: 0,
      passedCriteria: 0,
      totalCriteria: 3,
      gradingFailed: true,
      gradingMode: 'llm'
    });
    expect(addCompletedMilestone).toHaveBeenCalledTimes(1);
    expect(addCompletedMilestone.mock.calls[0][1]).toMatchObject({ gradingFailed: true });
    expect(updateUser).not.toHaveBeenCalled();
  });
});
