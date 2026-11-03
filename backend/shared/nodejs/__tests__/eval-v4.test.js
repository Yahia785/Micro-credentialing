// host.v4 in the evaluation: rubric in the case files, temperature arms, rubric check by the Host and by a separate judge,
// the sample files for hand labelling, compare-rubric.js and the good-enough bar. The service runs against the in-memory stores.
jest.mock('../db/interviews', () => require('../../../scripts/eval/fake-stores').interviews);
jest.mock('../db/submissions', () => require('../../../scripts/eval/fake-stores').submissions);
jest.mock('../db/milestones', () => require('../../../scripts/eval/fake-stores').milestones);
jest.mock('../utils/logger', () => require('../../../scripts/eval/fake-stores').logger);

const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('../agent/interview-engine');
const bedrock = require('../agent/bedrock-client');
const { runEval, normalizeOptions, planOf } = require('../../../scripts/eval/run-eval');
const { loadCase, caseIds } = require('../../../scripts/eval/cases');
const metrics = require('../../../scripts/eval/metrics');
const adaptive = require('../../../scripts/eval/adaptive');
const rubric = require('../../../scripts/eval/rubric');
const judging = require('../../../scripts/eval/judge');
const rubricJudging = require('../../../scripts/eval/judge-rubric');
const { createFakeJudge } = require('../../../scripts/eval/fake-judge');
const { createFakeModel } = require('../../../scripts/eval/fake-model');
const { evaluateBars, BARS } = require('../../../scripts/eval/bars');
const { toMarkdown } = require('../../../scripts/eval/report');
const { parseCsvObjects, parseCsv, toCsvText } = require('../../../scripts/eval/csv');
const compareRubric = require('../../../scripts/eval/compare-rubric');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-v4-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); jest.restoreAllMocks(); });

const base = (over = {}) => ({
  fakeModel: true, yes: true, log: () => {}, delayMs: 0, retryDelayMs: 0,
  prompts: 'host.v4', cases: 'case2', profiles: 'strong,vague', repeats: 1,
  out: path.join(tmp, 'out'), fakeChaos: 0, noPairs: true, ...over,
});
const readDir = (dir) => fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));

// ---------------------------------------------------------------------------------------------
// Hand-built transcripts
// ---------------------------------------------------------------------------------------------

/** One main answer, the Host's decision after it and, after a follow-up, the answer to it and the engine's move to the next main question. */
function round({
  ordinal = 0, label = 'vague', gaps = ['g1'], gapCount = 3, ownCode, source = 'vague', text = 'an answer', action = 'follow_up',
  question = 'What happens after the loop?', missing, target, isHint, guard, rubricCheck, followUpRubricCheck,
}) {
  const scripted = (answerType) => ({ profile: source, source, label, gaps, gapCount, answerType, mainOrdinal: ordinal, ...(ownCode && { ownCode: true }) });
  const turns = [
    { role: 'student', kind: 'main', text, scripted: scripted('main'), ...(rubricCheck && { rubricCheck }) },
    {
      role: 'host', kind: action === 'follow_up' ? 'follow_up' : 'main', text: action === 'follow_up' ? question : 'Next main?', reason: 'because',
      ...(missing && { missing }), ...(target !== undefined && { target }), ...(isHint !== undefined && { isHint }), ...(guard && { guard }),
    },
  ];
  if (action === 'follow_up') {
    turns.push(
      { role: 'student', kind: 'follow_up', text: `${text} more`, scripted: scripted('followUp'), ...(followUpRubricCheck && { rubricCheck: followUpRubricCheck }) },
      { role: 'host', kind: 'main', text: 'Next main?', reason: 'engine: no follow-up left for this main question; asked the next main question', engineDecision: true },
    );
  }
  return turns;
}
const transcript = (rounds, over = {}) => ({
  promptVersion: 'host.v4', arm: 'host.v4', caseId: 'case4', profile: 'vague', status: 'completed', budget: 1, calls: [],
  turns: [{ role: 'host', kind: 'main', text: 'Main?' }, ...rounds.flat()], ...over,
});
const judged = (missing, reason = 'reason') => ({ valid: true, missing, reason });

// ---------------------------------------------------------------------------------------------

describe('rubric in the case files', () => {
  it.each(caseIds())('%s: every main question has a rubric with ids r1, r2, ... and one item per gap; the gap lists are unchanged', (id) => {
    const c = loadCase(id);
    c.mains.forEach((main, i) => {
      const gaps = c.studentsRaw.gaps[i];
      expect(main.rubric.map((r) => r.id)).toEqual(gaps.map((_g, k) => `r${k + 1}`));
      main.rubric.forEach((item) => expect(item.text.trim()).not.toBe(''));
    });
  });

  it('cases 4 and 5 use the gap texts as they are', () => {
    for (const id of ['case4', 'case5']) {
      const c = loadCase(id);
      c.mains.forEach((main, i) => expect(main.rubric.map((r) => r.text)).toEqual(c.studentsRaw.gaps[i].map((g) => g.text)));
    }
  });

  it('cases 1 to 3 say what the answer does, not what it does not: "Does not say X" became "Says X"', () => {
    for (const id of ['case1', 'case2', 'case3']) {
      const c = loadCase(id);
      c.mains.forEach((main, i) => {
        c.studentsRaw.gaps[i].forEach((gap, k) => {
          const item = main.rubric[k].text;
          expect(gap.text).toMatch(/^Does not /); // the judge still gets the gap lists as they were
          expect(item).not.toMatch(/^Does not/);
          expect(item.replace(/^\w+ /, '')).toBe(gap.text.replace(/^Does not \w+ /, ''));
        });
      });
    }
    expect(loadCase('case2').mains[0].rubric[1].text).toBe('Says that push returns false when the stack is full, which is what the caller sees.');
  });

  it('the rubric travels with the config snapshot, so host.v4 gets it; v1 to v3 do not read it', () => {
    const c = loadCase('case4');
    expect(c.config.themes[0].rubric[0]).toHaveLength(3);
    const state = engine.initialState();
    const turns = [{ role: 'host', text: 'q' }, { role: 'student', text: 'a' }];
    const plain = engine.buildUserMessage({ config: c.config, state, code: 'x', turns });
    expect(plain).not.toContain(c.mains[0].rubric[0].text.slice(0, 30) + '\n');
    expect(plain).not.toMatch(/Rubric/);
    const withRubric = engine.buildUserMessage({ config: c.config, state, code: 'x', turns, rubric: engine.rubricFor(c.config, state) });
    expect(withRubric).toContain('- r1: At 40 the controller stays');
  });
});

describe('temperature arms', () => {
  it('--prompts name@temperature, --temperatures for the rest, a plain prompt runs at the default 0.2 under its own name', () => {
    const arms = (raw) => normalizeOptions(base(raw)).armSpecs.map((s) => [s.arm, s.promptVersion, s.temperature]);
    expect(arms({ prompts: 'host.v4@0,host.v4@0.2,host.v3@0.2' })).toEqual([
      ['host.v4@0', 'host.v4', 0], ['host.v4@0.2', 'host.v4', 0.2], ['host.v3@0.2', 'host.v3', 0.2],
    ]);
    expect(arms({ prompts: 'host.v4,host.v3@0.2', temperatures: '0,0.2' })).toEqual([
      ['host.v4@0', 'host.v4', 0], ['host.v4@0.2', 'host.v4', 0.2], ['host.v3@0.2', 'host.v3', 0.2],
    ]);
    expect(arms({ prompts: 'host.v3' })).toEqual([['host.v3', 'host.v3', 0.2]]);
    expect(normalizeOptions(base({ prompts: 'host.v4@0,host.v3', baseline: 'fixed' })).arms).toEqual(['host.v4@0', 'host.v3', 'fixed']);
    expect(() => normalizeOptions(base({ prompts: 'host.v4@2' }))).toThrow(/Bad temperature/);
    expect(() => normalizeOptions(base({ prompts: 'host.v4', temperatures: 'warm' }))).toThrow(/Bad temperature/);
    expect(() => normalizeOptions(base({ prompts: 'host.v4@0,host.v4@0' }))).toThrow(/listed twice/);
    expect(() => normalizeOptions(base({ prompts: 'host.v9@0' }))).toThrow(/Unknown prompt version.*host\.v4/);
  });

  it('each prompt and temperature pair is its own arm; the temperature is stored on each interview and sent with every call', async () => {
    const seen = [];
    jest.spyOn(bedrock, 'converse').mockImplementation(async (req) => {
      seen.push({ system: req.system, temperature: req.temperature });
      return {
        text: JSON.stringify({ missing: [], action: 'next_main', target: '', isHint: false, question: '', reason: 'ok' }),
        inputTokens: 10, outputTokens: 5, latencyMs: 1,
      };
    });
    const { outDir, report } = await runEval(base({
      fakeModel: false, prompts: 'host.v4@0,host.v4@0.2,host.v3', profiles: 'strong', baseline: 'fixed',
    }));
    const transcripts = readDir(path.join(outDir, 'transcripts'));
    expect(transcripts.map((t) => [t.arm, t.promptVersion, t.temperature]).sort()).toEqual([
      ['fixed', 'fixed', null], ['host.v3', 'host.v3', 0.2], ['host.v4@0', 'host.v4', 0], ['host.v4@0.2', 'host.v4', 0.2],
    ]);
    expect(Object.keys(report.results).sort()).toEqual(['fixed', 'host.v3', 'host.v4@0', 'host.v4@0.2']);
    const v4 = engine.loadPrompt('host.v4');
    expect(new Set(seen.filter((c) => c.system === v4).map((c) => c.temperature))).toEqual(new Set([0, 0.2]));
    expect(new Set(seen.filter((c) => c.system !== v4).map((c) => c.temperature))).toEqual(new Set([0.2]));
    transcripts.filter((t) => t.arm.startsWith('host.v4')).forEach((t) => expect(t.promptVersionStored).toBe('host.v4'));
  });

  it('the arms of one prompt version are not mixed in the repeat agreement', () => {
    const mk = (arm, repeat, action) => transcript([round({ action, missing: ['r1'], target: 'r1' })], { arm, repeat });
    const t = [mk('host.v4@0', 1, 'follow_up'), mk('host.v4@0', 2, 'follow_up'), mk('host.v4@0.2', 1, 'next_main'), mk('host.v4@0.2', 2, 'next_main')];
    const results = metrics.summarizeRun(t);
    adaptive.attachAdaptive(results, t, []);
    expect(Object.keys(results)).toEqual(['host.v4@0', 'host.v4@0.2']);
    expect(results['host.v4@0'].overall.adaptive.actionAgreement).toMatchObject({ num: 1, den: 1 });
    expect(results['host.v4@0.2'].overall.adaptive.actionAgreement).toMatchObject({ num: 1, den: 1 });
  });
});

describe('host.v4.1 arms', () => {
  it('host.v4 and host.v4.1 run at temperature 0 when no @ is given; the other versions keep 0.2; @ still wins', () => {
    const arms = (raw) => normalizeOptions(base(raw)).armSpecs.map((s) => [s.arm, s.promptVersion, s.temperature]);
    expect(arms({ prompts: 'host.v4.1,host.v4,host.v3' })).toEqual([['host.v4.1', 'host.v4.1', 0], ['host.v4', 'host.v4', 0], ['host.v3', 'host.v3', 0.2]]);
    expect(arms({ prompts: 'host.v4.1@0,host.v4@0' })).toEqual([['host.v4.1@0', 'host.v4.1', 0], ['host.v4@0', 'host.v4', 0]]);
    expect(arms({ prompts: 'host.v4.1@0.2' })).toEqual([['host.v4.1@0.2', 'host.v4.1', 0.2]]);
  });

  it('the fake run compares host.v4.1@0 with host.v4@0; the report lists invalid replies and repairs', async () => {
    const { outDir, report } = await runEval(base({ prompts: 'host.v4.1@0,host.v4@0', baseline: 'fixed', profiles: 'strong,vague,idk', out: path.join(tmp, 'v41') }));
    expect(Object.keys(report.results).sort()).toEqual(['fixed', 'host.v4.1@0', 'host.v4@0']);
    const md = fs.readFileSync(path.join(outDir, 'summary.md'), 'utf8');
    expect(md).toMatch(/## Invalid replies and repairs/);
    expect(report.results['host.v4.1@0'].overall.repairs).toBeDefined();
    expect(Object.keys(report.results['host.v4@0'].overall.rejected)).toContain('rubric_leak');
  });
});

describe('model calls the engine saves', () => {
  it('a budget-1 interview has exactly one model call per main question; the other decisions are engine decisions', async () => {
    const { outDir, report } = await runEval(base({ prompts: 'host.v3', profiles: 'idk' }));
    const [t] = readDir(path.join(outDir, 'transcripts'));
    const c = loadCase('case2');
    // one call per main question, plus the rewrite the two-question guard asked for
    expect(t.calls).toHaveLength(c.mains.length + t.turns.filter((x) => x.guard).length);
    const engineTurns = t.turns.filter((x) => x.engineDecision);
    expect(engineTurns.length).toBeGreaterThan(0);
    engineTurns.forEach((x) => expect(x.reason).toMatch(/^engine: /));
    // the decision to end the interview is an engine decision too; it sits in endDetail, not on a turn
    expect(report.results['host.v3'].overall.engineDecisions).toBe(engineTurns.length + (t.endDetail && t.endDetail.engineDecision ? 1 : 0));
    expect(t.endDetail).toMatchObject({ engineDecision: true, reason: 'engine: no follow-up left and no main question remains; ended' });
    // engine decisions are not model decisions, so they do not count as overrides or reason checks
    expect(report.results['host.v3'].overall.overrides.total.num).toBe(0);
  });

  it('the plan counts the calls that are left', () => {
    const o = normalizeOptions(base({ prompts: 'host.v3', cases: 'case2,case4', profiles: 'strong,vague' }));
    const loaded = { case2: loadCase('case2'), case4: loadCase('case4') };
    const plan = planOf(o, loaded);
    expect(plan.minCalls).toBe(plan.maxCalls); // budget 1: one call per main question
    expect(plan.minCalls).toBe(2 * (5 + 5));
  });
});

describe('unnecessary follow-up leaves out ownCode answers', () => {
  it('a follow-up after an ownCode answer is counted on its own, not as unnecessary', () => {
    const t = transcript([
      round({ ordinal: 0, label: 'good', gaps: ['g1', 'g2'], ownCode: true, source: 'strong', action: 'follow_up', missing: ['r1', 'r2'], target: 'r1' }),
      round({ ordinal: 1, label: 'good', gaps: [], source: 'strong', action: 'follow_up', missing: ['r1'], target: 'r1' }),
      round({ ordinal: 2, label: 'good', gaps: [], source: 'strong', action: 'next_main', missing: [] }),
    ]);
    const s = metrics.summarizeTranscripts([t]);
    expect(s.unnecessaryFollowUp).toMatchObject({ num: 1, den: 2 });
    expect(s.ownCodeFollowUp).toMatchObject({ num: 1, den: 1 });
  });

  it('an ownCode answer that gets no follow-up is not an unnecessary opportunity either', () => {
    const t = transcript([
      round({ label: 'good', gaps: ['g1'], ownCode: true, source: 'strong', action: 'next_main', missing: [] }),
      round({ ordinal: 1, label: 'good', gaps: [], source: 'strong', action: 'next_main', missing: [] }),
    ]);
    const s = metrics.summarizeTranscripts([t]);
    expect(s.unnecessaryFollowUp).toMatchObject({ num: 0, den: 1 });
    expect(s.ownCodeFollowUp).toMatchObject({ num: 0, den: 1 });
  });

  it('in a real fake run only case 5 Q1 strong is an ownCode answer', async () => {
    const { report } = await runEval(base({ prompts: 'host.v3', cases: 'case4,case5', profiles: 'strong' }));
    const byCase = report.results['host.v3'].byCase;
    expect(byCase.case4.ownCodeFollowUp.den).toBe(0);
    expect(byCase.case5.ownCodeFollowUp.den).toBe(1);
    expect(byCase.case5.unnecessaryFollowUp.den).toBe(4);
  });
});

describe('the two-question guard in the report', () => {
  const asked = (original, question, fixedByRetry) => ({ fired: true, original, fixedByRetry });
  it('counts how often it fired and how often the rewrite fixed it, with the multi-part rate as if it were off', () => {
    const t = transcript([
      round({ action: 'follow_up', question: 'Why a loop?', missing: ['r1'], target: 'r1', guard: asked('Why a loop? And why a sum?', 'Why a loop?', true) }),
      round({ ordinal: 1, action: 'follow_up', question: 'Why a sum?', missing: ['r1'], target: 'r1', guard: asked('Why a sum? How is it used?', 'Why a sum?', false) }),
      round({ ordinal: 2, action: 'follow_up', question: 'What is n?', missing: ['r1'], target: 'r1' }),
      round({ ordinal: 3, action: 'next_main', missing: [] }),
    ], { promptVersion: 'host.v3', arm: 'host.v3' });
    const s = metrics.summarizeTranscripts([t]);
    expect(s.guard.fired).toMatchObject({ num: 2, den: 3 });
    expect(s.guard.fixedByRetry).toMatchObject({ num: 1, den: 2 });
    expect(s.guard.keptFirst).toMatchObject({ num: 1, den: 2 });
    expect(s.guard.multiPartIfOff).toMatchObject({ num: 2, den: 3 }); // what the v1 to v3 baseline would have shown without the guard
    expect(s.guard.multiPartAfter).toMatchObject({ num: 0, den: 3 });
  });

  it('the judge two-part rate can be given as if the guard were off (the original follow-up was judged too)', () => {
    const j = (twoPart) => ({ valid: true, targets: ['g1'], reveals: [], twoPart, beyondScope: false, reason: '' });
    const t = transcript([
      round({ action: 'follow_up', missing: ['r1'], target: 'r1', guard: { fired: true, original: 'a? b?', fixedByRetry: true, originalJudgement: { valid: true, twoPart: true } } }),
      round({ ordinal: 1, action: 'follow_up', missing: ['r1'], target: 'r1' }),
    ]);
    t.turns.filter((x) => x.role === 'host' && x.kind === 'follow_up').forEach((x) => { x.judgement = j(false); });
    const checks = adaptive.followUpChecks([t]);
    expect(checks.twoPart).toMatchObject({ num: 0, den: 2 });
    expect(checks.twoPartGuardOff).toMatchObject({ num: 1, den: 2 });
  });

  it('fires in a fake run for every prompt version and the report lists it per arm', async () => {
    const { outDir, report } = await runEval(base({ prompts: 'host.v1,host.v3,host.v4', profiles: 'idk,wrong,short' }));
    for (const arm of ['host.v1', 'host.v3', 'host.v4']) {
      const g = report.results[arm].overall.guard;
      expect(g.fired.num).toBeGreaterThan(0);
      expect(g.fixedByRetry.num).toBeLessThanOrEqual(g.fired.num);
      expect(g.multiPartIfOff.num).toBeGreaterThanOrEqual(g.fired.num);
      expect(g.multiPartAfter.num).toBeLessThanOrEqual(g.multiPartIfOff.num);
    }
    const md = fs.readFileSync(path.join(outDir, 'summary.md'), 'utf8');
    expect(md).toContain('## Two-question guard and skipped model calls');
    const section = md.slice(md.indexOf('## Two-question guard'), md.indexOf('## Rubric check') === -1 ? md.indexOf('## Comparison: case2') : md.indexOf('## Rubric check'));
    ['host.v1', 'host.v3', 'host.v4'].forEach((arm) => expect(section).toMatch(new RegExp(`\\| ${arm.replace('.', '\\.')} \\| \\d+ \\| \\d+% \\(\\d+/\\d+\\) \\|`)));
    const guarded = readDir(path.join(outDir, 'transcripts')).flatMap((t) => t.turns).filter((x) => x.guard);
    guarded.forEach((x) => { expect(x.guard.fired).toBe(true); expect(typeof x.guard.original).toBe('string'); });
  });
});

describe('host.v4 in the fake run', () => {
  it('stores missing, target and isHint on the Host turns; the fake model returns the new fields', async () => {
    const { outDir } = await runEval(base({ profiles: 'strong,idk' }));
    const hostTurns = readDir(path.join(outDir, 'transcripts')).flatMap((t) => t.turns).filter((x) => x.role === 'host' && x.kind && !x.engineDecision && x.reason && x.mainOrdinal !== undefined);
    const withFields = hostTurns.filter((x) => Array.isArray(x.missing));
    expect(withFields.length).toBeGreaterThan(0);
    withFields.filter((x) => x.kind === 'follow_up').forEach((x) => {
      expect(x.missing).toContain(x.target);
      expect(x.target).toMatch(/^r[123]$/);
      expect(typeof x.isHint).toBe('boolean');
    });
    expect(withFields.some((x) => x.kind === 'follow_up' && x.isHint === true)).toBe(true); // idk answers get a hint
    // the same fields never appear for host.v3
    const v3 = await runEval(base({ prompts: 'host.v3', profiles: 'idk', out: path.join(tmp, 'v3') }));
    readDir(path.join(v3.outDir, 'transcripts')).flatMap((t) => t.turns).forEach((x) => {
      expect(x.missing).toBeUndefined();
      expect(x.isHint).toBeUndefined();
    });
  });

  it('the fake model: missing from word overlap, target is the first missing item, a rewrite asks one question', async () => {
    const model = createFakeModel({ seed: 1, chaos: 0 });
    const state = engine.initialState();
    const c = loadCase('case2');
    const message = (answer) => engine.buildUserMessage({
      config: c.config, state, code: 'x', turns: [{ role: 'host', text: 'q' }, { role: 'student', text: answer }], rubric: engine.rubricFor(c.config, state),
    });
    const ask = async (answer) => JSON.parse((await model({ messages: [{ content: [{ text: message(answer) }] }] })).text);
    const none = await ask("I don't know");
    expect(none).toMatchObject({ action: 'follow_up', target: 'r1', missing: ['r1', 'r2'], isHint: true });
    const full = await ask('The check prevents writing past the end of the data array, out of bounds. Push returns false when the stack is full, which is what the caller sees.');
    expect(full).toMatchObject({ action: 'next_main', missing: [] });
  });
});

describe('the rubric-check judge', () => {
  const input = {
    mainQuestion: 'Main?', rubric: [{ id: 'r1', text: 'Says the loop adds.' }, { id: 'r2', text: 'Says it divides.' }], answer: 'SECRET STUDENT ANSWER',
  };

  it('sees the question, the rubric and the answer, and nothing else', async () => {
    const seen = [];
    const judge = rubricJudging.createRubricJudge({
      modelId: 'm',
      converseFn: async (req) => { seen.push(req); return { text: '{"missing":["r2"],"reason":"no division"}', inputTokens: 1, outputTokens: 1, latencyMs: 1 }; },
    });
    const out = await judge.judge({ ...input, followUp: 'SECRET FOLLOW UP', code: 'SECRET CODE', hostMissing: ['r1'] });
    expect(out).toMatchObject({ valid: true, missing: ['r2'], reason: 'no division', cached: false });
    const message = seen[0].messages[0].content[0].text;
    expect(message).toContain('Question: Main?');
    expect(message).toContain('- r1: Says the loop adds.');
    expect(message).toContain('<student_answer>\nSECRET STUDENT ANSWER\n</student_answer>');
    expect(message).not.toMatch(/SECRET FOLLOW UP|SECRET CODE|follow_up/);
    expect(seen[0].temperature).toBe(0);
    expect(seen[0].system).toMatch(/rubric/i);
  });

  it('reuses identical inputs and asks again once for an unreadable reply', async () => {
    let calls = 0;
    const judge = rubricJudging.createRubricJudge({
      modelId: 'm',
      converseFn: async () => { calls += 1; return { text: calls === 1 ? 'hmm' : '{"missing":[],"reason":"all there"}', inputTokens: 1, outputTokens: 1, latencyMs: 1 }; },
    });
    expect((await judge.judge(input)).missing).toEqual([]);
    expect((await judge.judge(input)).cached).toBe(true);
    expect(calls).toBe(2);
    expect(judge.usage).toMatchObject({ calls: 2, cached: 1, invalid: 1 });
  });

  it('parses only known ids', () => {
    const ids = ['r1', 'r2'];
    expect(rubricJudging.parseRubricJudgement('{"missing":["R2","r1"],"reason":"x"}', ids)).toMatchObject({ ok: true, missing: ['r1', 'r2'] });
    expect(rubricJudging.parseRubricJudgement('{"missing":["none"],"reason":"x"}', ids)).toMatchObject({ ok: true, missing: [] });
    expect(rubricJudging.parseRubricJudgement('{"missing":["r5"],"reason":"x"}', ids).ok).toBe(false);
    expect(rubricJudging.parseRubricJudgement('{"reason":"x"}', ids).ok).toBe(false);
  });

  it('the targeting judge still never sees the answer', async () => {
    const seen = [];
    const judge = judging.createJudge({
      modelId: 'm',
      converseFn: async (req) => { seen.push(req.messages[0].content[0].text); return { text: '{"targets":["g1"],"reveals":[],"two_part":false,"beyond_scope":false,"reason":"x"}', inputTokens: 1, outputTokens: 1, latencyMs: 1 }; },
    });
    await judge.judge({
      mainQuestion: 'Main?', criteria: ['c'], gaps: [{ id: 'g1', text: 'gap' }], followUp: 'Why?', answer: 'SECRET STUDENT ANSWER', rubric: input.rubric,
    });
    expect(seen[0]).not.toMatch(/SECRET|student_answer|r1|Rubric/);
    expect(seen[0]).toContain('<follow_up>\nWhy?\n</follow_up>');
  });

  it('the fake judge answers both kinds of message', async () => {
    const fake = createFakeJudge({ seed: 1, chaos: 0 });
    const r = await fake({ messages: [{ content: [{ text: rubricJudging.buildRubricJudgeMessage(input) }] }] });
    expect(JSON.parse(r.text)).toEqual({ missing: ['r1', 'r2'], reason: 'The answer does not show r1, r2.' });
    const t = await fake({ messages: [{ content: [{ text: judging.buildJudgeMessage({ mainQuestion: 'Q', criteria: ['c'], gaps: [{ id: 'g1', text: 'the loop adds' }], followUp: 'Why does the loop add?' }) }] }] });
    expect(JSON.parse(t.text)).toHaveProperty('targets');
  });

  it('runs on every main answer and follow-up answer of the host.v4 arms only, and identical inputs are reused', async () => {
    const { outDir, report } = await runEval(base({
      prompts: 'host.v4,host.v3', profiles: 'strong,wrong,idk', judge: true, repeats: 2, baseline: 'fixed',
    }));
    const all = readDir(path.join(outDir, 'transcripts'));
    const v4 = all.filter((t) => t.arm === 'host.v4');
    v4.forEach((t) => t.turns.filter((x) => x.role === 'student').forEach((x) => {
      expect(x.rubricCheck).toMatchObject({ valid: true, judgePrompt: 'judge-rubric.v1' });
      expect(Array.isArray(x.rubricCheck.missing)).toBe(true);
    }));
    all.filter((t) => t.arm !== 'host.v4').forEach((t) => t.turns.forEach((x) => expect(x.rubricCheck).toBeUndefined()));
    const answers = v4.reduce((n, t) => n + t.turns.filter((x) => x.role === 'student').length, 0);
    const rc = report.judge.rubricCheck;
    expect(rc.answers).toBe(answers);
    expect(rc.calls + rc.cached).toBe(answers);
    expect(rc.cached).toBeGreaterThan(0); // 2 repeats of the same scripted answers
    expect(rc.calls).toBeLessThan(answers);
    // the Host's own check was not shared with the judge: its verdict is a separate field
    const turn = v4[0].turns.find((x) => x.role === 'student');
    expect(turn.rubricCheck.missing).not.toBe(v4[0].turns[1].missing);
  });

  it('is in the cost estimate', async () => {
    const lines = [];
    await runEval(base({
      fakeModel: false, yes: false, confirm: async () => false, log: (l) => lines.push(l), judge: true, prompts: 'host.v4@0,host.v4@0.2,host.v3@0.2', baseline: 'fixed',
      cases: 'case2,case3,case4,case5', repeats: 2, profiles: 'all', noPairs: false,
    }));
    const text = lines.join('\n');
    expect(text).toMatch(/rubric check \(judge-rubric\.v1.*\): \d+ answers in 2 host\.v4 arm\(s\), at most \d+ distinct calls .*at most \$\d+\.\d\d/);
    expect(text).toMatch(/temperatures: host\.v4@0 = 0, host\.v4@0\.2 = 0\.2, host\.v3@0\.2 = 0\.2/);
    const plan = planOf(
      normalizeOptions(base({ fakeModel: false, judge: true, prompts: 'host.v4@0,host.v4@0.2,host.v3@0.2', baseline: 'fixed', cases: 'case2,case3,case4,case5', repeats: 2, profiles: 'all', noPairs: false })),
      Object.fromEntries(['case2', 'case3', 'case4', 'case5'].map((id) => [id, loadCase(id)]))
    );
    // 2 host.v4 arms x 9 profiles x 2 repeats x (4 cases x 5 main questions x (1 answer + 1 follow-up answer))
    expect(plan.rubricArms).toBe(2);
    expect(plan.rubricAnswers).toBe(2 * 9 * 2 * 40);
    // identical inputs are reused, so the calls are bounded by the distinct answers: 9 profiles x 40
    expect(plan.rubricCalls).toBe(9 * 40);
  });
});

describe('rubric check numbers', () => {
  // three answers: scripted gaps_left / host missing / judge missing
  //   A: [g1,g3] / [r1,r3] / [r1]      exact for the Host, not for the judge (misses r3)
  //   B: []      / []      / []        both exact
  //   C: [g2]    / [r1]    / [r2]      Host wrong twice (r1 wrongly missing, r2 missed), judge exact
  const t = transcript([
    round({ ordinal: 0, gaps: ['g1', 'g3'], action: 'follow_up', missing: ['r1', 'r3'], target: 'r1', rubricCheck: judged(['r1']), followUpRubricCheck: judged(['r1']) }),
    round({ ordinal: 1, label: 'good', gaps: [], source: 'strong', action: 'next_main', missing: [], rubricCheck: judged([]) }),
    round({ ordinal: 2, gaps: ['g2'], action: 'follow_up', missing: ['r1'], target: 'r1', rubricCheck: judged(['r2']), followUpRubricCheck: judged(['r2']) }),
  ]);

  it('Host vs scripted: exact match and, per item, agreed / missed / wrongly missing', () => {
    const r = rubric.summarizeRubric([t]);
    expect(r.hostChecks).toBe(3); // the follow-up answers were not checked by the Host (engine decision)
    expect(r.hostVsScripted.n).toBe(3);
    expect(r.hostVsScripted.exact).toMatchObject({ num: 2, den: 3 });
    expect(r.hostVsScripted.perItem).toEqual({
      r1: { n: 3, agreed: 2, missed: 0, wronglyMissing: 1 },
      r2: { n: 3, agreed: 2, missed: 1, wronglyMissing: 0 },
      r3: { n: 3, agreed: 3, missed: 0, wronglyMissing: 0 },
    });
  });

  it('judge vs scripted covers every answer, including follow-up answers', () => {
    const r = rubric.summarizeRubric([t]);
    expect(r.judgedAnswers).toBe(5);
    expect(r.judgeVsScripted.n).toBe(5);
    expect(r.judgeVsScripted.exact).toMatchObject({ num: 3, den: 5 }); // A main, A follow-up: judge misses r3; B, C main, C follow-up exact
    expect(r.commonJudgeVsScripted.n).toBe(3); // the answers the Host also checked
    expect(r.commonJudgeVsScripted.exact).toMatchObject({ num: 2, den: 3 });
  });

  it('Host vs judge: the judge is the reference', () => {
    const r = rubric.summarizeRubric([t]);
    expect(r.hostVsJudge.n).toBe(3);
    expect(r.hostVsJudge.exact).toMatchObject({ num: 1, den: 3 }); // only B
    expect(r.hostVsJudge.perItem.r3).toEqual({ n: 3, agreed: 2, missed: 0, wronglyMissing: 1 }); // A: host says r3 missing, judge says shown
    expect(r.hostVsJudge.perItem.r2).toEqual({ n: 3, agreed: 2, missed: 1, wronglyMissing: 0 }); // C: judge says r2 missing, host does not
  });

  it('Host target accuracy (no judge): the target must be a gap the answer really left', () => {
    const r = rubric.summarizeRubric([t]);
    expect(r.hostTarget).toMatchObject({ followUps: 2, withGaps: 2 });
    expect(r.hostTarget.onTarget).toMatchObject({ num: 1, den: 2 }); // A targets r1 (left), C targets r1 (C left only r2)
  });

  it('target accuracy ignores follow-ups after answers that left nothing; fallbacks have no Host check', () => {
    const odd = transcript([
      round({ label: 'good', gaps: [], source: 'strong', action: 'follow_up', missing: ['r1'], target: 'r1' }),
      round({ ordinal: 1, action: 'next_main' }),
    ]);
    const r = rubric.summarizeRubric([odd]);
    expect(r.hostTarget).toMatchObject({ followUps: 1, withGaps: 0 });
    expect(r.hostTarget.onTarget.rate).toBeNull();
    expect(r.hostChecks).toBe(1);
  });

  it('is attached per arm to the summary, and shown in summary.md with the judge targeting next to it', async () => {
    const { outDir, report } = await runEval(base({ prompts: 'host.v4@0,host.v3', profiles: 'strong,vague,wrong,idk', judge: true, repeats: 2, baseline: 'fixed' }));
    expect(report.results['host.v4@0'].rubric.hostVsJudge.n).toBeGreaterThan(0);
    expect(report.results['host.v3'].rubric).toBeUndefined();
    expect(report.results.fixed.rubric).toBeUndefined();
    const md = fs.readFileSync(path.join(outDir, 'summary.md'), 'utf8');
    expect(md).toContain('## Rubric check (host.v4)');
    expect(md).toMatch(/\| host\.v4@0 \| Host vs judge \| \d+ \| \d+% \(\d+\/\d+\) \|/);
    expect(md).toMatch(/\| host\.v4@0 \| Judge vs scripted \| r1 \|/);
    expect(md).toContain('Host target is a left gap');
    expect(md).toContain('## Hint rate per profile (host.v4)');
    expect(md).not.toMatch(/\| host\.v3 \| Host vs judge/);
  });
});

describe('the files for hand labelling', () => {
  async function sampleRun() {
    return runEval(base({
      prompts: 'host.v4@0,host.v4@0.2', cases: 'case1,case2,case3,case4,case5', profiles: 'all', judge: true, repeats: 2, judgeSample: 0,
    }));
  }

  it('rubric-check-blind.csv has the six columns and no labels; rubric-check-key.csv has the answers to compare with', async () => {
    const { outDir } = await sampleRun();
    const blindText = fs.readFileSync(path.join(outDir, 'rubric-check-blind.csv'), 'utf8');
    const keyText = fs.readFileSync(path.join(outDir, 'rubric-check-key.csv'), 'utf8');
    const blind = parseCsvObjects(blindText);
    const key = parseCsvObjects(keyText);
    expect(parseCsv(blindText)[0]).toEqual(['id', 'case', 'main_question', 'rubric_items', 'student_answer', 'human_missing']);
    expect(parseCsv(keyText)[0]).toEqual(['id', 'host_arm', 'host_missing', 'judge_missing', 'scripted_gaps_left', 'host_target', 'host_follow_up', 'judge_reason']);
    expect(blind.length).toBe(40);
    expect(key.map((r) => r.id)).toEqual(blind.map((r) => r.id));
    expect(new Set(blind.map((r) => r.id)).size).toBe(40);
    blind.forEach((r) => expect(r.human_missing).toBe('')); // nothing filled in

    // nothing from the Host, the judge or the scripted answer in the blind file
    const secrets = key.flatMap((r) => [r.host_follow_up, r.judge_reason, r.host_arm]).filter((v) => v && v !== '(moved on)');
    secrets.forEach((secret) => expect(blindText).not.toContain(secret));
    expect(blindText).not.toMatch(/host\.v4|host_missing|judge_missing|scripted|gaps_left|\bg[123]\b/);
    blind.forEach((r) => expect(r.rubric_items).toMatch(/^r1: /));

    // key values are rubric id lists or "none"
    key.forEach((r) => ['host_missing', 'judge_missing', 'scripted_gaps_left'].forEach((col) => expect(r[col]).toMatch(/^(none|r\d( r\d)*)$/)));
  });

  it('is spread over cases 2 to 5 (case 1 left out) and the profiles, with strong answers included, and is the same with the same seed', async () => {
    const { outDir } = await sampleRun();
    const blind = parseCsvObjects(fs.readFileSync(path.join(outDir, 'rubric-check-blind.csv'), 'utf8'));
    const key = parseCsvObjects(fs.readFileSync(path.join(outDir, 'rubric-check-key.csv'), 'utf8'));
    const cases = blind.map((r) => r.case);
    expect(new Set(cases)).toEqual(new Set(['case2', 'case3', 'case4', 'case5']));
    ['case2', 'case3', 'case4', 'case5'].forEach((id) => expect(cases.filter((c) => c === id).length).toBeGreaterThanOrEqual(5));
    // strong answers leave nothing out (case 5 Q1 excepted): some rows have scripted_gaps_left = none
    expect(key.filter((r) => r.scripted_gaps_left === 'none').length).toBeGreaterThanOrEqual(4);
    expect(key.filter((r) => r.scripted_gaps_left !== 'none').length).toBeGreaterThanOrEqual(15);
    // every answer was checked by the Host
    key.forEach((r) => expect(r.host_missing).not.toBe(''));
    // same text is never sampled twice
    expect(new Set(blind.map((r) => `${r.case}|${r.main_question}|${r.student_answer}`)).size).toBe(blind.length);

    const again = await runEval(base({
      prompts: 'host.v4@0,host.v4@0.2', cases: 'case1,case2,case3,case4,case5', profiles: 'all', judge: true, repeats: 2, judgeSample: 0, out: path.join(tmp, 'again'),
    }));
    expect(fs.readFileSync(path.join(again.outDir, 'rubric-check-blind.csv'), 'utf8')).toBe(fs.readFileSync(path.join(outDir, 'rubric-check-blind.csv'), 'utf8'));
    expect(fs.readFileSync(path.join(again.outDir, 'rubric-check-key.csv'), 'utf8')).toBe(fs.readFileSync(path.join(outDir, 'rubric-check-key.csv'), 'utf8'));
  });

  it('a different seed gives a different sample; --rubric-sample 0 and no host.v4 arm write nothing', async () => {
    const a = await sampleRun();
    const b = await runEval(base({
      prompts: 'host.v4@0', cases: 'case2,case3,case4,case5', profiles: 'all', judge: true, seed: 7, judgeSample: 0, out: path.join(tmp, 'b'),
    }));
    expect(fs.readFileSync(path.join(b.outDir, 'rubric-check-blind.csv'), 'utf8')).not.toBe(fs.readFileSync(path.join(a.outDir, 'rubric-check-blind.csv'), 'utf8'));
    const none = await runEval(base({ judge: true, rubricSample: 0, out: path.join(tmp, 'n') }));
    expect(fs.existsSync(path.join(none.outDir, 'rubric-check-blind.csv'))).toBe(false);
    const v3 = await runEval(base({ prompts: 'host.v3', judge: true, out: path.join(tmp, 'v3') }));
    expect(fs.existsSync(path.join(v3.outDir, 'rubric-check-blind.csv'))).toBe(false);
    const noJudge = await runEval(base({ out: path.join(tmp, 'nj') }));
    expect(fs.existsSync(path.join(noJudge.outDir, 'rubric-check-blind.csv'))).toBe(false);
  });
});

describe('compare-rubric.js', () => {
  const rows = [
    { id: 'R01', caseId: 'case4', mainQuestion: 'Q1?', rubric: [{ id: 'r1', text: 'one' }, { id: 'r2', text: 'two' }, { id: 'r3', text: 'three, with a comma' }], answer: 'an "answer"\nwith a line break', hostMissing: ['r1', 'r3'], judgeMissing: ['r1'], scriptedMissing: ['r1', 'r3'], arm: 'host.v4@0', target: 'r1', followUp: 'Why?', judgeReason: 'because' },
    { id: 'R02', caseId: 'case4', mainQuestion: 'Q2?', rubric: [{ id: 'r1', text: 'one' }, { id: 'r2', text: 'two' }], answer: 'full answer', hostMissing: [], judgeMissing: [], scriptedMissing: [], arm: 'host.v4@0', target: null, followUp: null, judgeReason: 'ok' },
    { id: 'R03', caseId: 'case2', mainQuestion: 'Q3?', rubric: [{ id: 'r1', text: 'one' }, { id: 'r2', text: 'two' }], answer: 'half', hostMissing: ['r1'], judgeMissing: ['r2'], scriptedMissing: ['r2'], arm: 'host.v4@0', target: 'r1', followUp: 'What?', judgeReason: 'half' },
    { id: 'R04', caseId: 'case2', mainQuestion: 'Q4?', rubric: [{ id: 'r1', text: 'one' }, { id: 'r2', text: 'two' }], answer: 'not labelled', hostMissing: ['r1'], judgeMissing: ['r1'], scriptedMissing: ['r1'], arm: 'host.v4@0', target: 'r1', followUp: 'Hm?', judgeReason: 'x' },
  ];
  const fill = (blindText, labels) => {
    const parsed = parseCsv(blindText);
    const out = parsed.map((row, i) => (i === 0 ? row : [...row.slice(0, 5), labels[row[0]] === undefined ? '' : labels[row[0]]]));
    return toCsvText(out[0], out.slice(1));
  };
  const files = (labels) => {
    const blind = path.join(tmp, 'rubric-check-blind.csv');
    const key = path.join(tmp, 'rubric-check-key.csv');
    fs.writeFileSync(blind, fill(rubric.toBlindCsv(rows), labels));
    fs.writeFileSync(key, rubric.toKeyCsv(rows));
    return { blind, key };
  };

  it('the blind file survives quotes, commas and line breaks in a cell', () => {
    const parsed = parseCsvObjects(rubric.toBlindCsv(rows));
    expect(parsed[0].student_answer).toBe('an "answer"\nwith a line break');
    expect(parsed[0].rubric_items).toBe('r1: one | r2: two | r3: three, with a comma');
    expect(parsed[0].human_missing).toBe('');
  });

  it('reads both files and compares Host, judge and scripted with the labels: exact match and agreed / missed / wrongly missing per item', () => {
    // me: R01 = r1 r3 (Host and scripted exact, judge misses r3), R02 = none (everyone exact), R03 = r1 (Host exact; judge and scripted say r2)
    const result = rubric.compareWithHuman(fs.readFileSync(files({ R01: 'r1 r3', R02: 'none', R03: 'r1' }).blind, 'utf8'), rubric.toKeyCsv(rows));
    expect(result).toMatchObject({ rows: 4, labelled: 3, hostBlank: 0 });
    const { host, judge, scripted } = result.comparisons;
    expect(host.exact).toMatchObject({ num: 3, den: 3 });
    expect(judge.exact).toMatchObject({ num: 1, den: 3 });
    expect(scripted.exact).toMatchObject({ num: 2, den: 3 });
    expect(judge.perItem.r2).toEqual({ n: 3, agreed: 2, missed: 0, wronglyMissing: 1 }); // R03: the judge says r2 missing, I say shown
    expect(judge.perItem.r3).toEqual({ n: 1, agreed: 0, missed: 1, wronglyMissing: 0 });
    expect(judge.perItem.r1).toEqual({ n: 3, agreed: 2, missed: 1, wronglyMissing: 0 });
    expect(scripted.perItem.r2).toEqual({ n: 3, agreed: 2, missed: 0, wronglyMissing: 1 });
    expect(host.perItem.r1).toEqual({ n: 3, agreed: 3, missed: 0, wronglyMissing: 0 });
  });

  it('prints Host vs me, judge vs me and scripted vs me', () => {
    const { blind, key } = files({ R01: 'r1 r3', R02: 'none', R03: 'r1' });
    const out = compareRubric.main([blind, key]);
    expect(out).toContain('Labelled 3 of 4 answers.');
    expect(out).toMatch(/Host vs you\s+3\s+100% \(3\/3\)/);
    expect(out).toMatch(/Judge vs you\s+3\s+33% \(1\/3\)/);
    expect(out).toMatch(/Scripted vs you\s+3\s+67% \(2\/3\)/);
    expect(out).toMatch(/Host vs you\s+r1\s+3\s+3\s+0\s+0/);
    expect(out).toContain('Wrongly missing');
    // a folder works too
    expect(compareRubric.main([tmp])).toBe(out);
  });

  it('accepts commas and capitals, skips empty rows, and says what is wrong with a bad label', () => {
    expect(rubric.parseMissing('R1, r3', ['r1', 'r2', 'r3'], 'R01')).toEqual(['r1', 'r3']);
    expect(rubric.parseMissing(' None ', ['r1'], 'R01')).toEqual([]);
    expect(rubric.parseMissing('', ['r1'], 'R01')).toBeNull();
    expect(() => rubric.parseMissing('r4', ['r1', 'r2'], 'R07')).toThrow(/R07.*r4/);
    expect(() => rubric.parseMissing('maybe', ['r1', 'r2'], 'R07')).toThrow(/R07/);
    const { blind, key } = files({ R01: 'r9' });
    expect(() => compareRubric.main([blind, key])).toThrow(/R01/);
  });

  it('fails clearly with nothing filled in, a missing file, or ids that do not match', () => {
    const { blind, key } = files({});
    expect(() => compareRubric.main([blind, key])).toThrow(/human_missing/);
    expect(() => compareRubric.main([path.join(tmp, 'nope.csv'), key])).toThrow(/File not found/);
    const other = path.join(tmp, 'other-key.csv');
    fs.writeFileSync(other, rubric.toKeyCsv(rows.slice(1)));
    fs.writeFileSync(blind, fill(rubric.toBlindCsv(rows), { R01: 'none' }));
    expect(() => compareRubric.main([blind, other])).toThrow(/R01 is in the blind file but not in the key file/);
  });

  it('reads a file saved by a spreadsheet (CRLF line endings, a byte-order mark)', () => {
    const { blind, key } = files({ R01: 'r1 r3', R02: 'none' });
    const asExcel = `﻿${fs.readFileSync(blind, 'utf8').replace(/\n/g, '\r\n')}`;
    fs.writeFileSync(blind, asExcel);
    expect(compareRubric.main([blind, key])).toContain('Labelled 2 of 4 answers.');
  });

  it('a key row without a Host check is left out of the Host rows only', () => {
    const keyText = rubric.toKeyCsv(rows).replace('R02,host.v4@0,none,', 'R02,host.v4@0,,');
    const { blind } = files({ R01: 'r1 r3', R02: 'none' });
    const result = rubric.compareWithHuman(fs.readFileSync(blind, 'utf8'), keyText);
    expect(result.hostBlank).toBe(1);
    expect(result.comparisons.host.n).toBe(1);
    expect(result.comparisons.judge.n).toBe(2);
  });
});

describe('the good-enough bar', () => {
  const summary = (over = {}) => {
    const v = {
      reveals: 0.02, twoPart: 0.05, beyondScope: 0.05, hit: 0.7, chance: 0.5, unnecessary: 0.15, same: 0.9, middle: 0.6, ...over,
    };
    return {
      overall: {
        unnecessaryFollowUp: { rate: v.unnecessary },
        adaptive: {
          followUpChecks: { reveals: { rate: v.reveals }, twoPart: { rate: v.twoPart }, beyondScope: { rate: v.beyondScope } },
          gapTargeting: { partial: { hit: { rate: v.hit }, chance: { rate: v.chance } } },
          actionAgreement: { rate: v.same },
        },
      },
      ...(v.middle === undefined ? {} : { ownCode: { all: { targetsMiddle: { rate: v.middle } } } }),
    };
  };
  const fixed = (hit = 0.5) => ({ overall: { adaptive: { gapTargeting: { partial: { hit: { rate: hit } } } } } });
  const row = (over, fixedHit) => evaluateBars({ 'host.v4': summary(over), fixed: fixed(fixedHit) })[0];
  const passOf = (r, id) => r.checks.find((c) => c.id === id).pass;

  it('one row per Host arm; the fixed baseline is only the comparison', () => {
    const rows = evaluateBars({ 'host.v4@0': summary(), 'host.v4@0.2': summary(), 'host.v3@0.2': summary(), fixed: fixed() });
    expect(rows.map((r) => r.arm)).toEqual(['host.v4@0', 'host.v4@0.2', 'host.v3@0.2']);
  });

  it('every bar passes exactly at its limit; the human check is left to be filled in by hand', () => {
    const r = row({});
    expect(r.checks.map((c) => [c.id, c.pass])).toEqual([
      ['reveals', true], ['two_part', true], ['beyond_scope', true], ['targeting', true], ['skips_strong', true], ['same_action', true],
      ['case5_q1', true], ['judge_agreement', null],
    ]);
    expect(r.checks.find((c) => c.id === 'judge_agreement')).toMatchObject({ manual: true, rule: 'fill in by hand' });
    expect(r.overall).toBe('PASS');
    expect(BARS).toMatchObject({ reveals: { max: 0.02 }, twoPart: { max: 0.05 }, beyondScope: { max: 0.05 }, skipsStrong: { min: 0.85 }, sameAction: { min: 0.9 }, case5Middle: { min: 0.6 } });
  });

  it.each([
    ['reveals', { reveals: 0.03 }],
    ['two_part', { twoPart: 0.06 }],
    ['beyond_scope', { beyondScope: 0.06 }],
    ['targeting', { hit: 0.55 }], // 5 points above the fixed arm
    ['targeting', { hit: 0.7, chance: 0.6 }], // only 10 above chance
    ['skips_strong', { unnecessary: 0.16 }],
    ['same_action', { same: 0.89 }],
    ['case5_q1', { middle: 0.59 }],
  ])('fails %s', (id, over) => {
    const r = row(over);
    expect(passOf(r, id)).toBe(false);
    expect(r.overall).toBe('FAIL');
  });

  it('targeting needs 10 points above the fixed arm AND 15 above chance', () => {
    expect(passOf(row({ hit: 0.65, chance: 0.5 }, 0.55), 'targeting')).toBe(true); // +10 over the fixed arm, +15 over chance, both exactly
    expect(passOf(row({ hit: 0.6, chance: 0.4 }, 0.5), 'targeting')).toBe(true); // +10 and +20
    expect(passOf(row({ hit: 0.6, chance: 0.5 }, 0.4), 'targeting')).toBe(false); // +20 over fixed but only +10 over chance
    expect(passOf(row({ hit: 0.65, chance: 0.4 }, 0.57), 'targeting')).toBe(false); // +25 over chance but only +8 over fixed
  });

  it('a bar that cannot be measured is n/a, not a fail, and the arm is incomplete', () => {
    const r = row({ same: null, middle: undefined });
    expect(passOf(r, 'same_action')).toBeNull();
    expect(passOf(r, 'case5_q1')).toBeNull();
    expect(r.overall).toBe('incomplete');
    const noFixed = evaluateBars({ 'host.v4': summary() })[0];
    expect(passOf(noFixed, 'targeting')).toBeNull();
    expect(noFixed.checks.find((c) => c.id === 'targeting').note).toMatch(/fixed arm/);
  });

  it('is in summary.md as a table with one row per arm, PASS or FAIL in each cell', async () => {
    const { outDir } = await runEval(base({ prompts: 'host.v4@0,host.v3@0.2', baseline: 'fixed', judge: true, repeats: 2, cases: 'case2,case3,case4,case5', profiles: 'strong,vague,wrong,idk' }));
    const md = fs.readFileSync(path.join(outDir, 'summary.md'), 'utf8');
    const section = md.slice(md.indexOf('## Good-enough bar (cases 2 to 5)'), md.indexOf('## Two-question guard'));
    const rows = section.split('\n').filter((l) => /^\| host\./.test(l));
    expect(rows).toHaveLength(2);
    rows.forEach((l) => {
      expect(l).toMatch(/(PASS|FAIL)/);
      expect(l).toContain('fill in by hand');
      expect(l).toMatch(/(PASS|FAIL|incomplete) \|$/);
    });
    expect(section).toContain('Reveals the answer: 2% or fewer');
    expect(section).toContain('Case 5 Q1 follow-ups targeting g1 or g2: 60% or more');
    expect(md).toContain('## Hint rate per profile (host.v4)');
  });
});

describe('toMarkdown without a host.v4 arm', () => {
  it('has no rubric or hint section', () => {
    const t = transcript([round({ action: 'next_main' })], { promptVersion: 'host.v3', arm: 'host.v3' });
    const results = metrics.summarizeRun([t]);
    adaptive.attachAdaptive(results, [t], []);
    rubric.attachRubric(results, [t]);
    const md = toMarkdown({
      runId: 'x', options: { prompts: ['host.v3'], cases: ['case4'], profiles: ['vague'], repeats: 1, modelId: 'm' }, plan: { interviews: 1 }, results,
    });
    expect(md).not.toContain('## Rubric check (host.v4)');
    expect(md).not.toContain('## Hint rate');
    expect(md).toContain('## Good-enough bar');
  });
});
