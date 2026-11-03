// host.v4.1: repairs (target, rubric-wording rewrite, JSON retry), the yes/no guard, the prompt text, and that host.v4 stays as it was.
const fs = require('fs');
const path = require('path');
const engine = require('../agent/interview-engine');
const { ModelUnavailableError } = require('../agent/bedrock-client');

const rubricA1 = [
  { id: 'r1', text: 'Says the loop adds every grade to a running sum.' },
  { id: 'r2', text: 'Says the sum is divided by the number of grades.' },
  { id: 'r3', text: 'Says integer division cuts off the fraction.' },
];
const config = {
  enabled: true,
  timeLimitMinutes: 10,
  maxFollowUpsPerMainQuestion: 1,
  themes: [{ id: 'avg', title: 'Averages', mainQuestions: ['Main A1?', 'Main A2?'], criteria: ['Student must explain how the average is computed'], rubric: [rubricA1, [{ id: 'r1', text: 'Says what the second question needs.' }]] }],
};
const turns = [{ role: 'host', text: 'Main A1?' }, { role: 'student', text: 'my answer' }];
const run = (converseFn, promptVersion = 'host.v4.1') =>
  engine.decideNext({ config, state: engine.initialState(), code: 'int main(){}', turns, promptVersion, converseFn });

const reply = (over = {}) => JSON.stringify({
  missing: ['r2', 'r3'], action: 'follow_up', target: 'r2', isHint: false, question: 'What does the code do after the loop ends?', reason: 'r2 is not shown.', ...over,
});
const text = (t) => ({ text: t, inputTokens: 100, outputTokens: 20, latencyMs: 50 });
/** A model that answers with the given replies in turn and keeps every request. */
const scripted = (...replies) => {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    const next = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (next instanceof Error) throw next;
    return text(next);
  };
  fn.calls = calls;
  return fn;
};

describe('host.v4.1 is a rubric prompt that repairs', () => {
  it('is listed, uses the rubric, and is the only version that repairs', () => {
    expect(engine.PROMPT_VERSIONS).toContain('host.v4.1');
    expect(engine.PROMPT_VERSION).toBe('host.v3');
    expect(['host.v1', 'host.v2', 'host.v3', 'host.v4', 'host.v4.1'].map(engine.usesRubric)).toEqual([false, false, false, true, true]);
    expect(['host.v1', 'host.v2', 'host.v3', 'host.v4', 'host.v4.1'].map(engine.repairsReplies)).toEqual([false, false, false, false, true]);
  });
});

describe('target repair', () => {
  it('sets the target to the first missing id when it is missing, unknown or not missing; records it', async () => {
    for (const target of [undefined, '', 'r9', 'r1']) {
      const model = scripted(reply({ target }));
      const out = await run(model);
      expect(out.fallback).toBeNull();
      expect(out.action).toBe('follow_up');
      expect(out.target).toBe('r2');
      expect(out.repairs).toEqual([{ type: 'target', from: target === undefined ? null : target, to: 'r2' }]);
      expect(model.calls).toHaveLength(1); // no extra call
    }
  });

  it('leaves a correct target alone and records nothing', async () => {
    const out = await run(scripted(reply({ target: 'r3' })));
    expect(out.target).toBe('r3');
    expect(out.repairs).toBeUndefined();
  });

  it('does not repair when nothing is missing', async () => {
    const out = await run(scripted(reply({ missing: [], target: undefined })));
    expect(out.fallback).toBe('invalid_output');
    expect(out.rejected.code).toBe('target_invalid');
  });

  it('host.v4 still fails on a missing target, as before', async () => {
    const out = await run(scripted(reply({ target: undefined })), 'host.v4');
    expect(out.fallback).toBe('invalid_output');
    expect(out.action).toBe('next_main');
    expect(out.rejected.code).toBe('target_invalid');
    expect(out.repairs).toBeUndefined();
  });
});

describe('rewrite after the rubric-wording check', () => {
  const leaky = reply({ question: 'Does the loop adds every grade to a running sum or not?'.replace('Does the loop adds', 'Explain how the loop adds') });

  it('asks the model once to rewrite and uses the rewrite', async () => {
    const model = scripted(leaky, reply({ question: 'Walk through the first pass of the loop. What changes?' }));
    const out = await run(model);
    expect(model.calls).toHaveLength(2);
    expect(out.fallback).toBeNull();
    expect(out.question).toBe('Walk through the first pass of the loop. What changes?');
    expect(out.repairs).toEqual([{ type: 'leak_rewrite', original: expect.stringContaining('adds every grade to a running sum'), fixed: true }]);
    expect(model.calls[1].messages).toHaveLength(3);
    expect(model.calls[1].messages[2].content[0].text).toBe(engine.LEAK_REWRITE_REQUEST);
  });

  it('falls back when the rewrite leaks too, or the model cannot answer', async () => {
    const twice = await run(scripted(leaky, leaky));
    expect(twice.fallback).toBe('invalid_output');
    expect(twice.repairs).toEqual([expect.objectContaining({ type: 'leak_rewrite', fixed: false })]);
    expect(twice.rejected.code).toBe('rubric_leak');
    const down = await run(scripted(leaky, new ModelUnavailableError('down')));
    expect(down.fallback).toBe('invalid_output');
    expect(down.repairs).toEqual([expect.objectContaining({ type: 'leak_rewrite', fixed: false })]);
  });

  it('host.v4 falls back at once, with no second call', async () => {
    const model = scripted(leaky, reply());
    const out = await run(model, 'host.v4');
    expect(model.calls).toHaveLength(1);
    expect(out.fallback).toBe('invalid_output');
    expect(out.rejected.code).toBe('rubric_leak');
  });
});

describe('JSON retry', () => {
  it('asks once more for the JSON object only and uses it', async () => {
    const model = scripted('Sure! I think the student should be asked about the sum.', reply());
    const out = await run(model);
    expect(model.calls).toHaveLength(2);
    expect(out.fallback).toBeNull();
    expect(out.repairs).toEqual([{ type: 'json_retry', fixed: true }]);
    expect(model.calls[1].messages[2].content[0].text).toBe(engine.JSON_RETRY_REQUEST);
    expect(out.usage.inputTokens).toBe(200); // both calls counted
  });

  it('falls back when the retry is not JSON either', async () => {
    const out = await run(scripted('no json', 'still none'));
    expect(out.fallback).toBe('invalid_output');
    expect(out.repairs).toEqual([{ type: 'json_retry', fixed: false }]);
    expect(out.rejected).toEqual({ code: 'bad_json', reply: 'still none' });
  });

  it('is not used for a reply that is JSON but invalid, and not by host.v4', async () => {
    const odd = await run(scripted(reply({ action: 'jump' })));
    expect(odd.rejected.code).toBe('bad_action');
    const model = scripted('no json', reply());
    const v4 = await run(model, 'host.v4');
    expect(model.calls).toHaveLength(1);
    expect(v4.rejected).toEqual({ code: 'bad_json', reply: 'no json' });
  });
});

describe('yes/no guard', () => {
  const yesNo = reply({ question: 'Does the division drop the fraction?' });

  it('rewrites a yes/no follow-up once as an open question (host.v4.1 and host.v4)', async () => {
    for (const version of ['host.v4.1', 'host.v4']) {
      const model = scripted(yesNo, reply({ question: 'What happens to the fraction in the division?' }));
      const out = await run(model, version);
      expect(model.calls).toHaveLength(2);
      expect(out.fallback).toBeNull();
      expect(out.question).toBe('What happens to the fraction in the division?');
      expect(out.repairs).toEqual([{ type: 'yes_no_rewrite', original: 'Does the division drop the fraction?', fixed: true }]);
      expect(model.calls[1].messages[2].content[0].text).toBe(engine.YES_NO_REWRITE_REQUEST);
    }
  });

  it('falls back when the rewrite is still yes/no or the model is unavailable', async () => {
    const still = await run(scripted(yesNo, yesNo));
    expect(still.fallback).toBe('invalid_output');
    expect(still.action).toBe('next_main');
    expect(still.rejected.code).toBe('yes_no');
    const down = await run(scripted(yesNo, new ModelUnavailableError('down')), 'host.v4');
    expect(down.fallback).toBe('invalid_output');
    expect(down.repairs).toEqual([expect.objectContaining({ type: 'yes_no_rewrite', fixed: false })]);
  });

  it('does not touch host.v1 to host.v3', async () => {
    for (const version of ['host.v1', 'host.v2', 'host.v3']) {
      const model = scripted(JSON.stringify({ action: 'follow_up', question: 'Does the division drop the fraction?', reason: 'x' }));
      const out = await run(model, version);
      expect(model.calls).toHaveLength(1);
      expect(out.question).toBe('Does the division drop the fraction?');
      expect(out.repairs).toBeUndefined();
    }
  });
});

describe('host.v4 behaves as before', () => {
  it('a valid reply passes through untouched', async () => {
    const model = scripted(reply());
    const out = await run(model, 'host.v4');
    expect(model.calls).toHaveLength(1);
    expect(out).toMatchObject({ action: 'follow_up', question: 'What does the code do after the loop ends?', target: 'r2', missing: ['r2', 'r3'], isHint: false, fallback: null });
    expect(out.repairs).toBeUndefined();
    expect(out.rejected).toBeUndefined();
  });

  it('an unknown rubric id in missing, and a rubric word, still fail', async () => {
    expect((await run(scripted(reply({ missing: ['r7'] })), 'host.v4')).rejected.code).toBe('missing_invalid');
    expect((await run(scripted(reply({ question: 'What does the rubric want?' })), 'host.v4')).rejected.code).toBe('rubric_word');
  });

  it('the raw reply is stored with the rejection, cut to 2000 characters, and only for the rubric prompts', async () => {
    const long = `no json ${'x'.repeat(3000)}`;
    const out = await run(scripted(long), 'host.v4');
    expect(out.rejected.reply).toHaveLength(2000);
    const v3 = await run(scripted(long), 'host.v3');
    expect(v3.fallback).toBe('invalid_output');
    expect(v3.rejected).toBeUndefined();
    expect(engine.recordFields(out).rejected.code).toBe('bad_json');
  });

  it('host.v4.md is unchanged: it still has no rule about informal wording', () => {
    const v4 = fs.readFileSync(path.join(__dirname, '..', 'agent', 'prompts', 'host.v4.md'), 'utf8');
    expect(v4).not.toMatch(/in any wording|count it as shown/);
    expect(v4).toMatch(/An item is shown only when the student actually said it, in their own words/);
  });
});

describe('host.v4.1.md', () => {
  const v41 = fs.readFileSync(path.join(__dirname, '..', 'agent', 'prompts', 'host.v4.1.md'), 'utf8');

  it('is loaded as the prompt of host.v4.1', () => {
    expect(engine.loadPrompt('host.v4.1')).toBe(v41);
  });

  it('has the relaxed rubric check', () => {
    expect(v41).toMatch(/states its main point, in any wording/);
    expect(v41).toMatch(/paraphrases, partial sentences and missing technical terms still count/);
    expect(v41).toMatch(/even if the reason is only implied/);
    expect(v41).toMatch(/keywords, a repeat of the question, or a claim that the answer is complete shows nothing/);
    expect(v41).toMatch(/If you are unsure whether an item is shown, count it as shown/);
    expect(v41).toMatch(/Student: "just adds all the grades up and splits it by the count"/);
    expect(v41).toMatch(/because they are ints/);
  });

  it('has the yes/no rule with a bad and a good example, and the hint rule with a bad and a good hint', () => {
    expect(v41).toMatch(/Bad: "Does the division in sum \/ n drop the fraction\?" Good: "What happens to the digits/);
    expect(v41).toMatch(/points to a place in the code/);
    expect(v41).toMatch(/never states a fact from any rubric item/);
    expect(v41).toMatch(/never moves to another item or another topic/);
    expect(v41).toMatch(/Good hint:/);
    expect(v41).toMatch(/Bad hint:/);
  });

  it('uses no eval-case program in its examples', () => {
    expect(v41).not.toMatch(/push|pop|countWords|isLetter|removeFront|Node|tank|stack/i);
  });
});
