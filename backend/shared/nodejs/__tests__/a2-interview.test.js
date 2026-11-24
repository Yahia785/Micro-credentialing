// The interview-only flow of the A2 pilot (host.a2), the case design: start from an importId, the runtime truth, the main check and the clarify,
// the four cases, the check of every kind of follow-up, the smaller code step and its identifier guard, the labels, and that the GitHub username
// never reaches an interview record or a model.
jest.mock('../db/interviews', () => require('./helpers/a2-memory').makeMemoryInterviews());
jest.mock('../db/submissions');
jest.mock('../db/milestones');
jest.mock('../a2/imported-store');
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const interviews = require('../db/interviews');
const { getMilestone } = require('../db/milestones');
const importedStore = require('../a2/imported-store');
const { startPracticeInterview, prepareInterview, submitAnswer, getInterview } = require('../services/interview-service');
const a2 = require('../services/a2-interview');
const planConfig = require('../a2/plan-config');
const { checkValue, judgeExplanation, compareValue, givesNoValue, CHECK_SYSTEM, JUDGE_SYSTEM } = require('../a2/check');
const { writeSmallStep, unknownIdentifiers, valueAt } = require('../a2/follow-up');
const { ValidationError } = require('../utils/errors');
const { IMPORT_ID, USERNAME, CODE, formAPlan, brokenPlan, crapsQuestion, okRecord, MILESTONE, RUNTIME } = require('./helpers/a2-fixture');
const { fakeRunBatch, fakeModel } = require('./helpers/a2-fakes');

const NOW = Date.parse('2026-02-01T10:00:00Z');
const ADMIN = 'admin-1';
const counter = () => jest.fn(async () => {});
const changedWhen = (source) => source.includes('size_t start = 1;') || source.includes('? -2 : 1');

async function start(plan = formAPlan(), { runtime = RUNTIME, status } = {}) {
  importedStore.getRecord.mockResolvedValue(okRecord(plan));
  importedStore.getCode.mockResolvedValue({ code: CODE, header: null });
  const started = await startPracticeInterview({ userId: ADMIN, importId: IMPORT_ID, milestoneId: MILESTONE.milestoneId, now: NOW, invokePrepare: async () => {} });
  const runBatch = fakeRunBatch({ ...runtime, ...(status && { status }), changedWhen });
  const prepared = await prepareInterview({ interviewId: started.interviewId, runBatch, countRun: counter(), now: NOW });
  return { started, prepared, runBatch, id: started.interviewId };
}
let clockAt = 0;
const answer = (id, text, model) => { clockAt += 1000; return submitAnswer({ userId: ADMIN, interviewId: id, answer: text, now: NOW + clockAt, converseFn: model, clock: () => 0 }); };
const metaOf = (id) => interviews.store.get(id).meta;
/** Put the interview at one function (its main question is asked next), as the scripted run does. */
function goTo(id, index) {
  const stored = interviews.store.get(id);
  stored.turns[0].text = a2.positionAt(stored.meta, index);
}
const pathOf = (id, index = 0) => metaOf(id).a2Log[index].path;
const entryOf = (id, index = 0) => metaOf(id).a2Log[index];
const REV = 0;
const SPLIT = 1;
const CRAPS = 2;

beforeEach(() => {
  interviews.reset();
  clockAt = 0;
  jest.clearAllMocks();
  getMilestone.mockResolvedValue(MILESTONE);
});

describe('start from an importId', () => {
  it('ties the interview to the importId (no submission), keeps the form and the plan, asks the first main question word for word', async () => {
    const { started } = await start();
    const meta = metaOf(started.interviewId);
    expect(meta).toMatchObject({ importId: IMPORT_ID, form: 'A', interviewOnly: true, source: 'a2-pilot', isPractice: true, promptVersion: 'host.a2', userId: ADMIN });
    expect(meta).not.toHaveProperty('submissionId');
    expect(meta.configSnapshot.timeLimitMinutes).toBe(20);
    expect(started.question).toBe(formAPlan().questions[0].text);
    expect(started.questionCount).toBe(3);
    expect(meta.a2Log).toHaveLength(3);
    expect(meta.a2Log[0].path).toEqual([expect.objectContaining({ step: 'main', kind: 'logic', expected: '2', expectedSource: 'spec', studentAnswer: null })]);
  });

  it('never stores the GitHub username on the interview, and refuses a plan from an older design', async () => {
    const { id } = await start();
    await answer(id, '2', fakeModel());
    expect(JSON.stringify(interviews.store.get(id))).not.toContain(USERNAME);
    importedStore.getRecord.mockResolvedValue({ ...okRecord(), plan: { ...formAPlan(), version: 2 } });
    await expect(startPracticeInterview({ userId: ADMIN, importId: IMPORT_ID, milestoneId: MILESTONE.milestoneId })).rejects.toThrow('older design');
    importedStore.getRecord.mockResolvedValue({ ...okRecord(), plan: { noPlan: 'no code' } });
    await expect(startPracticeInterview({ userId: ADMIN, importId: IMPORT_ID, milestoneId: MILESTONE.milestoneId })).rejects.toBeInstanceOf(ValidationError);
  });

  it('gives the 20 minute clock when the interview is ready', async () => {
    const { id } = await start();
    expect(metaOf(id).deadline).toBe(new Date(NOW + 20 * 60000).toISOString());
  });
});

describe('the runtime is the truth of the code answers', () => {
  it('runs only what can be asked: cases 2 and 4 for code that is wrong, cases 1 and 3 for code that is right', async () => {
    const { runBatch, id } = await start();
    const cmds = runBatch.calls.map((c) => `${c.cmd}${c.trace ? ' [trace]' : ''}`);
    // reverseList (code wrong): the debug input and the material trace on the main input
    expect(cmds).toEqual(expect.arrayContaining(['reverseList 3 5 8', 'reverseList 1 2 3 4 5', 'reverseList 1 2 3 4 5 [trace]']));
    // splitString (code right): tracing, what-if, the main input and the material trace
    expect(cmds).toEqual(expect.arrayContaining(['splitString , a,b,c [trace]', 'splitString , a,b,c', 'splitString , ,a,,b', 'splitString , ,a,,b [trace]']));
    const truth = entryOf(id, SPLIT).truth;
    expect(truth['case1.followUp1']).toMatchObject({ answer: 'piece="b"', source: 'runtime', mismatch: null });
    expect(truth['case1.followUp2']).toMatchObject({ answer: '["x", "b", "c"]', source: 'runtime', mismatch: null });
    expect(truth['case3.followUp1']).toMatchObject({ answer: '["", "a", "", "b"]', source: 'runtime' });
    expect(truth.material).toMatchObject({ stops: ['piece=""', 'piece="a"', 'piece=""'], source: 'runtime', mismatch: null });
    expect(entryOf(id, REV).truth['case2.followUp1']).toMatchObject({ answer: '[3, 5, 8]', source: 'runtime' });
    // reverseList's swaps are the stops of the swap line on the main input
    expect(entryOf(id, REV).truth.material.stops).toHaveLength(5);
  });

  it('logs a mismatch flag when the runtime differs from the plan, and the check uses the runtime result', async () => {
    const runtime = { ...RUNTIME, stops: { ...RUNTIME.stops, 'splitString , a,b,c': ['piece="a"', 'piece="c"'] } };
    const { id } = await start(formAPlan(), { runtime });
    expect(entryOf(id, SPLIT).truth['case1.followUp1']).toMatchObject({ answer: 'piece="c"', source: 'runtime', mismatch: { kind: 'runtime_differs_from_plan', plan: 'piece="b"', runtime: 'piece="c"' } });
    goTo(id, SPLIT);
    const model = fakeModel();
    await answer(id, '"", "a", "", "b"', model);
    await answer(id, 'c', model);
    expect(pathOf(id, SPLIT)[1]).toMatchObject({ expected: 'piece="c"', expectedSource: 'code', result: 'right', mismatch: { kind: 'runtime_differs_from_plan' } });
  });

  it('uses the plan\'s answer and says so when the program could not be run', async () => {
    const { id } = await start(formAPlan(), { status: { 'playCraps 2 2 1 2 3 4': 'runtime_error' } });
    expect(entryOf(id, CRAPS).truth['case1.followUp1']).toMatchObject({ answer: '1', source: 'plan', mismatch: { kind: 'runtime_unavailable', runtime: null }, note: expect.stringContaining('runtime_error') });
    goTo(id, CRAPS);
    const model = fakeModel();
    await answer(id, '1', model);
    expect(pathOf(id, CRAPS)[1]).toMatchObject({ expectedSource: 'code (plan)', mismatch: { kind: 'runtime_unavailable' } });
  });

  it('runs nothing for compile-error and logic-only questions', async () => {
    const { runBatch } = await start(brokenPlan());
    expect(runBatch.calls).toEqual([]);
  });
});

describe('the main question and the unclear answer', () => {
  it('checks against the spec key by comparison, without the model when it is clear', async () => {
    const { id } = await start();
    const model = fakeModel();
    await answer(id, '2', model);
    expect(model.requests).toHaveLength(0);
    expect(pathOf(id)[0]).toMatchObject({ result: 'right', method: 'compare' });
    expect(entryOf(id)).toMatchObject({ logicRight: true, case: 2 });
  });

  it('a list answer counts the empty pieces: "a", "b" is wrong for "", "a", "", "b" even though the letters are the same', async () => {
    expect(compareValue({ kind: 'predict', expected: '"", "a", "", "b"', answer: '"a", "b"' })).toBe('wrong');
    expect(compareValue({ kind: 'predict', expected: '"", "a", "", "b"', answer: '[ "" , "a" ,"", "b" ]' })).toBe('correct');
    expect(compareValue({ kind: 'predict', expected: '"", "a", "", "b"', answer: 'a b' })).toBeNull();
  });

  it('an unclear answer is asked once "Can you give the exact result?" (not a follow-up), then checked again', async () => {
    const { id } = await start();
    goTo(id, CRAPS);
    const model = fakeModel();
    const next = await answer(id, 'Somebody wins at some point', model);
    expect(next.question).toBe('Can you give the exact result?');
    expect(pathOf(id, CRAPS).map((s) => [s.step, s.result])).toEqual([['main', 'unclear'], ['clarify', null]]);
    expect(entryOf(id, CRAPS).clarified).toBe(true);
    expect(interviews.store.get(id).turns.at(-1)).toMatchObject({ kind: 'follow_up', clarify: true });
    const after = await answer(id, '1', model);
    expect(pathOf(id, CRAPS)[1]).toMatchObject({ step: 'clarify', result: 'right' });
    expect(entryOf(id, CRAPS)).toMatchObject({ logicRight: true, case: 1 });
    expect(after.question).toBe(formAPlan().questions[2].cases.case1.followUp1.text);
  });

  it('still unclear after the clarify: logged as unclear and routed as logic wrong (case 3 for code that is right)', async () => {
    const { id } = await start();
    goTo(id, CRAPS);
    const model = fakeModel();
    await answer(id, 'It depends on the point number', model);
    const next = await answer(id, 'not sure, maybe 1 or 2', model);
    expect(pathOf(id, CRAPS)[1]).toMatchObject({ step: 'clarify', result: 'unclear' });
    expect(entryOf(id, CRAPS)).toMatchObject({ logicRight: false, case: 3 });
    expect(next.question).toBe('What does your playCraps return for {2, 2, 3, 4}?');
    expect(entryOf(id, CRAPS).label).toBeNull();
  });
});

describe('the case', () => {
  const routes = [
    ['case 1: logic right, code right', CRAPS, '1', 1, 'What does your playCraps return for the dice values {2, 2, 1, 2, 3, 4}?'],
    ['case 2: logic right, code wrong', REV, '2', 2, 'Your reverseList returns [3, 5, 8] for the vector {3, 5, 8}. Why does it give that instead of [8, 5, 3]?'],
    ['case 3: logic wrong, code right', CRAPS, '0', 3, 'What does your playCraps return for {2, 2, 3, 4}?'],
    ['case 4: logic wrong, code wrong', REV, '5', 4, 'To reverse {1, 2, 3} in place, how many swaps are needed?'],
  ];
  it.each(routes)('%s', async (_name, index, typed, expectedCase, firstFollowUp) => {
    const { id } = await start();
    goTo(id, index);
    const next = await answer(id, typed, fakeModel());
    expect(entryOf(id, index)).toMatchObject({ case: expectedCase, caseMeaning: a2.CASE_MEANING[expectedCase] });
    expect(next.question).toBe(firstFollowUp);
    expect(interviews.store.get(id).turns.at(-1)).toMatchObject({ kind: 'follow_up' });
  });

  it('codeRight null (no safe input ran) takes the case 4 path, whatever the logic answer', async () => {
    const plan = formAPlan();
    plan.questions[2] = { ...crapsQuestion({ codeRight: null }), index: 3 };
    plan.questions[2].cases.case1 = { available: false, reason: 'no safe input was run' };
    plan.questions[2].cases.case3 = { available: false, reason: 'x' };
    plan.questions[2].cases.case4 = { available: true, followUp1: { type: 'smallLogic', input: { cmd: 'playCraps 3 4', display: 'x' }, text: 'What does playCraps return for {3, 4}?', answerKey: '0', answerType: 'logic' }, followUp2: { type: 'smallStep', agentWritten: true, material: { available: false, private: true, reason: 'no safe input' } } };
    const { id } = await start(plan);
    goTo(id, CRAPS);
    const next = await answer(id, '1', fakeModel()); // logic RIGHT
    expect(entryOf(id, CRAPS)).toMatchObject({ logicRight: true, case: 4, caseNote: expect.stringContaining('case 4 path') });
    expect(next.question).toBe('What does playCraps return for {3, 4}?');
  });

  it('the fixed follow-ups of the M4 flow are not used: every follow-up comes from the plan\'s case', async () => {
    const { id } = await start();
    await answer(id, '2', fakeModel());
    expect(JSON.stringify(interviews.store.get(id).turns)).not.toContain('fixedFollowUp');
  });
});

describe('the follow-up checks', () => {
  it('case 1 tracing and what-if are checked against what their code does (the runtime); a wrong what-if answer is wrong', async () => {
    const { id } = await start();
    goTo(id, SPLIT);
    const model = fakeModel();
    await answer(id, '"", "a", "", "b"', model);
    const second = await answer(id, 'b', model);
    expect(pathOf(id, SPLIT)[1]).toMatchObject({ step: 'followUp1', type: 'tracing', expected: 'piece="b"', expectedSource: 'code', result: 'right', method: 'compare' });
    expect(second.question).toContain('Suppose line 11 of your splitString were changed');
    await answer(id, 'It would stay the same', model);
    expect(pathOf(id, SPLIT)[2]).toMatchObject({ type: 'whatIf', expected: '["x", "b", "c"]', result: 'wrong' });
    expect(entryOf(id, SPLIT).label).toBe('case 1 | trace: right | what-if: wrong');
  });

  it('case 3: follow-up 1 is checked against their output on the main input, follow-up 2 against the private value that was asked', async () => {
    const { id } = await start();
    goTo(id, SPLIT);
    const model = fakeModel();
    await answer(id, '"a", "b"', model); // logic wrong
    await answer(id, '["", "a", "", "b"]', model);
    expect(pathOf(id, SPLIT)[1]).toMatchObject({ type: 'predict', expected: '["", "a", "", "b"]', result: 'right' });
    const step = pathOf(id, SPLIT)[2];
    expect(step).toMatchObject({ type: 'smallStep', variable: 'piece', stop: 1, expected: '""', writtenByAgent: true });
    await answer(id, '""', model);
    expect(pathOf(id, SPLIT)[2]).toMatchObject({ result: 'right' });
    expect(entryOf(id, SPLIT).label).toBe('case 3 | predict: right | step: right');
  });

  it('case 4: the smaller logic question is checked against the spec key; the smaller code step against its private value', async () => {
    const { id } = await start();
    const model = fakeModel();
    await answer(id, '5', model);
    await answer(id, '1', model);
    expect(pathOf(id)[1]).toMatchObject({ type: 'smallLogic', expected: '1', expectedSource: 'spec', result: 'right' });
    expect(pathOf(id)[2]).toMatchObject({ type: 'smallStep', variable: 'left number', stop: 1, expected: '1' });
    await answer(id, '7', model);
    expect(pathOf(id)[2].result).toBe('wrong');
    expect(entryOf(id).label).toBe('case 4 | small logic: right | step: wrong');
  });

  it('case 2: "why" and "which line" are judged by the checker model with their code, the input, their output and the spec answer, with the quote it relied on', async () => {
    const { id } = await start();
    const model = fakeModel({ judge: ({ answer: text }) => (/size/.test(text) ? 'right' : 'partly') });
    await answer(id, '2', model);
    await answer(id, 'The loop runs to vec.size() so every pair is swapped twice', model);
    const why = pathOf(id)[1];
    expect(why).toMatchObject({ type: 'debug', expectedSource: 'model', result: 'right', method: 'model', quote: expect.stringContaining('vec.size()') });
    const sent = model.requests.find((r) => String(r.system).startsWith("You judge a student's"));
    const message = sent.messages[0].content[0].text;
    expect(message).toContain('5:         swap(vec[i], vec[vec.size() - 1 - i]);'); // their code with line numbers
    expect(message).toContain('Input: the vector {3, 5, 8}');
    expect(message).toContain('Their function printed: [3, 5, 8]');
    expect(message).toContain('The specification says it should print: [8, 5, 3]');
    await answer(id, 'Something on line 4', model);
    expect(pathOf(id)[2]).toMatchObject({ type: 'change', result: 'partly', quote: 'Something on line 4' });
    expect(entryOf(id).label).toBe('case 2 | why: right | line: partly');
    expect(model.requests.at(-1).messages[0].content[0].text).toContain('Their earlier answer to "why": The loop runs to vec.size()');
  });

  it('the judge\'s verdict stands only with a quote that is in the answer; otherwise it is unclear', async () => {
    const bad = async () => ({ text: JSON.stringify({ verdict: 'right', quote: 'words the student never wrote' }), inputTokens: 1, outputTokens: 1, latencyMs: 1 });
    const result = await judgeExplanation({ mode: 'why', question: 'q', code: CODE, input: 'x', theirOutput: 'y', specAnswer: 'z', answer: 'my loop is wrong', converseFn: bad, modelId: 'm' });
    expect(result).toMatchObject({ verdict: 'unclear', note: 'the quote is not in the answer' });
  });

  it('an unclear follow-up answer gets no clarify: it is logged as unclear and the interview moves on', async () => {
    const { id } = await start();
    goTo(id, CRAPS);
    const model = fakeModel();
    await answer(id, '1', model);
    const next = await answer(id, 'maybe 1 or 2, it depends', model);
    expect(pathOf(id, CRAPS)[1].result).toBe('unclear');
    expect(next.question).toContain('Suppose line 23 of your playCraps were changed'); // the next follow-up, not a clarify
    expect(pathOf(id, CRAPS).filter((s) => s.step === 'clarify')).toHaveLength(0);
  });

  it('a follow-up answer never gets its own follow-up: after follow-up 2 the next function begins', async () => {
    const { id } = await start();
    goTo(id, CRAPS);
    const model = fakeModel();
    await answer(id, '1', model);
    await answer(id, '1', model);
    const last = await answer(id, '1', model);
    expect(last).toEqual({ ended: true, status: 'completed' });
    expect(pathOf(id, CRAPS).filter((s) => s.step.startsWith('followUp'))).toHaveLength(2);
  });

  it('checkValue compares first and asks the model only when that is not clear', async () => {
    const model = fakeModel();
    expect((await checkValue({ kind: 'predict', expected: '[3, 5, 8]', question: 'q', answer: '3,5,8', converseFn: model, modelId: 'm' })).verdict).toBe('correct');
    expect(model.requests).toHaveLength(0);
    const unclear = await checkValue({ kind: 'predict', expected: '[3, 5, 8]', question: 'q', answer: 'it depends on things', converseFn: fakeModel({ decide: () => 'unclear' }), modelId: 'm' });
    expect(unclear.verdict).toBe('unclear');
  });
});

describe('the smaller code step (the agent picks, the question comes from a template)', () => {
  const material = formAPlan().questions[0].cases.case4.followUp2.material;
  const q = formAPlan().questions[0];
  const truth = { stops: material.stops };
  const write = (reply, extra = {}) => writeSmallStep({ converseFn: fakeModel({ write: typeof reply === 'function' ? reply : () => reply }), modelId: 'm', code: CODE, q, caseNo: 4, material, truth, ...extra });
  const good = { variable: 'left number', stop: 2 };
  const TEMPLATE = /^You put a breakpoint on line \d+ and run \w+ on .+\. When it stops for the \d+(st|nd|rd|th) time, what is .+\?$/;

  it('gets their function with line numbers and the private material, and picks one variable at one stop', async () => {
    const model = fakeModel({ write: () => good });
    const r = await writeSmallStep({ converseFn: model, modelId: 'm', code: CODE, q, caseNo: 4, material, truth });
    expect(r).toMatchObject({ ok: true, variable: 'left number', expression: 'vec[i]', stop: 2, expected: '2' });
    const message = model.requests[0].messages[0].content[0].text;
    expect(message).toContain('<function_code>');
    expect(message).toContain('3: void reverseList(vector<int>& vec) {');
    expect(message).toContain('Variables you may choose');
    expect(message).toContain('Stop 2: left number=2, right number=4');
    expect(model.requests[0].temperature).toBe(0);
    expect(message).not.toContain(USERNAME);
  });

  it('the question is the breakpoint template: the line, the function, the input stated, the Kth stop and their own expression', async () => {
    const r = await write(good);
    expect(r.text).toBe(`You put a breakpoint on line ${material.line} and run reverseList on ${material.input.display}. When it stops for the 2nd time, what is vec[i]?`);
    expect(r.text).toMatch(TEMPLATE);
    // no friendly name of ours, and no value of the private material, in what the student sees
    expect(r.text).not.toContain('left number');
    expect(r.text).not.toMatch(/right number/);
    const third = await write({ variable: 'right number', stop: 3 });
    expect(third.text).toContain('3rd time, what is vec[vec.size() - 1 - i]?');
    expect(third.expected).toBe('3');
  });

  it('whatever else the writer says is not used: free text, even a friendly name, never reaches the student', async () => {
    const r = await write({ ...good, question: 'What is the left number when it runs for the second time and the value is 2?' });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(TEMPLATE);
    expect(r.text).not.toContain('left number');
  });

  it('refuses an expression that is not in their function, then accepts the retry', async () => {
    const foreign = { ...material, variables: [{ name: 'total', expr: 'runningTotal' }, ...material.variables] };
    const r = await writeSmallStep({ converseFn: fakeModel({ write: ({ attempt }) => (attempt === 1 ? { variable: 'total', stop: 1 } : good) }), modelId: 'm', code: CODE, q, caseNo: 4, material: foreign, truth: { stops: material.stops.map((s) => `total=0, ${s}`) } });
    expect(r.ok).toBe(true);
    expect(r.calls).toHaveLength(2);
    expect(r.expression).toBe('vec[i]');
    expect(unknownIdentifiers('runningTotal + vec[i]', new Set(['vec', 'i']))).toEqual(['runningTotal']);
    expect(unknownIdentifiers('vec[vec.size() - 1 - i]', new Set(['vec', 'i']))).toEqual([]);
    expect(unknownIdentifiers('static_cast<int>(vec.size())', new Set(['vec']))).toEqual([]);
  });

  it('a name the material makes up is not known just because the material uses it: only their function counts', async () => {
    const foreign = { ...material, variables: [{ name: 'total', expr: 'runningTotal' }] };
    const r = await writeSmallStep({ converseFn: fakeModel({ write: () => ({ variable: 'total', stop: 1 }) }), modelId: 'm', code: CODE, q, caseNo: 4, material: foreign, truth: { stops: ['total=0', 'total=1'] } });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('runningTotal');
  });

  it('fails twice: follow-up 2 is skipped and the log says why', async () => {
    const bad = { variable: 'counter', stop: 1 };
    const r = await write(() => bad);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('refused twice') });
    expect(r.reason).toContain('counter');
    // through the interview: the skipped step is on the path and the label says so
    const { id } = await start();
    const model = fakeModel({ write: () => bad });
    await answer(id, '5', model);
    const last = await answer(id, '1', model);
    expect(pathOf(id)[2]).toMatchObject({ step: 'followUp2', type: 'smallStep', skipped: expect.stringContaining('refused twice') });
    expect(entryOf(id).label).toBe('case 4 | small logic: right | step: skipped');
    expect(last.question).toBe(formAPlan().questions[1].text); // on to the next function
  });

  it.each([
    ['a variable that is not listed', { ...good, variable: 'counter' }, 'not one of the listed'],
    ['a stop that does not exist', { ...good, stop: 9 }, 'does not exist'],
    ['a stop that is not a number', { ...good, stop: 'second' }, 'does not exist'],
    ['a reply that is not a JSON object', 'I would ask about the left number', 'not a JSON object'],
  ])('refuses %s', async (_name, reply, why) => {
    const r = await write(() => reply);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(why);
  });

  it('refuses a pick when the material has no input to state', async () => {
    const r = await writeSmallStep({ converseFn: fakeModel({ write: () => good }), modelId: 'm', code: CODE, q, caseNo: 4, material: { ...material, input: { display: '' } }, truth });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no input');
  });

  it('valueAt reads one variable of a stop, names with spaces included', () => {
    expect(valueAt('left number=1, right number=5', 'right number')).toBe('5');
    expect(valueAt('piece=""', 'piece')).toBe('""');
    expect(valueAt('piece="a"', 'other')).toBeNull();
  });
});

describe('unclear stays unclear in every final label', () => {
  const step = (name, type, result, extra = {}) => ({ step: name, type, result, ...extra });
  it('case 2: why and line unclear', () => {
    expect(a2.labelOf({ hasFollowUps: true, kind: 'logic', case: 2, clarified: false, path: [step('main', 'logic', 'right'), step('followUp1', 'debug', 'unclear'), step('followUp2', 'change', 'unclear')] })).toBe('case 2 | why: unclear | line: unclear');
  });
  it('the logic answer still unclear after the clarify is said in the label, and a skipped step stays skipped', () => {
    expect(a2.labelOf({ hasFollowUps: true, kind: 'logic', case: 4, clarified: true, path: [step('main', 'logic', 'unclear'), step('clarify', 'logic', 'unclear'), step('followUp1', 'smallLogic', 'unclear'), step('followUp2', 'smallStep', null, { skipped: 'x' })] })).toBe('case 4 (clarified) | main: unclear | small logic: unclear | step: skipped');
  });
  it('compile error and no code: unclear', () => {
    expect(a2.labelOf({ hasFollowUps: false, kind: 'compileError', path: [step('main', 'compile', 'unclear')] })).toBe('compile error: unclear');
    expect(a2.labelOf({ hasFollowUps: false, kind: 'logic', path: [step('main', 'logic', 'unclear')] })).toBe('no code: unclear');
  });
});

describe('a hedge is unclear, never wrong', () => {
  const HEDGES = [
    'It depends on the point number',
    'A few, it depends on how the loop is written',
    'Somebody wins at some point',
    'Not sure, maybe half of them',
    'A list with the letters in it, not sure about the empty ones',
  ];
  it.each(HEDGES)('"%s" is unclear without asking the model', async (text) => {
    expect(givesNoValue(text)).toBe(true);
    expect(compareValue({ kind: 'predict', expected: '1', answer: text })).toBe('unclear');
    const model = fakeModel({ decide: () => 'no' });
    const r = await checkValue({ kind: 'predict', expected: '1', question: 'q', answer: text, converseFn: model, modelId: 'm' });
    expect(r.verdict).toBe('unclear');
    expect(model.requests).toHaveLength(0);
  });

  it('an answer that gives a value is not a hedge, and the checker prompt says that no specific value is always unclear', () => {
    expect(givesNoValue('maybe 2')).toBe(false);
    expect(givesNoValue('5 or 2, they appear equally often')).toBe(false);
    expect(givesNoValue('It returns four pieces: empty, a, empty, b')).toBe(false);
    expect(CHECK_SYSTEM).toContain('ALWAYS "unclear", never "no"');
  });

  it('a hedge to the main question gets the clarify once, and a hedge to the clarify is logged as unclear and routed as logic wrong', async () => {
    const { id } = await start();
    const model = fakeModel({ decide: () => 'no' });
    const first = await answer(id, 'A few, it depends on how the loop is written', model);
    expect(first.question).toBe(formAPlan().questions[0].clarify);
    expect(pathOf(id)[0]).toMatchObject({ step: 'main', result: 'unclear', method: 'compare' });
    await answer(id, 'Not sure, maybe half of them', model);
    expect(pathOf(id)[1]).toMatchObject({ step: 'clarify', result: 'unclear' });
    expect(entryOf(id)).toMatchObject({ logicRight: false, case: 4, clarified: true });
    expect(model.requests).toHaveLength(0);
  });
});

describe('case 2 judge: clear rules, decided without the model where the answer is clear', () => {
  const judge = (mode, answer, model = fakeModel({ judge: () => 'right' })) => judgeExplanation({ mode, question: 'q', code: CODE, input: 'x', theirOutput: 'y', specAnswer: 'z', answer, converseFn: model, modelId: 'm' }).then((r) => ({ r, model }));

  it('the judge prompt states the rules for "why" and for "which line"', () => {
    expect(JUDGE_SYSTEM).toContain('matches THEIR code and THEIR output');
    expect(JUDGE_SYSTEM).toContain('blames the compiler, the test');
    expect(JUDGE_SYSTEM).toContain('a specific line of their function (a line number, or quoting their code) AND says the change');
    expect(JUDGE_SYSTEM).toContain('names no specific line');
    expect(JUDGE_SYSTEM).toContain('only if it points to the right line but gives no change');
  });

  it('a why that blames the compiler or the test, or says the code is fine, is wrong', async () => {
    for (const text of ['I think the compiler or the test is wrong, my code looks fine', 'The grader has a bug', 'Nothing is wrong with my function']) {
      const { r, model } = await judge('why', text);
      expect(r).toMatchObject({ verdict: 'wrong', method: 'compare', modelUsed: false });
      expect(model.requests).toHaveLength(0);
    }
  });

  it('a "which line" answer with no line number and no code is unclear', async () => {
    for (const text of ['The first line of the function, I would add a check there', 'Somewhere in the loop, I would fix it']) {
      const { r, model } = await judge('line', text);
      expect(r).toMatchObject({ verdict: 'unclear', method: 'compare', modelUsed: false });
      expect(model.requests).toHaveLength(0);
    }
  });

  it('an answer that names a line or quotes code goes to the model, at temperature 0', async () => {
    const { r, model } = await judge('line', 'Line 5: change `i < vec.size()` to `i < vec.size() / 2`');
    expect(r.verdict).toBe('correct');
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0].temperature).toBe(0);
    const { r: why } = await judge('why', 'Because my loop goes to vec.size() so every pair is swapped twice');
    expect(why.method).toBe('model');
  });

  it('the same answer gets the same verdict every time (a deterministic judge and a model at temperature 0)', async () => {
    const seen = new Set();
    for (let i = 0; i < 3; i += 1) seen.add((await judge('line', 'The first line of the function, I would add a check there')).r.verdict);
    expect(seen.size).toBe(1);
  });
});

describe('the final labels', () => {
  it('compile-error and logic-only questions keep their behavior: no clarify, no follow-ups, "compile error: right|wrong" and "no code: right|wrong"', async () => {
    const { id } = await start(brokenPlan());
    const model = fakeModel();
    const q2 = await answer(id, "The compiler says expected ';' before '}' token on that line", model);
    expect(entryOf(id, 0).label).toBe('compile error: right');
    expect(q2.question).toBe(brokenPlan().questions[1].text);
    const q3 = await answer(id, 'It splits at each comma, not sure how many pieces', model); // a hedge: unclear stays unclear, and no clarify for a logic-only question
    expect(entryOf(id, 1).label).toBe('no code: unclear');
    expect(pathOf(id, 1).filter((s) => s.step === 'clarify')).toHaveLength(0);
    expect(q3.question).toBe(brokenPlan().questions[2].text);
    const end = await answer(id, '1', model);
    expect(entryOf(id, 2).label).toBe('no code: right');
    expect(end).toEqual({ ended: true, status: 'completed' });
    const wrong = await start(brokenPlan());
    await answer(wrong.id, 'The function name is spelled wrong', fakeModel());
    expect(entryOf(wrong.id, 0).label).toBe('compile error: wrong');
    // unclear is never turned into wrong
    const vague = await start(brokenPlan());
    await answer(vague.id, 'I forgot something on that line, I would fix it', fakeModel({ decide: () => 'unclear' }));
    expect(entryOf(vague.id, 0).label).toBe('compile error: unclear');
  });

  it('a clarified function says so in its label', async () => {
    const { id } = await start();
    goTo(id, CRAPS);
    const model = fakeModel();
    await answer(id, 'Somebody wins at some point', model);
    await answer(id, '1', model);
    await answer(id, '1', model);
    await answer(id, '1', model);
    expect(entryOf(id, CRAPS).label).toBe('case 1 (clarified) | predict: right | what-if: right');
  });

  it('a whole interview ends with a label for every function, in a fixed short form', async () => {
    const { id } = await start();
    const model = fakeModel();
    const typed = ['2', 'The loop runs to vec.size() so every pair is swapped twice', 'I would change the loop bound on line 4', '"", "a", "", "b"', 'b', '["x", "b", "c"]', '1', '1', '1'];
    let last;
    for (const text of typed) last = await answer(id, text, model);
    expect(last).toEqual({ ended: true, status: 'completed' });
    expect(metaOf(id).a2Log.map((e) => e.label)).toEqual(['case 2 | why: right | line: right', 'case 1 | trace: right | what-if: right', 'case 1 | predict: right | what-if: right']);
    expect(metaOf(id).status).toBe('completed');
  });
});

describe('what a student, an admin and a model see', () => {
  it('the student view has the question and the answers only: no case, key, private value or log', async () => {
    const { id } = await start();
    await answer(id, '5', fakeModel());
    const student = await getInterview({ userId: ADMIN, interviewId: id, isAdmin: false, now: NOW + 9000 });
    const text = JSON.stringify(student);
    ['a2Log', 'answerKey', 'material', 'left number=', 'caseMeaning', 'expectedSource'].forEach((x) => expect(text).not.toContain(x));
    expect(student.interview.code).toBe(CODE);
  });

  it('the admin view has the per-function log (case, path, label) and no plan or username', async () => {
    const { id } = await start();
    await answer(id, '2', fakeModel());
    const { interview } = await getInterview({ userId: ADMIN, interviewId: id, isAdmin: true, now: NOW + 9000 });
    expect(interview.a2).toMatchObject({ importId: IMPORT_ID, form: 'A' });
    expect(interview.a2.questions[0]).toMatchObject({ function: 'reverseList', case: 2, caseMeaning: 'right idea, buggy code', codeRight: false });
    expect(interview.a2.questions[0].path[0]).toMatchObject({ step: 'main', result: 'right', expected: '2', expectedSource: 'spec' });
    expect(interview).not.toHaveProperty('a2Plan');
    expect(JSON.stringify(interview)).not.toContain(USERNAME);
  });

  it('no model request holds the GitHub username or the import id', async () => {
    const { id } = await start();
    const model = fakeModel();
    await answer(id, '5', model);
    await answer(id, '1', model);
    expect(model.requests.length).toBeGreaterThan(0);
    const sent = JSON.stringify(model.requests);
    expect(sent).not.toContain(USERNAME);
    expect(sent).not.toContain(IMPORT_ID);
  });
});

describe('case 2 is the only case that shows their output and the spec answer', () => {
  it('in the plan\'s texts: only the debug question carries them', () => {
    const q = formAPlan().questions[0];
    const debug = q.cases.case2.followUp1;
    const others = [q.text, q.cases.case2.followUp2.text, q.cases.case4.followUp1.text];
    expect(debug.text).toContain(debug.theirOutput);
    expect(debug.text).toContain(debug.specAnswer);
    others.forEach((t) => { expect(t).not.toContain(debug.theirOutput); expect(t).not.toContain(debug.specAnswer); });
  });

  it('in the questions the engine asks: no other step states their output, the spec answer or a private value', async () => {
    const { id } = await start();
    const model = fakeModel();
    for (const text of ['5', '1', '1']) await answer(id, text, model); // case 4 path: small logic, step
    const asked = pathOf(id).filter((s) => s.step !== 'main').map((s) => s.text).join(' ');
    ['[3, 5, 8]', '[8, 5, 3]', 'left number=1', 'right number=5'].forEach((secret) => expect(asked).not.toContain(secret));
  });
});

describe('the timer', () => {
  it('moves the deadline by the working time of the agent, like every other interview', async () => {
    const { id } = await start();
    let t = 0;
    const clock = () => { t += 1500; return t; };
    const next = await submitAnswer({ userId: ADMIN, interviewId: id, answer: '2', now: NOW + 1000, converseFn: fakeModel(), clock });
    expect(Date.parse(next.deadline) - (NOW + 20 * 60000)).toBe(1500);
    expect(metaOf(id).extraTimeMs).toBe(1500);
  });

  it('ends an interview that was answered after its deadline', async () => {
    const { id } = await start();
    const late = await submitAnswer({ userId: ADMIN, interviewId: id, answer: '2', now: NOW + 21 * 60000, converseFn: fakeModel(), clock: () => 0 });
    expect(late).toEqual({ ended: true, status: 'timed_out' });
  });
});

describe('the plan config', () => {
  it('is built from the assessment\'s setting and the plan: one theme with the main questions word for word', () => {
    const config = planConfig.buildConfig(MILESTONE.interview, formAPlan());
    expect(config).toMatchObject({ interviewOnly: true, source: 'a2-pilot', timeLimitMinutes: 20, promptVersion: 'host.a2' });
    expect(config.themes[0].mainQuestions).toEqual(formAPlan().questions.map((x) => x.text));
  });
  it('strips the GitHub username from the plan', () => {
    expect(JSON.stringify(planConfig.stripPlan(formAPlan()))).not.toContain(USERNAME);
  });
  it('routeCase', () => {
    expect([[true, true], [false, true], [true, false], [false, false], [null, true], [null, false]].map(([c, l]) => a2.routeCase(c, l))).toEqual([1, 2, 3, 4, 4, 4]);
  });
});

describe('a bare word for a string value is compared as that string, exactly', () => {
  const { compareValue } = require('../a2/check');
  test('"ax" is not "a": wrong, not unclear and not right; "a" is right', () => {
    expect(compareValue({ kind: 'tracing', expected: '"a"', answer: 'ax' })).toBe('wrong');
    expect(compareValue({ kind: 'tracing', expected: 'piece="a"', answer: 'ax' })).toBe('wrong');
    expect(compareValue({ kind: 'tracing', expected: '"a"', answer: 'a' })).toBe('correct');
    expect(compareValue({ kind: 'tracing', expected: '"ab"', answer: 'a' })).toBe('wrong');
    expect(compareValue({ kind: 'tracing', expected: '"ab"', answer: 'ab' })).toBe('correct');
    expect(compareValue({ kind: 'predict', expected: '"a", "b"', answer: 'a b' })).toBe('correct');
  });
});
