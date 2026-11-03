// The bake-off scripts: the evidence check, the reference answer sets, the numbers and the writer guards. No Bedrock calls.
const fs = require('fs');
const os = require('os');
const path = require('path');
const common = require('../../../scripts/eval/bakeoff-common');
const check = require('../../../scripts/eval/bakeoff-check');
const write = require('../../../scripts/eval/bakeoff-write');
const { loadCase } = require('../../../scripts/eval/cases');

const rubric = [{ id: 'r1', text: 'Says the result is 81.' }, { id: 'r2', text: 'Says the loop adds the grades and the sum is divided by the count.' }];
const answer = 'It adds them  up and divides by 3, so I think 81.';
const reply = (over = {}) => JSON.stringify({
  evidence: { r1: { quote: 'so I think 81', shown: true }, r2: { quote: 'adds them up and divides by 3', shown: true } }, missing: [], ...over,
});

describe('the evidence check', () => {
  it('accepts a reply whose quotes are in the answer (ignoring case and spacing) and whose missing list matches', () => {
    const v = common.validateCheck(reply(), rubric, answer);
    expect(v).toMatchObject({ ok: true, missing: [] });
    const some = common.validateCheck(reply({
      evidence: { r1: { quote: 'SO I THINK 81', shown: true }, r2: { quote: '', shown: false } }, missing: ['r2'],
    }), rubric, answer);
    expect(some).toMatchObject({ ok: true, missing: ['r2'] });
  });

  it('ignores typographic quotes and dashes when it looks for a quote (a model copies a curly apostrophe as a straight one)', () => {
    const curly = 'It stays FILLING, that’s the first start – then FULL.';
    const v = common.validateCheck(reply({ evidence: { r1: { quote: "that's the first start - then full", shown: true }, r2: { quote: '', shown: false } }, missing: ['r2'] }), rubric, curly);
    expect(v.ok).toBe(true);
  });

  it('rejects a quote that is not in the answer', () => {
    const v = common.validateCheck(reply({ evidence: { r1: { quote: 'the result is 81 exactly', shown: true }, r2: { quote: '', shown: false } }, missing: ['r2'] }), rubric, answer);
    expect(v).toEqual({ ok: false, error: 'quote for r1 is not in the answer' });
  });

  it('rejects an item marked shown with an empty quote (also when the quote is only spaces)', () => {
    for (const quote of ['', '   ']) {
      const v = common.validateCheck(reply({ evidence: { r1: { quote, shown: true }, r2: { quote: 'adds them up and divides by 3', shown: true } } }), rubric, answer);
      expect(v).toEqual({ ok: false, error: 'r1 is marked shown without a quote' });
    }
    // an item that is not shown may have an empty quote
    expect(common.validateCheck(reply({ evidence: { r1: { quote: 'so I think 81', shown: true }, r2: { quote: '', shown: false } }, missing: ['r2'] }), rubric, answer).ok).toBe(true);
  });

  it('a shown item without a quote is asked for once more, then invalid', async () => {
    const noQuote = reply({ evidence: { r1: { quote: '', shown: true }, r2: { quote: '', shown: true } } });
    const caller = { converse: jest.fn(async () => ({ text: noQuote, inputTokens: 1, outputTokens: 1, latencyMs: 1 })) };
    const out = await check.checkWithPrompt(caller, { question: 'q', rubric, answer });
    expect(out).toMatchObject({ valid: false, retried: true, error: 'r1 is marked shown without a quote' });
    expect(caller.converse).toHaveBeenCalledTimes(2);
  });

  it('rejects a missing list that does not match the evidence, in either direction', () => {
    expect(common.validateCheck(reply({ missing: ['r1'] }), rubric, answer)).toEqual({ ok: false, error: 'missing does not match the evidence' });
    const unshown = { evidence: { r1: { quote: '', shown: false }, r2: { quote: '', shown: false } } };
    expect(common.validateCheck(reply({ ...unshown, missing: ['r1'] }), rubric, answer).ok).toBe(false);
    expect(common.validateCheck(reply({ ...unshown, missing: ['r2', 'r1'] }), rubric, answer)).toMatchObject({ ok: true, missing: ['r1', 'r2'] }); // the order of the list does not matter; the result is in rubric order
    expect(common.validateCheck(reply({ ...unshown, missing: ['r1', 'r1'] }), rubric, answer).ok).toBe(false);
    expect(common.validateCheck(reply({ ...unshown, missing: ['r1', 'r2'] }), rubric, answer)).toMatchObject({ ok: true, missing: ['r1', 'r2'] });
  });

  it('rejects structural problems: no JSON, no evidence, an item without evidence, wrong types, unknown ids', () => {
    expect(common.validateCheck('nothing', rubric, answer).ok).toBe(false);
    expect(common.validateCheck('{"missing": []}', rubric, answer).ok).toBe(false);
    expect(common.validateCheck(JSON.stringify({ evidence: { r1: { quote: '', shown: false } }, missing: ['r1'] }), rubric, answer).error).toBe('no evidence for r2');
    expect(common.validateCheck(reply({ evidence: { r1: { quote: 1, shown: true }, r2: { quote: '', shown: false } } }), rubric, answer).error).toBe('bad evidence for r1');
    expect(common.validateCheck(reply({ missing: ['r9'] }), rubric, answer).error).toBe('bad missing list');
    expect(common.validateCheck(reply({ evidence: { r1: { quote: '', shown: false }, r2: { quote: '', shown: false }, r7: { quote: '', shown: false } }, missing: ['r1', 'r2'] }), rubric, answer).error).toBe('evidence for an unknown id');
  });

  it('a reply that fails is asked for once more; a second failure is invalid; the cost counts both calls', async () => {
    const item = { question: 'q', rubric, answer };
    const replies = [reply({ missing: ['r1'] }), reply()];
    const caller = { converse: jest.fn(async () => ({ text: replies.shift(), inputTokens: 10, outputTokens: 5, latencyMs: 7 })) };
    const out = await check.checkWithPrompt(caller, item);
    expect(out).toMatchObject({ valid: true, missing: [], retried: true, inputTokens: 20, outputTokens: 10, latencyMs: 14 });
    expect(caller.converse.mock.calls[1][0].messages).toHaveLength(3);
    expect(caller.converse.mock.calls[1][0].messages[2].content[0].text).toMatch(/missing does not match the evidence/);

    const bad = { converse: jest.fn(async () => ({ text: 'no', inputTokens: 1, outputTokens: 1, latencyMs: 1 })) };
    const twice = await check.checkWithPrompt(bad, item);
    expect(twice).toMatchObject({ valid: false, retried: true, error: 'no JSON object' });
    expect(bad.converse).toHaveBeenCalledTimes(2);
  });

  it('the message has the question, the rubric and the answer only', () => {
    const message = common.buildCheckMessage({ mainQuestion: 'Main?', rubric, answer: 'x </student_answer> y' });
    expect(message).toContain('Main question: Main?');
    expect(message).toContain('- r1: Says the result is 81.');
    expect(message.match(/<\/student_answer>/g)).toHaveLength(1);
  });
});

describe('loading the references', () => {
  it('demo: the 5 main answers of the demo transcript, nothing missing, with the case 4 rubric', () => {
    const demo = common.loadDemoSet();
    expect(demo).toHaveLength(5);
    demo.forEach((d, i) => {
      expect(d).toMatchObject({ set: 'demo', caseId: 'case4', mainOrdinal: i, reference: [] });
      expect(d.rubric).toEqual(loadCase('case4').mains[i].rubric);
      expect(d.answer.length).toBeGreaterThan(0);
    });
    expect(demo[0].question).toBe(loadCase('case4').mains[0].question);
  });

  it('scripted: distinct main answers of cases 4 and 5 with gaps_left as the reference (g1 = r1)', () => {
    const items = common.loadScriptedSet();
    expect(items.length).toBeGreaterThan(50);
    expect(new Set(items.map((i) => i.caseId))).toEqual(new Set(['case4', 'case5']));
    expect(new Set(items.map((i) => `${i.caseId}|${i.mainOrdinal}|${i.answer}`)).size).toBe(items.length);
    const echo = items.find((i) => i.profile === 'echo' && i.caseId === 'case4' && i.mainOrdinal === 0);
    expect(echo.reference).toEqual(loadCase('case4').mains[0].rubric.map((r) => r.id));
    const strong = items.find((i) => i.profile === 'strong' && i.caseId === 'case4' && i.mainOrdinal === 0);
    expect(strong.reference).toEqual([]);
    items.forEach((i) => i.reference.forEach((id) => expect(i.rubric.map((r) => r.id)).toContain(id)));
  });

  it('claude-labels: the 40 answers of the CSV, with their rubric and the labels in human_missing', () => {
    const items = common.loadClaudeLabelsSet();
    expect(items).toHaveLength(40);
    expect(items[0]).toMatchObject({ set: 'claude-labels', id: 'R01', caseId: 'case5', reference: ['r1', 'r2', 'r3'] });
    expect(items[0].rubric.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(items.filter((i) => i.reference.length === 0).length).toBeGreaterThan(0); // "none"
    expect(items.every((i) => i.mainOrdinal >= 0)).toBe(true);
  });

  it('claude-labels: an empty or unknown label is an error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bake-'));
    const file = path.join(dir, 'h.csv');
    const row = (label) => `id,case,main_question,rubric_items,student_answer,human_missing\nR1,case2,"Trace the while loop in main. In what order are the values printed, and why?","r1: a | r2: b",ans,${label}\n`;
    fs.writeFileSync(file, row(''));
    expect(() => common.loadClaudeLabelsSet(file)).toThrow(/empty/);
    fs.writeFileSync(file, row('r9'));
    expect(() => common.loadClaudeLabelsSet(file)).toThrow(/unknown item/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the answer set is each item once plus 3 repeats of the 5 demo answers', () => {
    const items = check.buildItems();
    expect(items.filter((i) => i.repeat)).toHaveLength(15);
    expect(items.filter((i) => !i.repeat && i.set === 'demo')).toHaveLength(5);
    expect(items.filter((i) => i.set === 'claude-labels')).toHaveLength(40);
  });
});

describe('the numbers', () => {
  it('compareMissing: exact, false missing and missed', () => {
    expect(common.compareMissing(['r1'], ['r1'])).toEqual({ exact: true, falseMissing: [], missed: [] });
    expect(common.compareMissing(['r1', 'r2'], ['r1'])).toEqual({ exact: false, falseMissing: ['r2'], missed: [] });
    expect(common.compareMissing([], ['r3'])).toEqual({ exact: false, falseMissing: [], missed: ['r3'] });
  });

  it('summarise: per set, invalid replies are not exact; repeats do not count as answers; cost per 100 and median latency', () => {
    const rec = (set, missing, reference, extra = {}) => ({ set, valid: !!missing, missing, reference, rubricSize: 3, cost: 0.01, latencyMs: 100, ...extra });
    const s = common.summarise([
      rec('claude-labels', ['r1'], ['r1']), rec('claude-labels', ['r1', 'r2'], ['r1']), rec('claude-labels', [], ['r3']), rec('claude-labels', null, ['r1'], { latencyMs: 300 }),
      rec('demo', [], []), rec('demo', ['r1'], [], { repeat: 1 }),
    ]);
    expect(s['claude-labels']).toMatchObject({ answers: 4, invalid: 1, exact: 1, falseMissing: 1, missed: 1, costPer100: 1 });
    expect(s['claude-labels'].medianLatencyMs).toBe(100);
    expect(s.demo).toMatchObject({ answers: 1, exact: 1 });
  });

  it('pickBest: the scripted set decides; claude-labels only breaks a tie; then the fewest false missing', () => {
    const v = (sc, cl, fm = 0) => ({ summary: { scripted: { answers: 10, exact: sc, falseMissing: fm }, 'claude-labels': { answers: 10, exact: cl, falseMissing: 0 } } });
    const results = { a: v(6, 10), b: v(8, 2), c: v(8, 5), d: v(8, 5, 1) };
    expect(common.pickBest(results, ['a', 'b'])).toBe('b'); // a is better on claude-labels but worse on scripted
    expect(common.pickBest(results, ['b', 'c'])).toBe('c'); // tie on scripted, claude-labels breaks it
    expect(common.pickBest(results, ['d', 'c'])).toBe('c'); // tie on both, fewer false missing
    expect(common.pickBest(results, ['zzz'])).toBeNull();
  });
});

describe('a checker run with a fake model', () => {
  it('runs a variant over an answer set, counts retries and writes the files', async () => {
    const sets = {
      demo: () => common.loadDemoSet(),
      scripted: () => common.loadScriptedSet().slice(0, 4),
      claudeLabels: () => common.loadClaudeLabelsSet().slice(0, 4),
    };
    // A model that answers every item "not shown" with empty quotes; the first call of the run is malformed.
    let first = true;
    const call = async ({ messages }) => {
      const text = messages[0].content[0].text;
      const ids = [...text.matchAll(/^- (r\d+): /gm)].map((m) => m[1]);
      let out = JSON.stringify({ evidence: Object.fromEntries(ids.map((id) => [id, { quote: '', shown: false }])), missing: ids });
      if (first) { first = false; out = 'oops'; }
      return { text: out, inputTokens: 100, outputTokens: 40, latencyMs: 5 };
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bake-'));
    const logs = [];
    const result = await check.main(['--variants', 'qwen3-coder-30b', '--out', dir, '--concurrency', '1'], { yes: true, sets, call, log: (t) => logs.push(t) });
    const v = result.report.variants['qwen3-coder-30b'];
    expect(v.callable).toBe(true);
    expect(v.records).toHaveLength(5 + 4 + 4 + 15);
    expect(v.records.filter((r) => r.retried)).toHaveLength(1);
    expect(v.summary.demo.answers).toBe(5);
    expect(v.summary.demo.falseMissing).toBeGreaterThan(0); // the fake says everything is missing, the demo reference says nothing is
    expect(fs.existsSync(path.join(dir, 'summary.md'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8')).toMatch(/## The 5 demo answers, one by one/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a model that cannot be called is reported as not callable after three failures', async () => {
    const call = async () => { const e = new Error('no'); e.name = 'AccessDeniedException'; throw e; };
    const items = check.buildItems({ demo: () => common.loadDemoSet(), scripted: () => [], claudeLabels: () => [] });
    const v = await check.runVariant('claude-haiku-5.5', items, { call, concurrency: 1 });
    expect(v.callable).toBe(false);
    expect(v.errors).toEqual({ AccessDeniedException: 3 });
  });

  it('refuses an unknown variant', async () => {
    await expect(check.main(['--variants', 'nope'], { yes: true })).rejects.toThrow(/Unknown variant/);
  });
});

describe('the writer', () => {
  const item = (() => {
    const caseData = loadCase('case4');
    return {
      set: 'scripted', id: 'S1', caseId: 'case4', profile: 'vague', mainOrdinal: 0, question: caseData.mains[0].question, rubric: caseData.mains[0].rubric,
      answer: 'I just go through them in order.', reference: ['r1', 'r2'],
    };
  })();
  const caseData = loadCase('case4');
  const scripted = (...texts) => {
    const calls = [];
    return { calls, converse: async (req) => { calls.push(req); return { text: texts[Math.min(calls.length - 1, texts.length - 1)], inputTokens: 100, outputTokens: 10, latencyMs: 20 }; } };
  };
  const w = (question, over = {}) => JSON.stringify({ target: 'r1', isHint: false, question, ...over });

  it('the items are the scripted answers that leave a gap', () => {
    const items = write.buildItems();
    expect(items.length).toBeGreaterThan(30);
    expect(items.every((i) => i.reference.length > 0 && ['case4', 'case5'].includes(i.caseId))).toBe(true);
  });

  it('the message has the code, question, rubric, answer and the missing list', () => {
    const m = write.buildWriteMessage({ code: caseData.code, question: 'Q?', rubric: item.rubric, answer: 'A', missing: ['r1', 'r2'] });
    expect(m).toMatch(/<student_code>[\s\S]*TankState[\s\S]*<\/student_code>/);
    expect(m).toContain('Missing items: r1, r2');
    expect(m).toContain('- r1: At 40 the controller stays');
  });

  it('a clean question passes with no guard', async () => {
    const out = await write.writeFollowUp(scripted(w('What state is the tank in after the reading 40?')), item, caseData);
    expect(out).toMatchObject({ valid: true, target: 'r1', question: 'What state is the tank in after the reading 40?' });
    expect(out.guards).toEqual({ json: [0, 0], leak: [0, 0], yesNo: [0, 0], twoQuestions: [0, 0] });
  });

  it('a yes/no question is rewritten once, otherwise the reply is invalid', async () => {
    const fixed = await write.writeFollowUp(scripted(w('Does the pump keep running at 40?'), w('What does the controller do at 40?')), item, caseData);
    expect(fixed).toMatchObject({ valid: true, question: 'What does the controller do at 40?' });
    expect(fixed.guards.yesNo).toEqual([1, 1]);
    const bad = await write.writeFollowUp(scripted(w('Does the pump keep running at 40?')), item, caseData);
    expect(bad).toMatchObject({ valid: false, error: 'yes_no' });
  });

  it('a question that repeats the rubric wording is rewritten once, otherwise invalid', async () => {
    const leaky = w('Explain why At 40 the controller stays FILLING, because a reading between low and high keeps it?');
    const fixed = await write.writeFollowUp(scripted(leaky, w('Walk through the reading 40. What is the state afterwards?')), item, caseData);
    expect(fixed.valid).toBe(true);
    expect(fixed.guards.leak).toEqual([1, 1]);
    const bad = await write.writeFollowUp(scripted(leaky), item, caseData);
    expect(bad).toMatchObject({ valid: false, error: 'rubric_leak' });
  });

  it('a two-question follow-up is rewritten once, otherwise only the first question is kept', async () => {
    const two = w('What happens at 40? What happens at 70?');
    const fixed = await write.writeFollowUp(scripted(two, w('What happens at 40?')), item, caseData);
    expect(fixed).toMatchObject({ valid: true, question: 'What happens at 40?' });
    expect(fixed.guards.twoQuestions).toEqual([1, 1]);
    const kept = await write.writeFollowUp(scripted(two), item, caseData);
    expect(kept).toMatchObject({ valid: true, question: 'What happens at 40?' });
    expect(kept.guards.twoQuestions).toEqual([1, 0]);
  });

  it('a reply that is not JSON is asked for once more', async () => {
    const out = await write.writeFollowUp(scripted('sorry', w('What happens at 40?')), item, caseData);
    expect(out.valid).toBe(true);
    expect(out.guards.json).toEqual([1, 1]);
    expect((await write.writeFollowUp(scripted('sorry'), item, caseData)).error).toBe('bad_json');
  });

  it('the writers are the current Qwen, the best Claude and the best other model that is not Mistral Large 3', () => {
    const v = (rate) => ({ summary: { scripted: { answers: 10, exact: rate, falseMissing: 0 }, 'claude-labels': { answers: 10, exact: 0, falseMissing: 0 } } });
    const results = {
      'qwen3-coder-30b': v(5), 'mistral-large-3': v(20), 'qwen3-vl-235b': v(12), 'deepseek-v3.2': v(15), 'claude-haiku-5.5': v(14), 'claude-sonnet-5.5': v(18),
    };
    expect(write.chooseWriters(results)).toEqual(['qwen3-coder-30b', 'claude-sonnet-5.5', 'deepseek-v3.2']);
  });

  it('refuses Mistral Large 3 as a writer (it is the judge)', async () => {
    await expect(write.main(['--writers', 'qwen3-coder-30b,mistral-large-3'], { yes: true })).rejects.toThrow(/blind judge/);
  });

  it('summarise: judge labels, intended target, guard counts', () => {
    const rec = (over) => ({ valid: true, profile: 'vague', intended: 'g1', isHint: false, guards: { json: [0, 0], leak: [0, 0], yesNo: [1, 1], twoQuestions: [0, 0] }, cost: 0.001, latencyMs: 100, judgement: { targets: ['g1'], reveals: [], twoPart: false, beyondScope: false }, ...over });
    const s = write.summarise([
      rec(), rec({ judgement: { targets: ['g2'], reveals: ['g1'], twoPart: true, beyondScope: true } }), rec({ profile: 'idk', isHint: true }),
      { valid: false, error: 'yes_no', guards: { json: [0, 0], leak: [0, 0], yesNo: [1, 0], twoQuestions: [0, 0] }, cost: 0.001, latencyMs: 50 },
    ]);
    expect(s).toMatchObject({ items: 4, valid: 3, invalid: 1, judged: 3, targetsIntended: 2, reveals: 1, twoPart: 1, beyondScope: 1, hintOnIdk: { hints: 1, of: 1 } });
    expect(s.guards.yesNo).toEqual([4, 3]);
    expect(s.invalidBy).toEqual({ yes_no: 1 });
  });
});
