// host.v5, the split agent: step A checks the answer against the rubric (check.v1), step B writes the follow-up (write.v1).
const engine = require('../agent/interview-engine');
const split = require('../agent/split-agent');
const bedrock = require('../agent/bedrock-client');
const { isYesNo } = require('../agent/follow-up-check');
const { ModelUnavailableError } = require('../agent/bedrock-client');

const rubric = [
  { id: 'r1', text: 'Says the loop adds every grade to a running sum.' },
  { id: 'r2', text: 'Says the sum is divided by the number of grades.' },
  { id: 'r3', text: 'Says integer division cuts off the fraction.' },
];
const config = {
  enabled: true,
  timeLimitMinutes: 10,
  maxFollowUpsPerMainQuestion: 1,
  themes: [
    { id: 'avg', title: 'Averages', mainQuestions: ['Main A1?', 'Main A2?'], criteria: ['Student must explain how the average is computed'], rubric: [rubric, [{ id: 'r1', text: 'Says what the second question needs.' }]] },
  ],
};
const ANSWER = 'it adds the grades up and divides by 3 so about 81';
const turns = [{ role: 'host', text: 'Main A1?' }, { role: 'student', text: ANSWER }];
const run = (converseFn, over = {}) => engine.decideNext({
  config, state: engine.initialState(), code: 'int average(){ return 0; }', turns, promptVersion: 'host.v5', converseFn, ...over,
});

const evidence = (shown) => Object.fromEntries(rubric.map((r) => [r.id, shown.includes(r.id) ? { quote: 'adds the grades up', shown: true } : { quote: '', shown: false }]));
const checkReply = (shown = ['r1', 'r2']) => JSON.stringify({ evidence: evidence(shown), missing: rubric.map((r) => r.id).filter((id) => !shown.includes(id)) });
const writeReply = (question = 'Look at the line with sum / n. What happens to the digits after the decimal point there?', over = {}) => JSON.stringify({ target: 'r3', isHint: false, question, ...over });

const isCheck = (req) => /^You check one student's answer/.test(req.system);
/** A model with one script for the checker and one for the writer; every call is kept. */
const model = ({ check = [checkReply()], write = [writeReply()] } = {}) => {
  const calls = [];
  let c = 0;
  let w = 0;
  const fn = async (req) => {
    calls.push(req);
    const list = isCheck(req) ? check : write;
    const i = isCheck(req) ? c++ : w++;
    const next = list[Math.min(i, list.length - 1)];
    if (next instanceof Error) throw next;
    return { text: next, inputTokens: 100, outputTokens: 10, latencyMs: 20 };
  };
  fn.calls = calls;
  return fn;
};

describe('host.v5 is a rubric version without a single prompt', () => {
  it('is listed, is not the default, uses the rubric and splits', () => {
    expect(engine.PROMPT_VERSIONS).toContain('host.v5');
    expect(engine.PROMPT_VERSION).toBe('host.v3');
    expect(engine.usesSplit('host.v5')).toBe(true);
    expect(['host.v1', 'host.v2', 'host.v3', 'host.v4', 'host.v4.1'].map(engine.usesSplit)).toEqual([false, false, false, false, false]);
    expect(engine.usesRubric('host.v5')).toBe(true);
    expect(engine.RUBRIC_PROMPTS).toEqual(['host.v4', 'host.v4.1']);
  });
});

describe('step A, the check', () => {
  it('nothing missing: moves on after ONE call, no write call', async () => {
    const m = model({ check: [checkReply(['r1', 'r2', 'r3'])] });
    const out = await run(m);
    expect(m.calls).toHaveLength(1);
    expect(out).toMatchObject({ action: 'next_main', missing: [], fallback: null, question: 'Main A2?' });
    expect(out.reason).toMatch(/^check: /);
    expect(out.evidence.r1.shown).toBe(true);
  });

  it('sends the checker the main question, the rubric and the latest answer only (no code, no transcript)', async () => {
    const m = model({ check: [checkReply(['r1', 'r2', 'r3'])] });
    await run(m, { turns: [{ role: 'host', text: 'Main A1?' }, { role: 'student', text: 'first' }, { role: 'host', text: 'follow up?' }, { role: 'student', text: ANSWER }] });
    const message = m.calls[0].messages[0].content[0].text;
    expect(m.calls[0].system).toBe(require('../agent/rubric-check').CHECK_SYSTEM);
    expect(message).toContain('Main question: Main A1?');
    expect(message).toContain('- r3: Says integer division cuts off the fraction.');
    expect(message).toContain(ANSWER);
    expect(message).not.toMatch(/first|follow up|average\(\)/);
    expect(m.calls[0].temperature).toBe(0);
  });

  it('a reply that fails the evidence check is retried once with the problem named; the retry is used', async () => {
    const noQuote = JSON.stringify({ evidence: { ...evidence(['r2']), r1: { quote: '', shown: true } }, missing: ['r3'] });
    const m = model({ check: [noQuote, checkReply(['r1', 'r2'])] });
    const out = await run(m);
    expect(out.action).toBe('follow_up');
    expect(out.missing).toEqual(['r3']);
    expect(out.repairs).toContainEqual({ type: 'check_retry', fixed: true });
    const retry = m.calls[1].messages;
    expect(retry).toHaveLength(3);
    expect(retry[2].content[0].text).toMatch(/r1 is marked shown without a quote/);
  });

  it('a quote that is not in the answer, twice, falls back: the next main question, with the rejection recorded', async () => {
    const fake = JSON.stringify({ evidence: Object.fromEntries(rubric.map((r) => [r.id, { quote: 'never written', shown: true }])), missing: [] });
    const m = model({ check: [fake] });
    const out = await run(m);
    expect(m.calls).toHaveLength(2);
    expect(out).toMatchObject({ action: 'next_main', fallback: 'invalid_output' });
    expect(out.reason).toMatch(/^fallback: invalid model output/);
    expect(out.rejected.code).toBe('check_invalid');
    expect(out.rejected.reply).toMatch(/quote for r1 is not in the answer/);
  });

  it('missing that does not match the evidence is invalid', async () => {
    const bad = JSON.stringify({ evidence: evidence(['r1', 'r2']), missing: [] });
    const out = await run(model({ check: [bad] }));
    expect(out.fallback).toBe('invalid_output');
    expect(out.rejected.reply).toMatch(/missing does not match the evidence/);
  });

  it('a model that is unavailable falls back as model_unavailable', async () => {
    const out = await run(model({ check: [new ModelUnavailableError('ThrottlingException')] }));
    expect(out).toMatchObject({ action: 'next_main', fallback: 'model_unavailable' });
  });
});

describe('step B, the write', () => {
  it('something missing: one write call aimed at the first missing item; the record has evidence, missing, target, both models and every call', async () => {
    const m = model({ check: [checkReply(['r1'])] }); // r2 and r3 missing
    const out = await run(m, { checkerModelId: 'qwen.checker', writerModelId: 'deepseek.writer' });
    expect(m.calls).toHaveLength(2);
    expect(out).toMatchObject({ action: 'follow_up', missing: ['r2', 'r3'], target: 'r2', isHint: false, fallback: null });
    expect(out.question).toBe('Look at the line with sum / n. What happens to the digits after the decimal point there?');
    expect(out.models).toEqual({ checker: 'qwen.checker', writer: 'deepseek.writer' });
    expect(m.calls[0].modelId).toBe('qwen.checker');
    expect(m.calls[1].modelId).toBe('deepseek.writer');
    expect(out.calls).toEqual([
      { step: 'check', modelId: 'qwen.checker', inputTokens: 100, outputTokens: 10, latencyMs: 20 },
      { step: 'write', modelId: 'deepseek.writer', inputTokens: 100, outputTokens: 10, latencyMs: 20 },
    ]);
    expect(out.usage).toEqual({ inputTokens: 200, outputTokens: 20, latencyMs: 40 });
    expect(out.evidence.r1.shown).toBe(true);
    const fields = engine.recordFields(out);
    expect(fields).toMatchObject({ missing: ['r2', 'r3'], target: 'r2', models: out.models, calls: out.calls });
    expect(fields.evidence).toBeDefined();
  });

  it('the writer gets the code, the transcript, the main question, the rubric, the missing list and the target (not the evidence)', async () => {
    const m = model({ check: [checkReply(['r1'])] });
    await run(m, { turns: [{ role: 'host', text: 'Main A1?' }, { role: 'student', text: ANSWER }] });
    const message = m.calls[1].messages[0].content[0].text;
    expect(m.calls[1].system).toBe(split.WRITE_SYSTEM);
    expect(message).toContain('int average(){ return 0; }');
    expect(message).toContain('Main question: Main A1?');
    expect(message).toContain('- r3: Says integer division cuts off the fraction.');
    expect(message).toMatch(/<transcript>\n\[host\] Main A1\?\n<student_answer>\nit adds the grades up/);
    expect(message).toContain('Missing items: r2, r3');
    expect(message).toContain('Target: r2');
    expect(message).not.toMatch(/quote|evidence/);
  });

  it('the target is the first missing item even when the writer names another one; isHint comes from the writer', async () => {
    const out = await run(model({ check: [checkReply([])], write: [writeReply('Walk me through the loop. What is sum afterwards?', { target: 'r3', isHint: true })] }));
    expect(out).toMatchObject({ target: 'r1', isHint: true });
  });

  it('a rubric-wording rewrite: the model is asked once more and the rewrite is used', async () => {
    const leaky = writeReply('Explain why the loop adds every grade to a running sum or not?');
    const m = model({ check: [checkReply([])], write: [leaky, writeReply('Walk me through the first pass of the loop. What changes?')] });
    const out = await run(m);
    expect(out.question).toBe('Walk me through the first pass of the loop. What changes?');
    expect(out.repairs).toContainEqual({ type: 'leak_rewrite', original: expect.stringContaining('running sum'), fixed: true });
    expect(m.calls).toHaveLength(3);
  });

  it('a rewrite that still leaks, or a model that cannot be reached, falls back', async () => {
    const leaky = writeReply('Explain why the loop adds every grade to a running sum or not?');
    const out = await run(model({ check: [checkReply([])], write: [leaky] }));
    expect(out).toMatchObject({ action: 'next_main', fallback: 'invalid_output' });
    expect(out.rejected.code).toBe('rubric_leak');
    const down = await run(model({ check: [checkReply([])], write: [new ModelUnavailableError('InternalServerException')] }));
    expect(down.fallback).toBe('model_unavailable');
  });

  it('a yes/no follow-up is rewritten once as an open question, otherwise the engine falls back', async () => {
    const yesNo = writeReply('Does the division drop the fraction?');
    const fixed = await run(model({ check: [checkReply([])], write: [yesNo, writeReply('What happens to the fraction in the division?')] }));
    expect(fixed.question).toBe('What happens to the fraction in the division?');
    expect(fixed.repairs).toContainEqual({ type: 'yes_no_rewrite', original: 'Does the division drop the fraction?', fixed: true });
    const bad = await run(model({ check: [checkReply([])], write: [yesNo] }));
    expect(bad).toMatchObject({ fallback: 'invalid_output' });
    expect(bad.rejected.code).toBe('yes_no');
  });

  it('a two-question follow-up is rewritten once; if that fails only the first question is kept; the guard is recorded', async () => {
    const two = writeReply('What is sum afterwards? What is n?');
    const fixed = await run(model({ check: [checkReply([])], write: [two, writeReply('What is sum afterwards?')] }));
    expect(fixed.question).toBe('What is sum afterwards?');
    expect(fixed.guard).toMatchObject({ fired: true, original: 'What is sum afterwards? What is n?', fixedByRetry: true });
    const kept = await run(model({ check: [checkReply([])], write: [two] }));
    expect(kept.question).toBe('What is sum afterwards?');
    expect(kept.guard.fixedByRetry).toBe(false);
  });

  it('a writer reply that is not JSON is asked for once more', async () => {
    const m = model({ check: [checkReply([])], write: ['Here is a question for you.', writeReply('What is sum afterwards?')] });
    const out = await run(m);
    expect(out.question).toBe('What is sum afterwards?');
    expect(out.repairs).toContainEqual({ type: 'json_retry', fixed: true });
    expect(m.calls[2].messages[2].content[0].text).toBe(split.REQUESTS.json);
    const none = await run(model({ check: [checkReply([])], write: ['no', 'still no'] }));
    expect(none.rejected.code).toBe('bad_json');
  });

  it('the rewrite requests are the same as the engine uses for host.v4.1', () => {
    expect(split.REQUESTS).toEqual({
      json: engine.JSON_RETRY_REQUEST, leak: engine.LEAK_REWRITE_REQUEST, yesNo: engine.YES_NO_REWRITE_REQUEST, twoQuestions: engine.REWRITE_REQUEST,
    });
  });
});

describe('models, the skip, and the other versions', () => {
  it('the checker and writer ids are options, then environment variables, then DeepSeek v3.2; both are direct ids', () => {
    expect(split.resolveSplitModels({})).toEqual({ checker: 'deepseek.v3.2', writer: 'deepseek.v3.2' });
    expect(split.resolveSplitModels({ checkerModelId: 'a.b', writerModelId: 'c.d' })).toEqual({ checker: 'a.b', writer: 'c.d' });
    process.env.AGENT_CHECKER_MODEL_ID = 'env.checker';
    process.env.AGENT_WRITER_MODEL_ID = 'env.writer';
    try {
      expect(split.resolveSplitModels({})).toEqual({ checker: 'env.checker', writer: 'env.writer' });
      expect(split.resolveSplitModels({ writerModelId: 'x.y' })).toEqual({ checker: 'env.checker', writer: 'x.y' });
    } finally {
      delete process.env.AGENT_CHECKER_MODEL_ID;
      delete process.env.AGENT_WRITER_MODEL_ID;
    }
    expect(bedrock.resolveModelId('deepseek.v3.2')).toBe('deepseek.v3.2');
    expect(bedrock.isOpenWeightModel('deepseek.v3.2')).toBe(true);
    expect(() => bedrock.resolveModelId('us.anthropic.claude-haiku-5-5')).toThrow(/direct model ID/);
  });

  it('with no follow-up left the engine decides alone: no check, no write', async () => {
    const m = model();
    const out = await run(m, { state: { ...engine.initialState(), followUpCount: 1 } });
    expect(m.calls).toHaveLength(0);
    expect(out).toMatchObject({ action: 'next_main', engineDecision: true });
  });

  it('on the last main question, nothing missing ends the interview', async () => {
    const out = await run(model({ check: [checkReply(['r1', 'r2', 'r3'])] }), { state: { ...engine.initialState(), mainIndex: 1 }, config: { ...config, themes: [{ ...config.themes[0], mainQuestions: ['Main A1?', 'Main A2?'] }] } });
    expect(out.action).toBe('end');
  });

  it('the stored turn of a student interview does not carry the evidence, models or calls', () => {
    const { toStudentInterview } = require('../services/interview-service');
    const view = toStudentInterview(
      { interviewId: 'i', status: 'in_progress', deadline: 'x' },
      [{ role: 'host', text: 'q', createdAt: 'z', missing: ['r1'], target: 'r1', evidence: { r1: { quote: 'a', shown: false } }, models: { checker: 'm', writer: 'm' }, calls: [{ step: 'check' }], repairs: [{ type: 'check_retry' }], rejected: { code: 'x', reply: 'y' } }]
    );
    expect(JSON.stringify(view)).not.toMatch(/evidence|models|calls|repairs|rejected|missing|target/);
  });
});

describe('the yes/no check also looks at the last clause', () => {
  it('flags the real examples and not a wh-question', () => {
    expect(isYesNo('When the controller is in ALARM state, does the pump turn on again even if the next reading is valid?')).toBe(true);
    expect(isYesNo('In your step function, if you call it twice with the exact same parameters, will it always return the same state?')).toBe(true);
    expect(isYesNo('When does the pump actually start?')).toBe(false);
  });

  it('still flags a question that starts with the word, and leaves open questions alone', () => {
    expect(isYesNo('Does the pump start at 18?')).toBe(true);
    expect(isYesNo('Walk me through 85. What state is it in, and why?')).toBe(false);
    expect(isYesNo('If the reading is -5, what does the controller do next?')).toBe(false);
    expect(isYesNo('Explain, in your own words, how the loop reaches the sum.')).toBe(false);
    ['is', 'are', 'did', 'can', 'could', 'would', 'should', 'has', 'have', 'do'].forEach((w) => expect(isYesNo(`At 40, ${w} the pump run?`)).toBe(true));
  });
});
