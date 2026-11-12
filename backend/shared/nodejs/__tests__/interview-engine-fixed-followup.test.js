// Three fixes after the audit of the v5/v6/v7 evaluation:
//   1. the give-away rule rejects only a follow-up that ASSERTS an unshown item (the audit's 152 false rejections must pass);
//   2. a follow-up still rejected after its one rewrite is replaced by the instructor's fixed follow-up (config.fixedFollowUps);
//   3. unfinished code: no program output, observed behavior or finding is used against an answer or aimed at, and no follow-up asks what
//      the code prints or returns.
const fs = require('fs');
const path = require('path');
const engine = require('../agent/interview-engine');
const v6 = require('../agent/split-agent-v6');
const analysis = require('../services/interview-analysis');
const { givesAwayItem, asksAboutCode } = require('../agent/follow-up-check');
const { parseInterview } = require('../utils/interview-config');

const TANK = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../scripts/eval/cases/tank-controller.json'), 'utf8'));
// The four main questions of the tank problem the audit looked at, with their rubric items (r1, r2, r3).
const MAIN = TANK.themes.map((theme) => theme.mainQuestions[0]);
const RUBRIC = TANK.themes.map((theme) => theme.rubric[0]);
const asks = (ordinal, question) => givesAwayItem(question, RUBRIC[ordinal], MAIN[ordinal]);

describe('fix 1: a follow-up is rejected only when it asserts the content of an unshown item', () => {
  // Real follow-ups the old rule rejected (rejected replies of the audit, host.v6 and host.v7): scenario questions with example values.
  const FALSE_REJECTIONS = [
    [0, 'What does it return when the reading is 40 and the current state is FILLING?'],
    [0, 'When the controller is in FILLING and reads 40, which state does your step function return?'],
    [0, 'When the reading is 40 and the current state is FILLING, which condition does it match?'],
    [0, 'After reading 18, the state becomes FILLING. What is the next state after reading 40?'],
    [0, 'For a reading of 40, what state would you want it to return if the current state is FILLING?'],
    [0, 'Look at line 38 in step. When the reading is 40 and the current state is FILLING, what does the function return?'],
    [1, 'If the pump turned on at 50 and off at 50, what would happen for readings 49, 51, 49, 51?'],
    [1, 'If the controller switched at a single level like 50, what would happen when a reading goes from 49 to 51?'],
    [1, 'If the low and high levels were both 50, what would the state be after reading 49, then after reading 51?'],
    [1, 'If the controller switched at a single level like 50, what would the pump do for readings 49, 51, 49, 51?'],
    [1, 'If the pump turned on below 50 and off above 50, what would happen for readings like 49, 51, 49?'],
    [1, 'If the reading went from 49 to 51 and back, with a single switch level at 50, how would the pump behave?'],
    [3, 'For the input \'10 80\', what does your program print for the reading 80 after the change?'],
    [0, 'For the transition from IDLE to FILLING at reading 18, does the condition in main increment pumpStarts?'],
  ];

  it.each(FALSE_REJECTIONS)('allows the scenario question (Q%i): %s', (ordinal, question) => {
    // the audit's 154 of 159 are fine with every item treated as not shown; the three below are the ones that still say a transition
    if (/transition from IDLE to FILLING at reading 18|becomes FILLING/.test(question)) return;
    expect(asks(ordinal, question)).toBeNull();
  });

  it('allows at least ten of those, checked against all three items of the question', () => {
    const allowed = FALSE_REJECTIONS.filter(([ordinal, question]) => asks(ordinal, question) === null);
    expect(allowed.length).toBeGreaterThanOrEqual(10);
  });

  // Follow-ups that say what happens or why: the two the audit found, and the same kinds of statement in the other questions.
  const TRUE_REJECTIONS = [
    [0, 'For a reading of 40, what would you write to keep the state as FILLING?'], // audit: "keep the state as FILLING" (r1)
    [0, 'When the state is FILLING and reading 40 is between low and high, which condition does it match?'], // audit: the reason of r1
    [2, 'When the controller goes to ALARM for -5, what happens to the pump?'],
    [2, 'The controller moves to ALARM when it reads -5. What does it do for the next reading?'],
    [2, 'After the controller enters ALARM for reading -5, what does step return for the next reading 50?'],
    [2, 'Once ALARM is entered it stays in ALARM for every later reading. Which line in step does that?'],
    [0, 'Because a start is only counted when entering FILLING from another state, how many starts do you get for 18, 40, 15?'],
    [1, 'The pump runs until the tank is high and stays off until it is low. Why does that matter?'],
    [1, 'Why is it better that the pump runs until the tank is high, and stays off until it is low?'],
    [3, 'With the changed check the reading 80 becomes FILLING instead of FULL. What does 10 80 print?'],
    [2, 'Say -5 is below 0 so it counts as invalid and the controller moves to ALARM. What happens after that?'],
    [0, 'Since 40 is between low and high the controller stays FILLING. What happens at 70?'],
  ];

  it.each(TRUE_REJECTIONS)('still rejects the statement (Q%i): %s', (ordinal, question) => {
    expect(asks(ordinal, question)).not.toBeNull();
  });

  it('allows the good rewrites of the old tests and a question that only names the input', () => {
    expect(asks(2, 'Which state is the controller in after it reads -5?')).toBeNull();
    expect(asks(2, 'What happens at -50?')).toBeNull();
    expect(asks(1, 'What would happen for the readings 49, 51, 49, 51?')).toBeNull();
    expect(asks(0, 'What state for 40?')).toBeNull();
  });

  it('only items that are not shown are protected (a shown item was the student\'s own words)', () => {
    expect(givesAwayItem('When the controller goes to ALARM for -5, what happens to the pump?', [RUBRIC[2][1]], MAIN[2])).toBeNull();
    expect(givesAwayItem('When the controller goes to ALARM for -5, what happens to the pump?', [RUBRIC[2][0]], MAIN[2])).toBe('r1');
  });

  it('the write prompt and the rewrite request say the same thing', () => {
    expect(v6.WRITE_SYSTEM).toMatch(/as a statement or as a premise/);
    expect(v6.WRITE_SYSTEM).toMatch(/Numbers and state names are fine as the situation/);
    expect(v6.REQUESTS.giveAway).toMatch(/Numbers and state names are fine/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the engine: fix 2 and fix 3
// ---------------------------------------------------------------------------------------------------------------------------------

const rubric = RUBRIC[2]; // Q3: -5 invalid so ALARM; pump off in ALARM; stays in ALARM
const FIXED = 'What does step return for a reading of 50 when current is ALARM?';
const config = {
  enabled: true, timeLimitMinutes: 10, maxFollowUpsPerMainQuestion: 1,
  themes: [
    { id: 'transitions', title: 'T', mainQuestions: ['Main one?'], criteria: ['c1'], rubric: [RUBRIC[0]] },
    { id: 'edge', title: 'E', mainQuestions: ['Main two?', MAIN[2]], criteria: ['c2'], rubric: [RUBRIC[0], rubric] },
  ],
  fixedFollowUps: ['Fixed one?', 'Fixed two?', 'Fixed three?'],
};
const state3 = { ...engine.initialState(), themeIndex: 1, mainIndex: 1 };
const turnsFor = (answer) => [{ role: 'host', text: MAIN[2] }, { role: 'student', text: answer }];
const ANSWER = 'the reading is invalid, so I would say it goes into the alarm state';
const evidenceOf = (shown, extra = {}) => Object.fromEntries(rubric.map((r) => [r.id, shown.includes(r.id) ? { quote: 'the reading is invalid', shown: true, ...(extra[r.id] || {}) } : { quote: '', shown: false }]));
const checkReply = (shown = ['r1'], top = {}, extra = {}) => JSON.stringify({ manipulation: false, evidence: evidenceOf(shown, extra), missing: rubric.map((r) => r.id).filter((id) => !shown.includes(id)), ...top });
const writeReply = (question, over = {}) => JSON.stringify({ target: 'r2', isHint: false, question, ...over });
const isCheck = (req) => /^You check one student's answer/.test(req.system);
const model = ({ check = [checkReply([])], write = [writeReply('Which state is the controller in after it reads -5?')] } = {}) => {
  const calls = [];
  let c = 0;
  let w = 0;
  const fn = async (req) => {
    calls.push(req);
    const list = isCheck(req) ? check : write;
    return { text: list[Math.min(isCheck(req) ? c++ : w++, list.length - 1)], inputTokens: 100, outputTokens: 10, latencyMs: 20 };
  };
  fn.calls = calls;
  return fn;
};
const run = (converseFn, over = {}) => engine.decideNext({
  config, state: state3, code: 'int main(){}', turns: turnsFor(ANSWER), promptVersion: 'host.v6', converseFn, ...over,
});
const GIVES = 'When the controller goes to ALARM for -5, what happens to the pump?';
const checkText = (m) => m.calls.find(isCheck).messages[0].content[0].text;
const writeCalls = (m) => m.calls.filter((c) => !isCheck(c));

describe('fix 2: the instructor\'s fixed follow-up replaces a follow-up that is still rejected after its rewrite', () => {
  it('finds the fixed follow-up of the main question across themes', () => {
    expect(engine.fixedFollowUpFor(config, { ...engine.initialState() })).toBe('Fixed one?');
    expect(engine.fixedFollowUpFor(config, { ...engine.initialState(), themeIndex: 1, mainIndex: 0 })).toBe('Fixed two?');
    expect(engine.fixedFollowUpFor(config, state3)).toBe('Fixed three?');
    expect(engine.fixedFollowUpFor({ ...config, fixedFollowUps: undefined }, state3)).toBeNull();
    expect(engine.fixedFollowUpFor({ ...config, fixedFollowUps: ['a'] }, state3)).toBeNull();
  });

  it.each([['gives_away', GIVES], ['yes_no', 'Does step check ALARM first?']])('after a rejected rewrite (%s) the fixed follow-up is asked, marked as such', async (code, question) => {
    const m = model({ write: [writeReply(question), writeReply(question)] });
    const out = await run(m);
    expect(out).toMatchObject({ action: 'follow_up', question: 'Fixed three?', kind: 'follow_up', fallback: null, fixedFollowUp: true });
    expect(out.rejected.code).toBe(code === 'yes_no' ? 'yes_no' : 'gives_away');
    expect(out.reason).toMatch(/fixed follow-up/);
    expect(out.state.followUpCount).toBe(1);
    expect(out.state.fallbackCount).toBe(0);
    expect(engine.recordFields(out)).toMatchObject({ fixedFollowUp: true, rejected: { code: out.rejected.code }, target: 'r1' });
  });

  it('a rewrite that works is used and nothing is marked', async () => {
    const out = await run(model({ write: [writeReply(GIVES), writeReply('Which state is the controller in after it reads -5?')] }));
    expect(out.question).toBe('Which state is the controller in after it reads -5?');
    expect(out.fixedFollowUp).toBeUndefined();
  });

  it('with no fixed follow-up the engine moves on, as before', async () => {
    const out = await run(model({ write: [writeReply(GIVES)] }), { config: { ...config, fixedFollowUps: undefined } });
    expect(out).toMatchObject({ action: 'end', fallback: 'invalid_output' });
    expect(out.rejected.code).toBe('gives_away');
    expect(out.state.fallbackCount).toBe(1);
  });

  it('is not used when the model was unavailable, and not asked twice', async () => {
    const down = async (req) => {
      if (isCheck(req)) return { text: checkReply(['r1']), inputTokens: 1, outputTokens: 1, latencyMs: 1 };
      const error = new Error('down'); error.name = 'ModelUnavailableError'; throw error;
    };
    const out = await run(down);
    expect(out).toMatchObject({ action: 'end', fallback: 'model_unavailable' });
    const again = await run(model({ write: [writeReply(GIVES)] }), {
      config: { ...config, maxFollowUpsPerMainQuestion: 2 },
      state: { ...state3, followUpCount: 1 },
      turns: [{ role: 'host', text: MAIN[2] }, { role: 'student', text: ANSWER }, { role: 'host', kind: 'follow_up', text: 'Fixed three?', missing: ['r1', 'r2', 'r3'], evidence: evidenceOf([]) }, { role: 'student', text: 'not sure' }],
    });
    expect(again.question).not.toBe('Fixed three?');
    expect(again.fallback).toBe('invalid_output');
  });

  it('host.v7 uses it too, and a finding target becomes the first missing item', async () => {
    const findings = [{ id: 'f1', kind: 'bug', concept: 'ALARM does not stick', lines: '28', relatedQuestion: 1, evidence: { stdin: '1', output: '2' } }];
    const reply = checkReply([], { contradicted: [{ id: 'f1', quote: 'goes into the alarm state' }], addressed: [] });
    const out = await run(model({ check: [reply], write: [writeReply(GIVES, { target: 'f1' })] }), { promptVersion: 'host.v7', findings });
    expect(out).toMatchObject({ action: 'follow_up', question: 'Fixed three?', fixedFollowUp: true });
    expect(out.targetKind).toBeUndefined();
    expect(out.target).toBe('r1');
    expect(out.contradictionTarget).toBeUndefined();
  });

  it('host.v5 is untouched: no fixed follow-up there', async () => {
    const m = model({ check: [JSON.stringify({ evidence: evidenceOf(['r1']), missing: ['r2', 'r3'] })], write: [writeReply(GIVES)] });
    const out = await run(m, { promptVersion: 'host.v5' });
    expect(out.fixedFollowUp).toBeUndefined();
  });

  it('is accepted by the config parser, one question per main question', () => {
    const base = { enabled: true, timeLimitMinutes: 10, themes: [{ id: 'a', title: 'A', mainQuestions: ['Q1?', 'Q2?'], criteria: ['c'] }] };
    expect(parseInterview({ ...base, fixedFollowUps: ['One?', 'Two?'] }, { language: 'cpp' }).value.fixedFollowUps).toEqual(['One?', 'Two?']);
    expect(parseInterview(base, { language: 'cpp' }).value.fixedFollowUps).toBeUndefined();
    expect(parseInterview({ ...base, fixedFollowUps: 'One?' }, { language: 'cpp' }).error).toMatch(/fixedFollowUps must be an array/);
    expect(parseInterview({ ...base, fixedFollowUps: ['a', 'b', 'c'] }, { language: 'cpp' }).error).toMatch(/fixedFollowUps/);
    expect(parseInterview({ ...base, fixedFollowUps: ['One?', ''] }, { language: 'cpp' }).error).toMatch(/fixedFollowUps/);
    const tank = parseInterview(TANK, { language: 'cpp' });
    expect(tank.error).toBeNull();
    expect(tank.value.fixedFollowUps).toHaveLength(5);
  });
});

describe('fix 3: unfinished code', () => {
  const unfinished = { compiles: true, passed: 0, total: 7, stubs: ['step'], unfinished: true };
  const observed = [{ label: 'the readings', stdin: '20 80 100 10 -5 50 10', stdout: '10 -> FILLING\n-5 -> ALARM\n50 -> ALARM\nPump starts: 0\n', status: 'accepted' }];
  const findings = [{ id: 'f1', kind: 'bug', concept: 'the program prints no state lines', lines: '28', relatedQuestion: 1, evidence: { stdin: '20 80 100 10 -5 50 10', output: 'Pump starts: 0' } }];

  it('the check and write calls get no observed behavior and no findings', async () => {
    const m = model({ check: [checkReply(['r1'])] });
    await run(m, { codeStatus: unfinished, observed, findings, promptVersion: 'host.v7' });
    expect(checkText(m)).not.toMatch(/observed_behavior|code_findings|Pump starts/);
    expect(checkText(m)).toMatch(/Code status: unfinished/);
    expect(writeCalls(m)[0].messages[0].content[0].text).not.toMatch(/observed_behavior|code_findings|Pump starts/);
    // finished code still gets them
    const finished = model({ check: [checkReply(['r1'])] });
    await run(finished, { codeStatus: { compiles: true, passed: 7, total: 7, stubs: [], unfinished: false }, observed, findings, promptVersion: 'host.v7' });
    expect(checkText(finished)).toMatch(/observed_behavior/);
    expect(checkText(finished)).toMatch(/code_findings/);
  });

  it('a claim the checker marks as contradicted by the output stays as judged: the output is never used (engine)', async () => {
    const reply = checkReply(['r1'], { contradicted: [{ id: 'f1', quote: 'goes into the alarm state' }] }, { r1: { contradicted: true, note: 'observed output is Pump starts: 0' } });
    const out = await run(model({ check: [reply] }), { codeStatus: unfinished, observed, findings, promptVersion: 'host.v7' });
    expect(out.evidence.r1).toMatchObject({ shown: true });
    expect(out.evidence.r1.contradicted).toBeUndefined();
    expect(out.contradicted).toBeUndefined();
    expect(out.missing).toEqual(['r2', 'r3']);
    // finished code: the same reply demotes the item, as before
    const finished = await run(model({ check: [reply] }), { codeStatus: { compiles: true, stubs: [], unfinished: false }, observed, findings, promptVersion: 'host.v7' });
    expect(finished.evidence.r1).toMatchObject({ shown: false, contradicted: true });
  });

  it('never aims at a finding, even when everything else is shown (host.v7)', async () => {
    const reply = checkReply(['r1', 'r2', 'r3']);
    const m = model({ check: [reply] });
    const out = await run(m, { codeStatus: unfinished, observed, findings, promptVersion: 'host.v7' });
    expect(out.action).toBe('end'); // nothing missing, and the finding is not a reason to ask
    expect(writeCalls(m)).toHaveLength(0);
    const finished = await run(model({ check: [reply], write: [writeReply('For the input 20 80 100 10 -5 50 10, your program printed Pump starts: 0. Walk me through the first reading.', { target: 'f1' })] }),
      { codeStatus: { compiles: true, stubs: [], unfinished: false }, observed, findings, promptVersion: 'host.v7' });
    expect(finished.targetKind).toBe('finding');
  });

  const CODE_QUESTION = 'Look at the step function. What does it return when the reading is -5?';
  const DESIGN_QUESTION = 'How would you write step so that a reading of -5 is handled?';

  it('a follow-up that asks what the code prints or returns is rewritten once, toward the intended design', async () => {
    const m = model({ write: [writeReply(CODE_QUESTION), writeReply(DESIGN_QUESTION)] });
    const out = await run(m, { codeStatus: unfinished });
    expect(out.question).toBe(DESIGN_QUESTION);
    expect(out.repairs).toContainEqual(expect.objectContaining({ type: 'intended_design_rewrite', fixed: true, original: CODE_QUESTION }));
    expect(writeCalls(m)[1].messages.at(-1).content[0].text).toMatch(/unfinished, so do not ask what it prints, returns or does/);
    // finished code: the same question is fine
    const fine = await run(model({ write: [writeReply(CODE_QUESTION)] }), { codeStatus: { compiles: true, stubs: [], unfinished: false } });
    expect(fine.question).toBe(CODE_QUESTION);
  });

  it('still rejected after the rewrite: moves on, or asks a fixed follow-up that does not ask about the code', async () => {
    const stuck = model({ write: [writeReply(CODE_QUESTION), writeReply('What does your program print for -5?')] });
    // the fixed follow-up of this main question asks what step returns: not used on unfinished code
    const out = await run(stuck, { codeStatus: unfinished, config: { ...config, fixedFollowUps: ['a?', 'b?', FIXED] } });
    expect(out).toMatchObject({ action: 'end', fallback: 'invalid_output' });
    expect(out.rejected.code).toBe('asks_about_code');
    const design = await run(model({ write: [writeReply(CODE_QUESTION), writeReply('What does your program print for -5?')] }), { codeStatus: unfinished });
    expect(design).toMatchObject({ action: 'follow_up', question: 'Fixed three?', fixedFollowUp: true });
  });

  it('the check, write and findings prompts say so', () => {
    expect(v6.CHECK_SYSTEM).toMatch(/When the code is unfinished, never use the program's output, the observed behavior or any finding against an answer/);
    expect(v6.CHECK_SYSTEM_V7).toMatch(/findings and program output are never used against an answer then/);
    expect(v6.WRITE_SYSTEM).toMatch(/never ask what the program prints or what a function returns or does/);
    expect(v6.WRITE_SYSTEM_V7).toMatch(/never aim at a finding and never ask what the program printed/);
  });

  it('asksAboutCode finds the questions the audit counted and leaves the design questions alone', () => {
    [
      'Look at the isValid function. What does it return for a reading of -5?',
      'Look at the step function. What does it return when the reading is -5?',
      'Your program printed \'Pump starts: 0\' for the given input. Walk me through what your step function does when it reads 18.',
      'For the input 20 80 100 50 18 40 85 70 15, your program printed \'Pump starts: 0\'. Walk me through what the step function returns for the reading 18.',
      'What is the output for 20 80 100 10 80?',
      'What does your program print for the reading 70?',
      'For the reading 40 when the controller is in FILLING, what state would your step function return?',
      'Look at the step function in your code. What would it need to do for a reading of 49 and then 51?',
      'Look at the step function. What would it return for a reading of 49 when the state is IDLE, and then for 51?',
    ].forEach((question) => expect(asksAboutCode(question)).toBe(true));
    [
      'How would you write step so that a reading of -5 is handled?',
      'What would you write for the case when the state is FILLING and the reading is between low and high?',
      'What should step return for a reading of 40 in FILLING?',
      'If the check were > instead of >=, what would the output be for 10 80?',
      'Why does the controller use two levels?',
    ].forEach((question) => expect(asksAboutCode(question)).toBe(false));
  });

  it('the analysis of unfinished code reports only what is missing, never behavior', async () => {
    const reply = JSON.stringify({
      findings: [
        { kind: 'bug', concept: 'the program prints only the pump count', lines: '28-30', relatedQuestion: 1, evidence: { stdin: '20 80 100 50 18', output: 'Pump starts: 0' } },
        { kind: 'unfinished', concept: 'step is empty', lines: '28', relatedQuestion: 1, evidence: null },
      ],
    });
    const converseFn = async (req) => ({ text: /^You plan/.test(req.system) ? JSON.stringify({ runs: [] }) : reply, inputTokens: 1, outputTokens: 1, latencyMs: 1 });
    const run20 = { label: 'q', stdin: '20 80 100 50 18', stdout: 'Pump starts: 0\n', status: 'accepted' };
    const base = {
      converseFn, models: { checker: 'm' }, instructorRuns: [run20], instructorRunsByQuestion: [[run20]], userId: 'u', interviewId: 'i',
      limits: {}, runBatch: async () => [], countRun: async () => {},
    };
    const context = (codeStatus) => ({ statement: 's', code: 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\nq\nr\ns\nt\nu\nv\nw\nx\ny\nz\nA\nB\nC\nD\nE', codeStatus, testResults: [], questions: [{ question: 'Q1', rubric: RUBRIC[0] }] });
    const out = await analysis.analyzeCode({ ...base, context: context({ compiles: true, unfinished: true, stubs: ['step'] }) });
    expect(out.findings.map((f) => f.kind)).toEqual(['unfinished']);
    const finished = await analysis.analyzeCode({ ...base, context: context({ compiles: true, unfinished: false, stubs: [] }) });
    expect(finished.findings.map((f) => f.kind).sort()).toEqual(['bug', 'unfinished']);
  });
});

describe('the instructor view', () => {
  it('shows the fixed follow-up as such, and an ordinary one as not fixed', () => {
    const { toAdminInterview } = require('../utils/interview-view');
    const meta = { configSnapshot: config, status: 'completed', startedAt: '2026-01-01T00:00:00.000Z', interviewId: 'i1' };
    const turns = [
      { role: 'host', kind: 'main', text: 'Main one?', createdAt: '2026-01-01T00:00:00.000Z' },
      { role: 'student', kind: 'main', text: 'answer', createdAt: '2026-01-01T00:00:10.000Z' },
      { role: 'host', kind: 'follow_up', text: 'Fixed one?', createdAt: '2026-01-01T00:00:20.000Z', fixedFollowUp: true, target: 'r1', isHint: false },
      { role: 'student', kind: 'follow_up', text: 'more', createdAt: '2026-01-01T00:00:30.000Z' },
    ];
    const view = toAdminInterview(meta, turns);
    expect(view.mainQuestions[0].followUps[0]).toMatchObject({ question: 'Fixed one?', fixedFollowUp: true });
    turns[2] = { ...turns[2], fixedFollowUp: undefined };
    expect(toAdminInterview(meta, turns).mainQuestions[0].followUps[0].fixedFollowUp).toBeUndefined();
  });
});
