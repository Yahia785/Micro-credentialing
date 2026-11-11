// host.v5 and the tank-only evaluation: cases 6 to 9, the checker numbers, the list of follow-ups to read.
jest.mock('../db/interviews', () => require('../../../scripts/eval/fake-stores').interviews);
jest.mock('../db/submissions', () => require('../../../scripts/eval/fake-stores').submissions);
jest.mock('../db/milestones', () => require('../../../scripts/eval/fake-stores').milestones);
jest.mock('../utils/logger', () => require('../../../scripts/eval/fake-stores').logger);

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runEval, normalizeOptions, planOf } = require('../../../scripts/eval/run-eval');
const { loadCase } = require('../../../scripts/eval/cases');
const { buildProfile, validateStudents, RUN_PROFILES } = require('../../../scripts/eval/students');
const tank = require('../../../scripts/eval/build-tank-cases');
const followups = require('../../../scripts/eval/followups');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-v5-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); jest.restoreAllMocks(); });

const base = (over = {}) => ({
  fakeModel: true, yes: true, log: () => {}, delayMs: 0, retryDelayMs: 0,
  prompts: 'host.v5', cases: 'case4', profiles: 'strong,vague', repeats: 1,
  out: path.join(tmp, 'out'), fakeChaos: 0, noPairs: true, ...over,
});
const readDir = (dir) => fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const CASES = ['case6', 'case7', 'case8', 'case9'];
const CASE_DIR = path.join(__dirname, '../../../scripts/eval/cases');
const cppLines = (id) => fs.readFileSync(path.join(CASE_DIR, tank.VARIANTS[id].file), 'utf8').split(/\r?\n/);

describe('cases 6 to 9 are case 4 with one bug each', () => {
  const c4 = loadCase('case4');

  it.each(CASES)('%s has the statement, main questions, criteria, rubric and gaps of case 4', (id) => {
    const c = loadCase(id);
    expect(c.mains.map((m) => m.question)).toEqual(c4.mains.map((m) => m.question));
    expect(c.mains.map((m) => m.rubric)).toEqual(c4.mains.map((m) => m.rubric));
    expect(c.mains.map((m) => m.criteria)).toEqual(c4.mains.map((m) => m.criteria));
    expect(c.studentsRaw.gaps).toEqual(c4.studentsRaw.gaps);
    expect(c.config).toEqual(c4.config);
    expect(() => validateStudents(JSON.parse(JSON.stringify(c.studentsRaw)), 5, id, c.mains)).not.toThrow();
  });

  it.each(CASES)('%s differs from the reference program in one place only', (id) => {
    const ref = fs.readFileSync(path.join(CASE_DIR, 'tank-controller.cpp'), 'utf8').split(/\r?\n/);
    const lines = cppLines(id);
    const removed = ref.filter((l) => !lines.includes(l));
    const added = lines.filter((l) => !ref.includes(l));
    expect(removed.length).toBeGreaterThanOrEqual(1);
    expect(removed.length + added.length).toBeLessThanOrEqual(4);
    expect(Math.abs(ref.length - lines.length)).toBeLessThanOrEqual(3);
  });

  it('the bugs are the four that were asked for', () => {
    expect(cppLines('case6')).toContain('    if (reading > s.high) {');
    expect(cppLines('case7').join('\n')).not.toMatch(/current == TankState::ALARM/);
    expect(cppLines('case8')).toContain('    return reading >= 0 && reading < s.max;');
    expect(cppLines('case9')).toContain('        if (next == TankState::FILLING) {');
  });

  it('the files on disk are what build-tank-cases.js writes (its transcription reproduces the reference tests first)', () => {
    const files = tank.buildFiles();
    expect(Object.keys(files)).toHaveLength(8);
    for (const [name, text] of Object.entries(files)) {
      expect(fs.readFileSync(path.join(CASE_DIR, name), 'utf8')).toBe(text);
    }
  });

  it('per-case expected outputs of the seven tests come from the buggy program', () => {
    const t = (id) => Object.fromEntries(loadCase(id).tests.map((x) => [x.id, x.expected]));
    expect(loadCase('case6').tests).toHaveLength(7);
    expect(t('case6').T3).toEqual(['10 -> FILLING', '80 -> FILLING', 'Pump starts: 1']);
    expect(t('case7').T2).toEqual(['10 -> FILLING', '30 -> FILLING', '-5 -> ALARM', '50 -> ALARM', '10 -> FILLING', 'Pump starts: 2']);
    expect(t('case8').T7).toContain('100 -> ALARM');
    expect(t('case9').T1.slice(-1)).toEqual(['Pump starts: 3']);
    expect(t('case9').T2.slice(-1)).toEqual(['Pump starts: 2']);
    const passes = (id) => loadCase(id).tests.filter((x) => x.passesStatement).length;
    expect([passes('case6'), passes('case7'), passes('case8'), passes('case9')]).toEqual([5, 6, 6, 4]);
  });

  it('the simulation reproduces the reference tests of case 4', () => {
    loadCase('case4').tests.forEach((x) => expect(tank.simulate('case4', x.input)).toEqual(x.expected));
  });

  it('students answer about their OWN code only where the bug changes what they would see (ownCode): case 6 Q4, case 7 Q3, case 9 Q1; case 8 none', () => {
    const own = (id) => loadCase(id).studentsRaw.profiles.strong.map((e, i) => (e.main.ownCode && e.followUp.ownCode ? i : null)).filter((i) => i !== null);
    expect(own('case4')).toEqual([]);
    expect(own('case5')).toEqual([0]);
    expect(own('case6')).toEqual([3]);
    expect(own('case7')).toEqual([2]);
    expect(own('case8')).toEqual([]);
    expect(own('case9')).toEqual([0]);
    expect(buildProfile(loadCase('case9').studentsRaw, 'strong')[0].main.gaps).toEqual(['g3']);
    expect(buildProfile(loadCase('case7').studentsRaw, 'strong')[2].main.gaps).toEqual(['g3']);
    expect(buildProfile(loadCase('case6').studentsRaw, 'strong')[3].main.gaps).toEqual(['g2']);
    expect(loadCase('case8').studentsRaw.profiles).toEqual(loadCase('case4').studentsRaw.profiles);
  });

  it('every usual profile exists for the new cases', () => {
    for (const id of CASES) {
      RUN_PROFILES.forEach((p) => expect(buildProfile(loadCase(id).studentsRaw, p, loadCase(id).mains)).toHaveLength(5));
    }
  });
});

describe('the headline is cases 4 to 9', () => {
  it('cases 1, 2 and 3 are left out of the overall numbers and reported on their own', async () => {
    const { report } = await runEval(base({ prompts: 'host.v3', cases: 'case2,case3,case4,case6', profiles: 'vague' }));
    const r = report.results['host.v3'];
    expect(r.overall.interviews).toBe(2);
    expect(r.allCases.interviews).toBe(4);
    expect(r.headlineExcludes).toEqual(['case2', 'case3']);
    const md = fs.readFileSync(path.join(tmp, 'out', 'summary.md'), 'utf8');
    expect(md).toContain('## case2 on its own (left out of the headline numbers)');
    expect(md).toContain('## case3 on its own (left out of the headline numbers)');
    expect(md).toContain('Cases 2 and 3 are kept as a separate side check');
  });
});

describe('host.v5 in the eval', () => {
  it('runs at temperature 0 by default under its own name', () => {
    const spec = normalizeOptions(base({ prompts: 'host.v5,host.v4.1@0' })).armSpecs;
    expect(spec.map((s) => [s.arm, s.promptVersion, s.temperature])).toEqual([['host.v5', 'host.v5', 0], ['host.v4.1@0', 'host.v4.1', 0]]);
  });

  it('plans 1 call per decision at least and 2 at most for a split arm', () => {
    const loaded = { case4: loadCase('case4') };
    const one = planOf(normalizeOptions(base({ prompts: 'host.v4.1@0', profiles: 'vague' })), loaded);
    const five = planOf(normalizeOptions(base({ prompts: 'host.v5', profiles: 'vague' })), loaded);
    expect([one.minCalls, one.maxCalls]).toEqual([5, 5]);
    expect([five.minCalls, five.maxCalls]).toEqual([5, 10]);
    expect(five.splitArms).toBe(1);
    expect(five.decisionsPerArm).toBe(5);
  });

  it('a fake run stores the evidence, missing, target, both model ids and every call on the Host turns', async () => {
    const { outDir } = await runEval(base({ profiles: 'strong,vague,idk', cases: 'case4,case5' }));
    const transcripts = readDir(path.join(outDir, 'transcripts'));
    const hostTurns = transcripts.flatMap((t) => t.turns).filter((x) => x.role === 'host' && x.models);
    expect(hostTurns.length).toBeGreaterThan(0);
    hostTurns.forEach((x) => {
      expect(x.models).toEqual({ checker: 'fake-checker', writer: 'fake-writer' });
      expect(x.calls.length).toBeGreaterThanOrEqual(1);
      x.calls.forEach((c) => expect(c).toMatchObject({ step: expect.stringMatching(/check|write/), modelId: expect.any(String), inputTokens: expect.any(Number), latencyMs: expect.any(Number) }));
    });
    expect(hostTurns.some((x) => x.evidence && Object.keys(x.evidence).length >= 2)).toBe(true);
    const followUps = hostTurns.filter((x) => x.kind === 'follow_up');
    expect(followUps.length).toBeGreaterThan(0);
    followUps.forEach((x) => expect(x.missing).toContain(x.target));
    followUps.forEach((x) => expect(x.target).toBe(x.missing[0]));
    expect(transcripts[0].temperature).toBe(0);
    expect(transcripts[0].modelId).toBe('check: fake-checker, write: fake-writer');
  });

  it('summary.md has the checker table (no judge needed for it) and a list of up to 30 follow-ups to read per arm', async () => {
    const { outDir, report } = await runEval(base({ prompts: 'host.v5', baseline: 'fixed', judge: true, profiles: 'all', cases: 'case4,case5,case6', repeats: 2, out: path.join(tmp, 'judged') }));
    const md = fs.readFileSync(path.join(outDir, 'summary.md'), 'utf8');
    expect(md).toContain('## Checker of host.v5 (step A) against the scripted gaps');
    expect(md).toMatch(/\| host\.v5 \| \d+ \| \d+% \(\d+\/\d+\) \|/);
    expect(md).toContain('## Follow-ups to read');
    expect(md).toMatch(/### host\.v5 \(30 of \d+\)/);
    expect(md).not.toMatch(/### fixed/);
    const block = md.slice(md.indexOf('### host.v5'));
    expect((block.match(/\nFollow-up( \(hint\))?( aimed at r\d)?: /g) || []).length).toBe(30);
    expect(block).toMatch(/Student: /);
    expect(report.followUps['host.v5'].items).toHaveLength(30);
    expect(report.results['host.v5'].rubric.hostVsScripted.n).toBeGreaterThan(0);
  });

  it('the cost estimate prices the split arm with the split prices and counts checks and writes', async () => {
    const lines = [];
    await runEval(base({
      fakeModel: false, yes: false, prompts: 'host.v5,host.v4.1@0', baseline: 'fixed', judge: true, repeats: 2, cases: 'case4,case5,case6,case7,case8,case9',
      log: (l) => lines.push(l), confirm: async () => false, out: path.join(tmp, 'plan'), checkerModel: 'deepseek.v3.2', writerModel: 'deepseek.v3.2',
    }));
    const text = lines.join('\n');
    expect(text).toMatch(/rough cost, host\.v5 \/ v6 \/ v7 \(host\.v5\): ~\d+ calls in all \(checker deepseek\.v3\.2, writer deepseek\.v3\.2/);
    expect(text).toMatch(/rough cost, single-model arms \(host\.v4\.1@0\)/);
    expect(text).toMatch(/Host cost in total: \$\d/);
    expect(text).toContain('Cancelled. Nothing was run.');
  });

  it('refuses a checker id that is an inference profile', () => {
    expect(() => normalizeOptions(base({ fakeModel: false, checkerModel: 'us.anthropic.claude-haiku-5-5' }))).toThrow(/direct model ID/);
  });
});

describe('the follow-ups to read', () => {
  const turn = (text, over = {}) => ({ role: 'host', kind: 'follow_up', text, ...over });
  const t = (arm, n) => ({
    arm, caseId: 'case4', profile: 'vague', repeat: 1,
    turns: Array.from({ length: n }, (_, i) => [{ role: 'student', text: `answer ${i}` }, turn(`question ${i}?`, { target: 'r1' })]).flat(),
  });

  it('is at most 30 per arm, seeded, with the answer before each one; the fixed arm is left out', () => {
    const sample = followups.sampleFollowUps([t('host.v5', 40), t('fixed', 5), t('host.v3', 3)], { seed: 7 });
    expect(Object.keys(sample)).toEqual(['host.v3', 'host.v5']);
    expect(sample['host.v5'].items).toHaveLength(30);
    expect(sample['host.v5'].total).toBe(40);
    expect(sample['host.v3'].items).toHaveLength(3);
    const first = sample['host.v5'].items[0];
    expect(first.answerBefore).toBe(`answer ${first.question.match(/\d+/)[0]}`);
    expect(first.target).toBe('r1');
    expect(followups.sampleFollowUps([t('host.v5', 40)], { seed: 7 })['host.v5'].items).toEqual(sample['host.v5'].items);
    expect(followups.sampleFollowUps([t('host.v5', 40)], { seed: 8 })['host.v5'].items).not.toEqual(sample['host.v5'].items);
  });

  it('is plain text: question, target, the student answer before it', () => {
    const text = followups.followUpLines(followups.sampleFollowUps([t('host.v5', 2)])).join('\n');
    expect(text).toContain('### host.v5 (2 of 2)');
    expect(text).toMatch(/Student: answer \d\nFollow-up aimed at r1: question \d\?/);
  });
});
