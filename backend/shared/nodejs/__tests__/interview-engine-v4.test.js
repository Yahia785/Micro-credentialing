const fs = require('fs');
const path = require('path');
const engine = require('../agent/interview-engine');
const { ModelUnavailableError } = require('../agent/bedrock-client');
const { isMultiPart, firstQuestionOnly } = require('../agent/follow-up-check');

const rubricA1 = [
  { id: 'r1', text: 'Says the loop adds every grade to a running sum.' },
  { id: 'r2', text: 'Says the sum is divided by the number of grades.' },
  { id: 'r3', text: 'Says integer division cuts off the fraction.' },
];
const config = {
  enabled: true,
  timeLimitMinutes: 10,
  maxFollowUpsPerMainQuestion: 1,
  themes: [
    {
      id: 'avg',
      title: 'Averages',
      mainQuestions: ['Main A1?', 'Main A2?'],
      criteria: ['Student must explain how the average is computed'],
      rubric: [rubricA1, [{ id: 'r1', text: 'Says what the second question needs.' }]],
    },
    { id: 'edge', title: 'Edge cases', mainQuestions: ['Main B1?'], criteria: ['Student names the empty case'] },
  ],
};
const withoutRubric = () => ({ ...config, themes: config.themes.map(({ rubric, ...theme }) => theme) });

const ok = (obj) => async () => ({ text: JSON.stringify(obj), inputTokens: 100, outputTokens: 20, latencyMs: 50 });
const v4Follow = (over = {}) => ok({
  missing: ['r2', 'r3'], action: 'follow_up', target: 'r2', isHint: false, question: 'What does the code do after the loop ends?', reason: 'r2 is not shown.', ...over,
});
const turns = [{ role: 'host', text: 'Main A1?' }, { role: 'student', text: 'my answer' }];
const st = (over = {}) => ({ ...engine.initialState(), ...over });
const run = (converseFn, { promptVersion = 'host.v4', state = st(), cfg = config } = {}) =>
  engine.decideNext({ config: cfg, state, code: 'int main(){}', turns, promptVersion, converseFn });

describe('the rubric in the config', () => {
  it('is a list per main question next to the criteria; a config without one falls back to the criteria', () => {
    expect(engine.rubricFor(config, st())).toEqual(rubricA1);
    expect(engine.rubricFor(config, st({ mainIndex: 1 }))).toEqual([{ id: 'r1', text: 'Says what the second question needs.' }]);
    expect(engine.rubricFor(config, st({ themeIndex: 1 }))).toEqual([{ id: 'r1', text: 'Student names the empty case' }]);
  });

  it('only host.v4 and host.v4.1 use a rubric', () => {
    expect(engine.RUBRIC_PROMPTS).toEqual(['host.v4', 'host.v4.1']);
    expect(['host.v1', 'host.v2', 'host.v3', 'host.v4'].map(engine.usesRubric)).toEqual([false, false, false, true]);
  });

  it('host.v1 to host.v3 get exactly the message they got before: the rubric is not in it', async () => {
    for (const promptVersion of ['host.v1', 'host.v2', 'host.v3']) {
      const sent = [];
      const spy = async (req) => { sent.push(req.messages[0].content[0].text); return ok({ action: 'next_main', question: '', reason: 'ok' })(); };
      await run(spy, { promptVersion });
      await run(spy, { promptVersion, cfg: withoutRubric() });
      expect(sent).toHaveLength(2);
      expect(sent[0]).toBe(sent[1]); // identical with and without a rubric in the config
      expect(sent[0]).not.toMatch(/Rubric|running sum|r1:/);
      expect(sent[0]).toBe(engine.buildUserMessage({ config, state: st(), code: 'int main(){}', turns }));
    }
  });

  it('host.v4 gets the rubric items of the current main question inside the instructor block', async () => {
    let sent;
    await run(async (req) => { sent = req.messages[0].content[0].text; return v4Follow()(); });
    const block = sent.slice(sent.indexOf('<instructor_config>'), sent.indexOf('</instructor_config>'));
    expect(block).toContain('Rubric for this main question (private; a full answer shows every item):');
    expect(block).toContain('- r1: Says the loop adds every grade to a running sum.');
    expect(block).toContain('- r3: Says integer division cuts off the fraction.');
    expect(block).not.toContain('Says what the second question needs.'); // the other main question's rubric
    expect(sent).not.toContain('</instructor_config>\n- r1'); // never outside the block
  });

  it('students never see it: the student view of an interview has no rubric, missing, target or hint', () => {
    const { toStudentInterview } = require('../services/interview-service');
    const view = toStudentInterview(
      { interviewId: 'i', status: 'in_progress', startedAt: 'x', deadline: 'y' },
      [{ role: 'host', text: 'q', createdAt: 'z', missing: ['r1'], target: 'r1', isHint: true, reason: 'r1 is not shown', guard: { fired: true } }]
    );
    expect(view.turns).toEqual([{ role: 'host', text: 'q', createdAt: 'z' }]);
  });
});

describe('host.v4.md', () => {
  const text = engine.loadPrompt('host.v4');

  it('asks for the rubric check first and for one question aimed at the first missing item', () => {
    expect(text).toMatch(/Return "missing"/);
    expect(text).toMatch(/first one in rubric order/);
    expect(text).toMatch(/Ask exactly ONE question/);
    expect(text).toMatch(/Never state, quote or paraphrase any part of a rubric item/);
    expect(text).toMatch(/Never confirm or correct the answer/);
    expect(text).toMatch(/"isHint"/);
    expect(text).toMatch(/reason" must justify the action/);
  });

  it('uses examples from a program that is in no eval case', () => {
    expect(text).toMatch(/average/);
    expect(text).not.toMatch(/linked list|pushFront|removeFront|stack|word count|countWords|tank|FILLING|ALARM|hysteresis/i);
  });

  it('does not change the other prompts', () => {
    expect(new Set(['host.v1', 'host.v2', 'host.v3', 'host.v4'].map(engine.loadPrompt)).size).toBe(4);
    expect(engine.resolvePromptVersion('host.v4')).toBe('host.v4');
    delete process.env.AGENT_PROMPT_VERSION;
    expect(engine.resolvePromptVersion()).toBe('host.v3'); // host.v3 stays the default
    expect(fs.existsSync(path.join(__dirname, '../agent/prompts/host.v4.md'))).toBe(true);
  });
});

describe('host.v4 reply parsing', () => {
  const parse = (obj, rubric = rubricA1) => engine.parseHostOutput(JSON.stringify(obj), { criteria: ['Student must explain how the average is computed'], rubric });

  it('reads missing, target and isHint from a follow-up', () => {
    const out = parse({ missing: ['r3', 'r2'], action: 'follow_up', target: 'R2', isHint: true, question: 'What happens after the loop?', reason: 'x' });
    expect(out.ok).toBe(true);
    expect(out.value).toEqual({ action: 'follow_up', question: 'What happens after the loop?', reason: 'x', missing: ['r2', 'r3'], target: 'r2', isHint: true });
  });

  it('next_main and end carry the missing list but no target and no hint', () => {
    const out = parse({ missing: [], action: 'next_main', target: 'r1', isHint: true, question: 'ignored', reason: 'done' });
    expect(out.value).toEqual({ action: 'next_main', question: '', reason: 'done', missing: [], target: null, isHint: false });
  });

  it('ignores "none" in the missing list and repeated ids', () => {
    expect(parse({ missing: ['none'], action: 'next_main', reason: 'x' }).value.missing).toEqual([]);
    expect(parse({ missing: ['r1', 'r1'], action: 'next_main', reason: 'x' }).value.missing).toEqual(['r1']);
  });

  it.each([
    ['missing is absent', { action: 'next_main', reason: 'x' }],
    ['missing is not a list', { missing: 'r1', action: 'next_main', reason: 'x' }],
    ['missing has an unknown id', { missing: ['r9'], action: 'next_main', reason: 'x' }],
    ['missing has a non-string', { missing: [1], action: 'next_main', reason: 'x' }],
    ['a follow-up has no target', { missing: ['r1'], action: 'follow_up', question: 'Why?', reason: 'x' }],
    ['a follow-up has an unknown target', { missing: ['r1'], action: 'follow_up', target: 'r7', question: 'Why?', reason: 'x' }],
  ])('is invalid output when %s', (_name, obj) => {
    expect(parse(obj).ok).toBe(false);
  });

  it('only a boolean true makes a hint', () => {
    const base = { missing: ['r1'], action: 'follow_up', target: 'r1', question: 'Look at the loop. What is sum after one pass?', reason: 'x' };
    expect(parse({ ...base, isHint: 'true' }).value.isHint).toBe(false);
    expect(parse({ ...base }).value.isHint).toBe(false);
    expect(parse({ ...base, isHint: true }).value.isHint).toBe(true);
  });

  it('rejects a follow-up that repeats a rubric item (five words in a row), as it does for the criteria', () => {
    const leaked = parse({ missing: ['r3'], action: 'follow_up', target: 'r3', question: 'Does integer division cuts off the fraction?', reason: 'x' });
    expect(leaked.ok).toBe(false);
    expect(parse({ missing: ['r3'], action: 'follow_up', target: 'r3', question: 'What happens to the digits after the point?', reason: 'x' }).ok).toBe(true);
  });

  it('without a rubric (host.v1 to host.v3) the reply is read as before, with no rubric fields', () => {
    const out = engine.parseHostOutput(JSON.stringify({ action: 'follow_up', question: 'Why line 12?', reason: 'x', missing: ['r9'], target: 'zz' }), { criteria: [] });
    expect(out.ok).toBe(true);
    expect(out.value).toEqual({ action: 'follow_up', question: 'Why line 12?', reason: 'x' });
  });

  it('the decision keeps them and records them for the turn; the target and hint only for a follow-up that was asked', async () => {
    const out = await run(v4Follow({ isHint: true }));
    expect(out).toMatchObject({ action: 'follow_up', missing: ['r2', 'r3'], target: 'r2', isHint: true });
    expect(engine.recordFields(out)).toEqual({ missing: ['r2', 'r3'], target: 'r2', isHint: true });
    const moved = await run(ok({ missing: ['r1'], action: 'next_main', target: '', isHint: false, question: '', reason: 'ok' }));
    expect(moved).toMatchObject({ action: 'next_main', missing: ['r1'], target: null, isHint: false });
    const old = await run(ok({ action: 'follow_up', question: 'Why line 12?', reason: 'x' }), { promptVersion: 'host.v3' });
    expect(engine.recordFields(old)).toEqual({});
  });

  it('a v4 reply without missing falls back like any invalid output', async () => {
    const out = await run(ok({ action: 'next_main', question: '', reason: 'ok' }));
    expect(out.fallback).toBe('invalid_output');
    expect(out.missing).toBeUndefined();
  });
});

describe('two-question guard', () => {
  // The replies below have no rubric fields, so they run on host.v3 unless a test says host.v4.
  const runV3 = (fn, o = {}) => run(fn, { promptVersion: 'host.v3', ...o });
  const twoQuestions = 'What happens after the loop? How is the sum used?';
  const sequence = (...replies) => {
    const fn = jest.fn(async () => { throw new Error('no more replies'); });
    replies.forEach((r) => fn.mockImplementationOnce(r));
    return fn;
  };
  const oneReply = (question, extra = {}) => ok({ action: 'follow_up', question, reason: 'vague', ...extra });

  it('the text check and the first-question cut', () => {
    expect(isMultiPart(twoQuestions)).toBe(true);
    expect(isMultiPart('What happens first, and what happens after that?')).toBe(true);
    expect(isMultiPart('What happens after the loop?')).toBe(false);
    expect(firstQuestionOnly(twoQuestions)).toBe('What happens after the loop?');
    expect(firstQuestionOnly('What happens first, and what happens after that?')).toBe('What happens first?');
    expect(firstQuestionOnly('What happens after the loop?')).toBe('What happens after the loop?');
    expect(firstQuestionOnly('Look at the loop. Why is sum an int? And what about n?')).toBe('Look at the loop. Why is sum an int?');
  });

  it.each(['host.v1', 'host.v2', 'host.v3'])('%s: asks the model once to rewrite it as one question, and uses the rewrite', async (promptVersion) => {
    const converse = sequence(oneReply(twoQuestions), oneReply('What happens after the loop?'));
    const out = await run(converse, { promptVersion });
    expect(converse).toHaveBeenCalledTimes(2);
    const retry = converse.mock.calls[1][0];
    expect(retry.messages).toHaveLength(3);
    expect(retry.messages[1].role).toBe('assistant');
    expect(retry.messages[2].content[0].text).toBe(engine.REWRITE_REQUEST);
    expect(retry.system).toBe(converse.mock.calls[0][0].system);
    expect(out).toMatchObject({ action: 'follow_up', question: 'What happens after the loop?' });
    expect(out.guard).toEqual({ fired: true, original: twoQuestions, fixedByRetry: true });
    expect(out.usage).toEqual({ inputTokens: 200, outputTokens: 40, latencyMs: 100 }); // both calls are counted
    expect(engine.recordFields(out).guard).toEqual(out.guard);
  });

  it('keeps only the first question when the rewrite still asks two', async () => {
    const converse = sequence(oneReply(twoQuestions), oneReply('Why a loop? And why a sum?'));
    const out = await runV3(converse);
    expect(converse).toHaveBeenCalledTimes(2);
    expect(out.question).toBe('What happens after the loop?');
    expect(out.guard).toMatchObject({ fired: true, fixedByRetry: false, original: twoQuestions });
  });

  it('keeps only the first question when the rewrite is unreadable or the model fails', async () => {
    const unreadable = await runV3(sequence(oneReply(twoQuestions), async () => ({ text: 'sorry', inputTokens: 1, outputTokens: 1, latencyMs: 1 })));
    expect(unreadable.question).toBe('What happens after the loop?');
    expect(unreadable.guard.fixedByRetry).toBe(false);

    const failed = await runV3(sequence(oneReply(twoQuestions), async () => { throw new ModelUnavailableError('ThrottlingException'); }));
    expect(failed.question).toBe('What happens after the loop?');
    expect(failed.fallback).toBeNull(); // the follow-up itself was fine
    expect(failed.guard).toMatchObject({ fired: true, fixedByRetry: false, retryFailed: true });
  });

  it('does not fire for a single question, for next_main, or when no follow-up is allowed', async () => {
    const single = sequence(oneReply('What happens after the loop?'));
    const out = await runV3(single);
    expect(single).toHaveBeenCalledTimes(1);
    expect(out.guard).toBeUndefined();

    const moveOn = sequence(ok({ action: 'next_main', question: 'What? Why?', reason: 'ok' }));
    expect((await runV3(moveOn)).guard).toBeUndefined();

    const noBudget = sequence(oneReply(twoQuestions));
    await runV3(noBudget, { state: st({ followUpCount: 1 }) });
    expect(noBudget).not.toHaveBeenCalled(); // engine decided alone
  });

  it('works for host.v4 and keeps the rubric fields of the first reply', async () => {
    const converse = sequence(
      v4Follow({ question: twoQuestions, isHint: true }),
      ok({ missing: ['r2', 'r3'], action: 'follow_up', target: 'r2', isHint: false, question: 'What happens after the loop?', reason: 'x' }),
    );
    const out = await run(converse, { promptVersion: 'host.v4' });
    expect(out).toMatchObject({ question: 'What happens after the loop?', missing: ['r2', 'r3'], target: 'r2' });
    expect(out.guard.fixedByRetry).toBe(true);
    // the retry message still carries the whole first conversation, rubric included
    expect(converse.mock.calls[1][0].messages[0].content[0].text).toContain('- r2: Says the sum is divided by the number of grades.');
  });
});

describe('hint', () => {
  it('is stored with the follow-up and reaches the Host turn in the interview service record', () => {
    const decision = {
      action: 'follow_up', missing: ['r1'], target: 'r1', isHint: true,
    };
    expect(engine.recordFields(decision)).toEqual({ missing: ['r1'], target: 'r1', isHint: true });
  });
});
